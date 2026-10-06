// Daily database backup (BRD §9: "Data is hosted in India, encrypted and backed up daily").
// Uses SQLite's online backup, so it is consistent while the server keeps running. Runs
// once a day at BACKUP_HOUR_IST (default 02:00):
//   1. online backup → integrity_check on the copy (a corrupt backup is worse than none)
//   2. gzip it (a 20 MB DB is ~3 MB gzipped)
//   3. if S3_BUCKET is set, upload to S3 (ap-south-1 / Mumbai keeps the data in India) —
//      this is the copy that survives the server's disk; local copies are a convenience
//   4. keep BACKUP_KEEP_LOCAL (default 3) local copies, then run the nightly data-retention job
// Encryption at rest is the volume's / bucket's setting (SSE-S3 is requested on upload).
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { backup, DatabaseSync } = require('node:sqlite');
const { db, addAudit, DATA_DIR } = require('../db');
const { today } = require('./time');

const DIR = process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups');
const KEEP_LOCAL = Number(process.env.BACKUP_KEEP_LOCAL || process.env.BACKUP_KEEP_DAYS || 3);
const HOUR_IST = Number(process.env.BACKUP_HOUR_IST || 2);
const S3_BUCKET = process.env.S3_BUCKET || '';
const S3_PREFIX = (process.env.S3_BACKUP_PREFIX || 'backups').replace(/\/$/, '');

function list() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR).filter(f => /^tsg_workforce-.*\.sqlite(\.gz)?$/.test(f)).sort().reverse()
    .map(f => ({ file: f, bytes: fs.statSync(path.join(DIR, f)).size, at: fs.statSync(path.join(DIR, f)).mtimeMs }));
}

function s3Configured() { return !!(S3_BUCKET && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY); }

async function uploadToS3(localPath, key) {
  const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
  const client = new S3Client({ region: process.env.AWS_REGION || 'ap-south-1' });
  await client.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, Body: fs.createReadStream(localPath), ContentType: 'application/gzip', ServerSideEncryption: 'AES256' }));
  return `s3://${S3_BUCKET}/${key}`;
}

async function runBackup(by) {
  fs.mkdirSync(DIR, { recursive: true });
  const stamp = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const raw = path.join(DIR, `tsg_workforce-${stamp}.sqlite`);
  await backup(db, raw);
  // Verify the copy before trusting it.
  const check = new DatabaseSync(raw, { readOnly: true });
  const integrity = check.prepare('PRAGMA integrity_check').get();
  check.close();
  for (const side of ['-wal', '-shm']) { try { fs.unlinkSync(raw + side); } catch (e) { /* not created */ } }
  if (!integrity || integrity.integrity_check !== 'ok') { fs.unlinkSync(raw); throw new Error(`backup failed integrity_check: ${integrity && integrity.integrity_check}`); }
  const gz = raw + '.gz';
  await new Promise((resolve, reject) => fs.createReadStream(raw).pipe(zlib.createGzip({ level: 6 })).pipe(fs.createWriteStream(gz)).on('finish', resolve).on('error', reject));
  fs.unlinkSync(raw);
  let remote = null, remoteError = null;
  if (s3Configured()) {
    try { remote = await uploadToS3(gz, `${S3_PREFIX}/${path.basename(gz)}`); }
    catch (e) { remoteError = e.message; console.error('[backup] S3 upload failed:', e.message); }
  }
  // Local retention: keep the newest KEEP_LOCAL.
  for (const b of list().slice(KEEP_LOCAL)) fs.unlinkSync(path.join(DIR, b.file));
  const kb = Math.round(fs.statSync(gz).size / 1024);
  addAudit(by || 'system', 'db_backup', `${path.basename(gz)} (${kb} KB, integrity ok${remote ? `, copied to ${remote}` : remoteError ? `, S3 FAILED: ${remoteError}` : S3_BUCKET ? '' : ', no S3 configured'})`);
  return { file: path.basename(gz), dir: DIR, remote, remoteError };
}

function lastBackupDay() { const l = list(); return l.length ? new Date(l[0].at + 330 * 60000).toISOString().slice(0, 10) : null; }

function startBackupScheduler() {
  if (process.env.DISABLE_BACKUP_SCHEDULER === '1') return;
  const { runRetention, backfillThumbs } = require('./retention');
  const check = () => {
    const hour = new Date(Date.now() + 330 * 60000).getUTCHours();
    if (hour >= HOUR_IST && lastBackupDay() !== today()) {
      runBackup().then(() => runRetention()).catch(e => console.error('[backup] failed:', e.message));
    }
  };
  setInterval(check, 15 * 60000).unref();
  setTimeout(check, 30000).unref();
  // Thumbnails for rows from before thumbnails existed: a few per minute, never a burst.
  const fill = () => backfillThumbs(20).then(n => { if (n) setTimeout(fill, 5000).unref(); }).catch(() => {});
  setTimeout(fill, 15000).unref();
}

module.exports = { runBackup, list, startBackupScheduler, lastBackupDay, s3Configured, DIR };

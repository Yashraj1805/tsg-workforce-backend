// Daily database backup (BRD §9: "Data is hosted in India, encrypted and backed up daily").
// Uses SQLite's online backup, so it is consistent while the server keeps running. Runs
// once a day at BACKUP_HOUR_IST (default 02:00) and keeps BACKUP_KEEP_DAYS (default 14).
// BACKUP_DIR should point at a different disk / mounted storage in production — a backup
// on the same disk doesn't survive that disk failing. Encryption at rest is a hosting
// setting (encrypted volume), not something this file does.
const fs = require('node:fs');
const path = require('node:path');
const { backup } = require('node:sqlite');
const { db, addAudit, DATA_DIR } = require('../db');
const { today } = require('./time');

const DIR = process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups');
const KEEP_DAYS = Number(process.env.BACKUP_KEEP_DAYS || 14);
const HOUR_IST = Number(process.env.BACKUP_HOUR_IST || 2);

function list() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR).filter(f => /^tsg_workforce-.*\.sqlite$/.test(f)).sort().reverse()
    .map(f => ({ file: f, bytes: fs.statSync(path.join(DIR, f)).size, at: fs.statSync(path.join(DIR, f)).mtimeMs }));
}

async function runBackup(by) {
  fs.mkdirSync(DIR, { recursive: true });
  const stamp = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const file = path.join(DIR, `tsg_workforce-${stamp}.sqlite`);
  await backup(db, file);
  // Retention: drop backups older than KEEP_DAYS.
  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  for (const b of list()) if (b.at < cutoff) fs.unlinkSync(path.join(DIR, b.file));
  addAudit(by || 'system', 'db_backup', `${path.basename(file)} (${Math.round(fs.statSync(file).size / 1024)} KB)`);
  return { file: path.basename(file), dir: DIR };
}

function lastBackupDay() { const l = list(); return l.length ? new Date(l[0].at + 330 * 60000).toISOString().slice(0, 10) : null; }

function startBackupScheduler() {
  if (process.env.DISABLE_BACKUP_SCHEDULER === '1') return;
  const check = () => {
    const hour = new Date(Date.now() + 330 * 60000).getUTCHours();
    if (hour >= HOUR_IST && lastBackupDay() !== today()) runBackup().catch(e => console.error('[backup] failed:', e.message));
  };
  setInterval(check, 15 * 60000).unref();
  setTimeout(check, 30000).unref();
}

module.exports = { runBackup, list, startBackupScheduler, DIR };

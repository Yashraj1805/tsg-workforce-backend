// OTP generation + verification. Delivery (services/notify.js) goes out over WhatsApp
// (Meta Cloud API) or SMS for worker mobiles, and email for HR logins — each channel is
// a no-op until its own env vars are set. In dev mode we log the OTP and return it in the
// API response so the flow is fully testable end-to-end without any of that configured.
//
// BRD §10 screen 3: "Resend after 30 s. Lock for 15 min after 3 wrong tries." The lock
// lives in its own table so requesting a fresh OTP can't be used to escape it.
const crypto = require('node:crypto');
const { db } = require('../db');

const OTP_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const RESEND_AFTER_MS = 30 * 1000;
const LOCK_MS = 15 * 60 * 1000;
// OTPs are only ever echoed back / logged when DEV_BYPASS=1 is set explicitly AND the
// server is not production — a development-mode server on a public URL must not hand
// out every worker's OTP just because NODE_ENV wasn't flipped yet.
const isDev = process.env.NODE_ENV !== 'production' && process.env.DEV_BYPASS === '1';

db.exec('CREATE TABLE IF NOT EXISTS otp_locks (identifier TEXT NOT NULL, purpose TEXT NOT NULL, locked_until INTEGER NOT NULL, PRIMARY KEY (identifier, purpose))');
const cols = db.prepare('PRAGMA table_info(otp_codes)').all().map(c => c.name);
if (!cols.includes('sent_at')) db.exec('ALTER TABLE otp_codes ADD COLUMN sent_at INTEGER');

function lockedFor(identifier, purpose) {
  const l = db.prepare('SELECT locked_until FROM otp_locks WHERE identifier = ? AND purpose = ?').get(identifier, purpose);
  return l && l.locked_until > Date.now() ? Math.ceil((l.locked_until - Date.now()) / 1000) : 0;
}

// Returns { sentTo, channel, devOtp?, expiresInSeconds, resendInSeconds } or { error, retryInSeconds }.
// opts.channel = 'sms' forces SMS for a mobile (skips the WhatsApp-first attempt).
async function generateOtp(identifier, purpose, opts = {}) {
  const locked = lockedFor(identifier, purpose);
  if (locked) return { error: `Too many wrong OTPs — try again in ${Math.ceil(locked / 60)} min`, retryInSeconds: locked };
  const prev = db.prepare('SELECT sent_at FROM otp_codes WHERE identifier = ? AND purpose = ?').get(identifier, purpose);
  if (prev && prev.sent_at && Date.now() - prev.sent_at < RESEND_AFTER_MS) {
    const wait = Math.ceil((RESEND_AFTER_MS - (Date.now() - prev.sent_at)) / 1000);
    return { error: `Wait ${wait} s before asking for a new OTP`, retryInSeconds: wait };
  }
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const now = Date.now();
  db.prepare('INSERT OR REPLACE INTO otp_codes (identifier, code, purpose, expires_at, attempts, sent_at) VALUES (?,?,?,?,0,?)')
    .run(identifier, code, purpose, now + OTP_TTL_MS, now);
  const channel = await deliverOtp(identifier, purpose, code, opts.channel);
  return { sentTo: identifier, channel, devOtp: isDev ? code : undefined, expiresInSeconds: OTP_TTL_MS / 1000, resendInSeconds: RESEND_AFTER_MS / 1000 };
}

// Awaited so the response can say which channel took it. Delivery failing never fails
// the request — in dev the code is in the response anyway; in prod the worker retries.
async function deliverOtp(identifier, purpose, code, preferred) {
  try { return (await require('./notify').sendOtp(identifier, purpose, code, preferred)).channel; }
  catch (e) { console.log(`[OTP] ${purpose} OTP delivery failed for ${identifier.replace(/.(?=.{4})/g, 'x')}: ${e.message}${isDev ? ` (dev code ${code})` : ''}`); return 'none'; }
}

function verifyOtp(identifier, purpose, code) {
  const locked = lockedFor(identifier, purpose);
  if (locked) return { ok: false, error: `Too many wrong OTPs — try again in ${Math.ceil(locked / 60)} min` };
  const row = db.prepare('SELECT * FROM otp_codes WHERE identifier = ? AND purpose = ?').get(identifier, purpose);
  if (!row) return { ok: false, error: 'No OTP requested for this identifier' };
  if (Date.now() > row.expires_at) return { ok: false, error: 'OTP expired' };
  if (row.code !== code) {
    const attempts = row.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      db.prepare('DELETE FROM otp_codes WHERE identifier = ? AND purpose = ?').run(identifier, purpose);
      db.prepare('INSERT OR REPLACE INTO otp_locks (identifier, purpose, locked_until) VALUES (?,?,?)').run(identifier, purpose, Date.now() + LOCK_MS);
      return { ok: false, error: '3 wrong OTPs — locked for 15 minutes' };
    }
    db.prepare('UPDATE otp_codes SET attempts = ? WHERE identifier = ? AND purpose = ?').run(attempts, identifier, purpose);
    return { ok: false, error: `Incorrect OTP (${MAX_ATTEMPTS - attempts} ${MAX_ATTEMPTS - attempts === 1 ? 'try' : 'tries'} left)` };
  }
  db.prepare('DELETE FROM otp_codes WHERE identifier = ? AND purpose = ?').run(identifier, purpose);
  return { ok: true };
}

module.exports = { generateOtp, verifyOtp };

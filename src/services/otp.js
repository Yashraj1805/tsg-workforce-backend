// OTP generation + verification. Delivery (actually sending the SMS/email) is not
// wired up yet — that needs an SMS gateway (WATI or similar) for worker mobiles and
// an email provider for HR logins, neither of which has been sourced yet (same category
// of gap as face-match). In dev mode we log the OTP and return it in the API response
// so the flow is fully testable end-to-end without that piece.
const crypto = require('node:crypto');
const { db } = require('../db');

const OTP_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const isDev = process.env.NODE_ENV !== 'production';

function generateOtp(identifier, purpose) {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const expiresAt = Date.now() + OTP_TTL_MS;
  db.prepare('INSERT OR REPLACE INTO otp_codes (identifier, code, purpose, expires_at, attempts) VALUES (?,?,?,?,0)')
    .run(identifier, code, purpose, expiresAt);
  deliverOtp(identifier, purpose, code);
  return { sentTo: identifier, devOtp: isDev ? code : undefined, expiresInSeconds: OTP_TTL_MS / 1000 };
}

function deliverOtp(identifier, purpose, code) {
  // TODO: wire up a real SMS gateway (worker mobile) / email provider (HR) here.
  console.log(`[OTP] ${purpose} OTP for ${identifier}: ${code} (not actually sent — no SMS/email provider configured yet)`);
}

function verifyOtp(identifier, purpose, code) {
  const row = db.prepare('SELECT * FROM otp_codes WHERE identifier = ? AND purpose = ?').get(identifier, purpose);
  if (!row) return { ok: false, error: 'No OTP requested for this identifier' };
  if (Date.now() > row.expires_at) return { ok: false, error: 'OTP expired' };
  if (row.attempts >= MAX_ATTEMPTS) return { ok: false, error: 'Too many attempts — request a new OTP' };
  if (row.code !== code) {
    db.prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE identifier = ? AND purpose = ?').run(identifier, purpose);
    return { ok: false, error: 'Incorrect OTP' };
  }
  db.prepare('DELETE FROM otp_codes WHERE identifier = ? AND purpose = ?').run(identifier, purpose);
  return { ok: true };
}

module.exports = { generateOtp, verifyOtp };

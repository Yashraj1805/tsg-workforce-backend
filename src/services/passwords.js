// Admin-portal passwords. Every HR/admin user has their own password, set by a System
// Admin when the account is created (and reset by one if forgotten); the user can change
// it from their Account screen. Hashing is scrypt from node:crypto — no extra dependency,
// per-user random salt, parameters stored alongside the hash so they can be raised later.
//
// Login throttle: 5 wrong passwords in a row locks the email for 15 minutes (in memory —
// a restart clears it, which is fine for the pilot; it still stops a phone brute-forcing).
const crypto = require('node:crypto');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const MIN_LENGTH = 8;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < MIN_LENGTH) return `Password must be at least ${MIN_LENGTH} characters`;
  if (pw.length > 128) return 'Password is too long';
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) return 'Password must contain both letters and numbers';
  return null;
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(pw, stored) {
  if (typeof pw !== 'string' || !stored) return false;
  const [algo, N, r, p, saltB64, hashB64] = stored.split('$');
  if (algo !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(pw, Buffer.from(saltB64, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// A readable one-time password a System Admin can read out / WhatsApp to a new user.
function generateTempPassword() {
  const letters = 'abcdefghjkmnpqrstuvwxyz', digits = '23456789';
  const pick = (s) => s[crypto.randomInt(s.length)];
  let out = '';
  for (let i = 0; i < 6; i++) out += pick(letters);
  for (let i = 0; i < 4; i++) out += pick(digits);
  return out;
}

const fails = new Map(); // email -> { count, lockedUntil }
function lockedFor(email) {
  const f = fails.get(email.toLowerCase());
  if (!f || !f.lockedUntil) return 0;
  const left = f.lockedUntil - Date.now();
  if (left <= 0) { fails.delete(email.toLowerCase()); return 0; }
  return left;
}
function recordFailure(email) {
  const k = email.toLowerCase();
  const f = fails.get(k) || { count: 0, lockedUntil: 0 };
  f.count += 1;
  if (f.count >= MAX_FAILS) { f.lockedUntil = Date.now() + LOCK_MS; f.count = 0; }
  fails.set(k, f);
  return f.lockedUntil ? LOCK_MS : 0;
}
function clearFailures(email) { fails.delete(email.toLowerCase()); }

module.exports = { validatePassword, hashPassword, verifyPassword, generateTempPassword, lockedFor, recordFailure, clearFailures, MIN_LENGTH };

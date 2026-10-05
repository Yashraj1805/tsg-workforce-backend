const express = require('express');
const crypto = require('node:crypto');
const { db, addAudit } = require('../db');
const { generateOtp, verifyOtp } = require('../services/otp');
const { issueToken, requireAuth } = require('../middleware/auth');
const { isAdminRole, permissionsFor } = require('../rbac');
const { startSession, endSession, auditFailedLogin } = require('../services/sessions');
const { hashPassword, verifyPassword, validatePassword, lockedFor, recordFailure, clearFailures } = require('../services/passwords');

// hr_users row minus the password hash — the only shape that ever leaves the server.
function publicUser(u) { if (!u) return u; const { password_hash, ...rest } = u; return rest; }

const router = express.Router();

// ---- Worker: mobile + OTP login (BRD R03) ----
router.post('/worker/otp/request', async (req, res) => {
  const { mobile, channel } = req.body || {};
  if (!/^\d{10}$/.test(mobile || '')) return res.status(400).json({ error: 'Valid 10-digit mobile number required' });
  const result = await generateOtp(mobile, 'worker_login', { channel: channel === 'sms' ? 'sms' : undefined });
  if (result.error) return res.status(429).json(result); // resend wait / 15-min lock
  res.json(result);
});

router.post('/worker/otp/verify', (req, res) => {
  const { mobile, otp } = req.body || {};
  if (!mobile || !otp) return res.status(400).json({ error: 'mobile and otp are required' });
  const result = verifyOtp(mobile, 'worker_login', otp);
  if (!result.ok) { auditFailedLogin(mobile, 'worker', result.error); return res.status(400).json({ error: result.error }); }

  let worker = db.prepare('SELECT * FROM workers WHERE mobile = ?').get(mobile);
  let isNew = false;
  if (!worker) {
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO workers (id, mobile, status, kyc_status, created_at) VALUES (?,?,?,?,?)')
      .run(id, mobile, 'draft', 'pending', Date.now());
    worker = db.prepare('SELECT * FROM workers WHERE id = ?').get(id);
    isNew = true;
    addAudit(mobile, 'worker_first_login', 'New worker record created on first OTP login');
  }
  if (worker.blacklisted) { auditFailedLogin(mobile, 'worker', 'blacklisted'); return res.status(403).json({ error: 'This Aadhaar/mobile is blacklisted and cannot register again' }); }

  const sid = startSession('worker', worker.id, mobile, `Worker ${worker.name || '(new)'} signed in (status ${worker.status})`);
  const token = issueToken({ sub: worker.id, role: 'worker', mobile, sid }, '12h');
  res.json({ token, worker, isNew });
});

// ---- HR/admin: company email + own password (BRD R18) ----
// Every admin user has their own password. Accounts are only ever created by a System
// Admin (Users screen) — nothing is auto-provisioned at login, on any server — except the
// first System Admin, which comes from ADMIN_BOOTSTRAP_EMAILS + ADMIN_BOOTSTRAP_PASSWORD
// so there is someone who can create everyone else.
const bootstrapAdmins = (process.env.ADMIN_BOOTSTRAP_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
(function bootstrapSystemAdmins() {
  const pw = process.env.ADMIN_BOOTSTRAP_PASSWORD || '';
  for (const email of bootstrapAdmins) {
    const existing = db.prepare('SELECT * FROM hr_users WHERE lower(email) = lower(?)').get(email);
    if (existing && existing.password_hash) continue; // already set up — never overwrite a chosen password
    if (!pw) { console.warn(`[auth] ${email} is in ADMIN_BOOTSTRAP_EMAILS but ADMIN_BOOTSTRAP_PASSWORD is not set — they cannot sign in until it is`); continue; }
    const hash = hashPassword(pw);
    if (existing) {
      db.prepare('UPDATE hr_users SET password_hash = ?, must_change_password = 1, status = ? WHERE id = ?').run(hash, 'active', existing.id);
    } else {
      db.prepare('INSERT INTO hr_users (id, email, name, role, status, created_at, password_hash, must_change_password) VALUES (?,?,?,?,?,?,?,1)')
        .run(crypto.randomUUID(), email, email.split('@')[0], 'system_admin', 'active', Date.now(), hash);
    }
    addAudit('system', 'bootstrap_admin', `${email} set up as System Admin from ADMIN_BOOTSTRAP_EMAILS (temporary password — must change on first login)`);
  }
})();

router.post('/hr/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '') || typeof password !== 'string') return res.status(400).json({ error: 'email and password are required' });
  const lockLeft = lockedFor(email);
  if (lockLeft) { auditFailedLogin(email, 'admin', 'locked out'); return res.status(429).json({ error: `Too many wrong passwords — try again in ${Math.ceil(lockLeft / 60000)} min` }); }

  const hrUser = db.prepare('SELECT * FROM hr_users WHERE lower(email) = lower(?)').get(email);
  // One message for unknown email / wrong password, so the login form can't be used to
  // discover which emails have accounts.
  if (!hrUser || !hrUser.password_hash || !verifyPassword(password, hrUser.password_hash)) {
    const locked = recordFailure(email);
    auditFailedLogin(email, 'admin', !hrUser ? 'email not registered' : !hrUser.password_hash ? 'no password set' : 'wrong password');
    return res.status(401).json({ error: locked ? 'Too many wrong passwords — locked for 15 minutes' : 'Email or password is incorrect' });
  }
  if (hrUser.status !== 'active') { auditFailedLogin(email, 'admin', 'account deactivated'); return res.status(403).json({ error: 'This admin account has been deactivated' }); }
  if (!isAdminRole(hrUser.role)) return res.status(403).json({ error: `Unknown role "${hrUser.role}" — ask a System Admin to fix this account` });
  clearFailures(email);

  const sid = startSession('admin', hrUser.id, hrUser.email, `${hrUser.name} signed in as ${hrUser.role}`);
  const token = issueToken({ sub: hrUser.id, role: hrUser.role, email: hrUser.email, name: hrUser.name, sid }, '2h');
  res.json({ token, hrUser: publicUser(hrUser), permissions: permissionsFor(hrUser.role), mustChangePassword: !!hrUser.must_change_password });
});

// Signed-in admin changes their own password (also how a temporary one gets replaced).
router.post('/hr/change-password', requireAuth(), (req, res) => {
  if (!req.user) return res.status(400).json({ error: 'Admin users only' });
  const { currentPassword, newPassword } = req.body || {};
  if (!verifyPassword(currentPassword, req.user.password_hash)) { addAudit(req.user.email, 'password_change_failed', 'Current password wrong'); return res.status(401).json({ error: 'Current password is incorrect' }); }
  const bad = validatePassword(newPassword);
  if (bad) return res.status(400).json({ error: bad });
  if (newPassword === currentPassword) return res.status(400).json({ error: 'New password must be different from the current one' });
  db.prepare('UPDATE hr_users SET password_hash = ?, must_change_password = 0, password_changed_at = ? WHERE id = ?').run(hashPassword(newPassword), Date.now(), req.user.id);
  addAudit(req.user.email, 'password_changed', 'Changed own password');
  res.json({ ok: true });
});

// R17: explicit logout (worker app menu / admin account screen). Ends the server session,
// so the token is dead even if a copy of it survives on the phone.
router.post('/logout', requireAuth(), (req, res) => {
  endSession(req.auth.sid, 'logout');
  res.json({ ok: true });
});

// Current admin's role/permissions/scope, re-read from the database. The app calls this
// on start-up so a role change made by a System Admin shows up without re-login.
router.get('/me', requireAuth(), (req, res) => {
  if (!req.user) return res.status(400).json({ error: 'Workers should use GET /api/workers/me' });
  res.json({ hrUser: publicUser(req.user), permissions: permissionsFor(req.user.role), mustChangePassword: !!req.user.must_change_password });
});

module.exports = router;
module.exports.publicUser = publicUser;

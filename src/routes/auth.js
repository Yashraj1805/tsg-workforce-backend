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
// Self-signup is restricted (2026-10-15, Harpreet): with no WhatsApp/SMS gateway live
// yet, the OTP is echoed back in the API response (devOtp) rather than actually
// delivered, so a brand-new mobile number could otherwise get a login on nothing more
// than a guess. Only a mobile a Team Lead/HR already created (Add worker, or the
// manpower import) can request an OTP now - remove this block the day real OTP
// delivery (WhatsApp Cloud API or an SMS gateway) is configured, restoring open
// self-registration for genuinely new workers.
router.post('/worker/otp/request', async (req, res) => {
  const { mobile, channel } = req.body || {};
  if (!/^\d{10}$/.test(mobile || '')) return res.status(400).json({ error: 'Valid 10-digit mobile number required' });
  if (!db.prepare('SELECT 1 FROM workers WHERE mobile = ?').get(mobile)) {
    auditFailedLogin(mobile, 'worker', 'no account for this number — self-signup restricted (no OTP delivery configured yet)');
    return res.status(404).json({ error: 'This mobile number is not registered yet. Ask your Team Lead to add you first.' });
  }
  const result = await generateOtp(mobile, 'worker_login', { channel: channel === 'sms' ? 'sms' : undefined });
  if (result.error) return res.status(429).json(result); // resend wait / 15-min lock
  res.json(result);
});

router.post('/worker/otp/verify', (req, res) => {
  const { mobile, otp } = req.body || {};
  if (!mobile || !otp) return res.status(400).json({ error: 'mobile and otp are required' });
  const result = verifyOtp(mobile, 'worker_login', otp);
  if (!result.ok) { auditFailedLogin(mobile, 'worker', result.error); return res.status(400).json({ error: result.error }); }

  const worker = db.prepare('SELECT * FROM workers WHERE mobile = ?').get(mobile);
  if (!worker) { auditFailedLogin(mobile, 'worker', 'no account for this number — self-signup restricted'); return res.status(404).json({ error: 'This mobile number is not registered yet. Ask your Team Lead to add you first.' }); }
  if (worker.blacklisted) { auditFailedLogin(mobile, 'worker', 'blacklisted'); return res.status(403).json({ error: 'This Aadhaar/mobile is blacklisted and cannot register again' }); }

  const sid = startSession('worker', worker.id, mobile, `Worker ${worker.name || '(new)'} signed in (status ${worker.status})`);
  // 30 days: a 12 h token expired mid-shift and killed the punch-out (and, with it, any
  // offline punch waiting to sync). Revocation is server-side anyway (sessions table).
  const token = issueToken({ sub: worker.id, role: 'worker', mobile, sid }, '30d');
  res.json({ token, worker, isNew: false });
});

// ---- HR/admin: company email + own password (BRD R18) ----
// Every admin user has their own password. Accounts are only ever created by a System
// Admin (Users screen) — nothing is auto-provisioned at login, on any server — except the
// first System Admin, which comes from ADMIN_BOOTSTRAP_EMAILS + ADMIN_BOOTSTRAP_PASSWORD
// so there is someone who can create everyone else.
const bootstrapAdmins = (process.env.ADMIN_BOOTSTRAP_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
// A forgotten password normally gets reset by another System Admin (Users screen). The
// bootstrap account has no one above it to ask, so ADMIN_FORCE_RESET_EMAIL (comma-separated)
// names specific emails that get force-reset to ADMIN_BOOTSTRAP_PASSWORD even if they
// already have a password set — meant to be set, used once, then unset again, since it
// would otherwise clobber any password the person chooses on every future restart.
const forceResetEmails = (process.env.ADMIN_FORCE_RESET_EMAIL || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
(function bootstrapSystemAdmins() {
  const pw = process.env.ADMIN_BOOTSTRAP_PASSWORD || '';
  for (const email of bootstrapAdmins) {
    const existing = db.prepare('SELECT * FROM hr_users WHERE lower(email) = lower(?)').get(email);
    if (existing && existing.password_hash && !forceResetEmails.includes(email.toLowerCase())) continue; // already set up — never overwrite a chosen password
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

// Promotes specific accounts to Super Admin on boot (comma-separated emails). Exists
// because the Users screen's own self-role-change guard (routes/users.js) correctly
// blocks a System Admin from changing their own role - there'd otherwise be no way for
// the very first Super Admin to get that role without someone else already having it.
// Set PROMOTE_TO_SUPER_ADMIN once, confirm the account shows "Super Admin", then unset
// it again (same lifecycle as ADMIN_FORCE_RESET_EMAIL above) - it re-applies on every
// boot while set, which is harmless but pointless once the promotion has happened.
(function promoteToSuperAdmin() {
  const emails = (process.env.PROMOTE_TO_SUPER_ADMIN || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  for (const email of emails) {
    const existing = db.prepare('SELECT * FROM hr_users WHERE lower(email) = lower(?)').get(email);
    if (!existing) { console.warn(`[auth] ${email} is in PROMOTE_TO_SUPER_ADMIN but has no account yet`); continue; }
    if (existing.role === 'super_admin') continue;
    db.prepare('UPDATE hr_users SET role = ? WHERE id = ?').run('super_admin', existing.id);
    addAudit('system', 'promote_super_admin', `${email}: ${existing.role} -> super_admin (via PROMOTE_TO_SUPER_ADMIN)`);
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

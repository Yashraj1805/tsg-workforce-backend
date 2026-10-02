const express = require('express');
const crypto = require('node:crypto');
const { db, addAudit } = require('../db');
const { generateOtp, verifyOtp } = require('../services/otp');
const { issueToken, requireAuth } = require('../middleware/auth');
const { isAdminRole, permissionsFor } = require('../rbac');
const { startSession, endSession, auditFailedLogin } = require('../services/sessions');

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

// ---- HR: company email + OTP login (BRD R18) ----
router.post('/hr/otp/request', async (req, res) => {
  const { email } = req.body || {};
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '')) return res.status(400).json({ error: 'Valid email required' });
  const result = await generateOtp(email, 'hr_login');
  if (result.error) return res.status(429).json(result);
  res.json(result);
});

const isDev = process.env.NODE_ENV !== 'production';
const bootstrapAdmins = (process.env.ADMIN_BOOTSTRAP_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

router.post('/hr/otp/verify', (req, res) => {
  const { email, otp, name, devRole } = req.body || {};
  if (!email || !otp) return res.status(400).json({ error: 'email and otp are required' });
  const result = verifyOtp(email, 'hr_login', otp);
  if (!result.ok) { auditFailedLogin(email, 'admin', result.error); return res.status(400).json({ error: result.error }); }

  let hrUser = db.prepare('SELECT * FROM hr_users WHERE lower(email) = lower(?)').get(email);
  if (!hrUser) {
    // Admin users are created by a System Admin (BRD §5). Two ways an unknown email gets
    // in on its own: it's listed in ADMIN_BOOTSTRAP_EMAILS (becomes the first System
    // Admin, so someone can create everyone else), or this is a dev server, where any
    // verified email is auto-provisioned with the role picked on the login screen so
    // every role can be tested without a System Admin setting each one up.
    let role = null;
    if (bootstrapAdmins.includes(email.toLowerCase())) role = 'system_admin';
    else if (isDev) role = isAdminRole(devRole) ? devRole : 'central_hr';
    if (!role) { auditFailedLogin(email, 'admin', 'email not registered'); return res.status(403).json({ error: 'This email is not registered for the admin portal — ask a System Admin to add you' }); }

    const id = crypto.randomUUID();
    db.prepare('INSERT INTO hr_users (id, email, name, role, status, created_at) VALUES (?,?,?,?,?,?)')
      .run(id, email, name || email.split('@')[0], role, 'active', Date.now());
    hrUser = db.prepare('SELECT * FROM hr_users WHERE id = ?').get(id);
    addAudit(email, 'hr_first_login', `New admin user auto-provisioned as ${role} on first OTP login (${isDev ? 'dev mode' : 'bootstrap admin'})`);
  }
  if (hrUser.status !== 'active') { auditFailedLogin(email, 'admin', 'account deactivated'); return res.status(403).json({ error: 'This admin account has been deactivated' }); }
  if (!isAdminRole(hrUser.role)) return res.status(403).json({ error: `Unknown role "${hrUser.role}" — ask a System Admin to fix this account` });

  const sid = startSession('admin', hrUser.id, hrUser.email, `${hrUser.name} signed in as ${hrUser.role}`);
  const token = issueToken({ sub: hrUser.id, role: hrUser.role, email: hrUser.email, name: hrUser.name, sid }, '2h');
  res.json({ token, hrUser, permissions: permissionsFor(hrUser.role) });
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
  res.json({ hrUser: req.user, permissions: permissionsFor(req.user.role) });
});

module.exports = router;

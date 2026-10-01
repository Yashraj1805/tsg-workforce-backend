const express = require('express');
const crypto = require('node:crypto');
const { db, addAudit } = require('../db');
const { generateOtp, verifyOtp } = require('../services/otp');
const { issueToken } = require('../middleware/auth');

const router = express.Router();

// ---- Worker: mobile + OTP login (BRD R03) ----
router.post('/worker/otp/request', (req, res) => {
  const { mobile } = req.body || {};
  if (!/^\d{10}$/.test(mobile || '')) return res.status(400).json({ error: 'Valid 10-digit mobile number required' });
  const result = generateOtp(mobile, 'worker_login');
  res.json(result);
});

router.post('/worker/otp/verify', (req, res) => {
  const { mobile, otp } = req.body || {};
  if (!mobile || !otp) return res.status(400).json({ error: 'mobile and otp are required' });
  const result = verifyOtp(mobile, 'worker_login', otp);
  if (!result.ok) return res.status(400).json({ error: result.error });

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
  if (worker.blacklisted) return res.status(403).json({ error: 'This Aadhaar/mobile is blacklisted and cannot register again' });

  const token = issueToken({ sub: worker.id, role: 'worker', mobile }, '12h');
  res.json({ token, worker, isNew });
});

// ---- HR: company email + OTP login (BRD R18) ----
router.post('/hr/otp/request', (req, res) => {
  const { email } = req.body || {};
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '')) return res.status(400).json({ error: 'Valid email required' });
  const result = generateOtp(email, 'hr_login');
  res.json(result);
});

router.post('/hr/otp/verify', (req, res) => {
  const { email, otp, name } = req.body || {};
  if (!email || !otp) return res.status(400).json({ error: 'email and otp are required' });
  const result = verifyOtp(email, 'hr_login', otp);
  if (!result.ok) return res.status(400).json({ error: result.error });

  let hrUser = db.prepare('SELECT * FROM hr_users WHERE email = ?').get(email);
  if (!hrUser) {
    // NOTE: auto-provisioning any verified company email as HR is fine for pilot/dev
    // testing, but production should restrict this to a pre-approved allowlist before go-live.
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO hr_users (id, email, name, role, created_at) VALUES (?,?,?,?,?)')
      .run(id, email, name || email.split('@')[0], 'site_hr', Date.now());
    hrUser = db.prepare('SELECT * FROM hr_users WHERE id = ?').get(id);
    addAudit(email, 'hr_first_login', 'New HR user auto-provisioned on first OTP login (dev mode)');
  }

  const token = issueToken({ sub: hrUser.id, role: 'hr', email, name: hrUser.name, hrRole: hrUser.role }, '2h');
  res.json({ token, hrUser });
});

module.exports = router;

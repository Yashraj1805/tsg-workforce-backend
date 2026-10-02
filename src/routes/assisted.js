// BRD §7 design rule 8: "Site HR can register a worker on their own phone with the
// worker present. The worker's face and OTP confirm it. Punching is always done by the
// worker." (Proposal: "Worker with Site HR" registers in the app.)
//
// Flow: Site HR enters the worker's mobile → OTP goes to the WORKER's phone → the worker
// reads it out → HR enters it → the server issues a short-lived *assisted* worker token,
// and HR's phone runs the normal registration wizard with it (the live photo is the
// worker's face, captured there and then). That token:
//  - only exists because the worker's own OTP was entered (HR can't register alone),
//  - can never punch or bind a phone (punches.js refuses it),
//  - pins the worker to the Site HR's own location,
//  - idles out after 15 minutes like an admin session, and is fully audited, with HR
//    recorded as workers.registered_by.
const express = require('express');
const crypto = require('node:crypto');
const { db, addAudit } = require('../db');
const { generateOtp, verifyOtp } = require('../services/otp');
const { issueToken, requirePermission } = require('../middleware/auth');
const { startSession, auditFailedLogin } = require('../services/sessions');

const router = express.Router();
const PURPOSE = 'assisted_registration';

function needLocation(user) {
  if (!user.location_id) return 'Your account has no site assigned — ask a System Admin to set your location first';
  return null;
}

router.post('/otp/request', requirePermission('workers.register_assisted'), async (req, res) => {
  const { mobile } = req.body || {};
  if (!/^\d{10}$/.test(mobile || '')) return res.status(400).json({ error: 'Valid 10-digit mobile number required' });
  const noLoc = needLocation(req.user);
  if (noLoc) return res.status(400).json({ error: noLoc });
  const existing = db.prepare('SELECT status, blacklisted FROM workers WHERE mobile = ?').get(mobile);
  if (existing && existing.blacklisted) return res.status(403).json({ error: 'This mobile belongs to a blacklisted worker and cannot register again' });
  if (existing && !['draft', 'sent_back'].includes(existing.status)) return res.status(409).json({ error: `This mobile is already registered (status: ${existing.status})` });
  const result = await generateOtp(mobile, PURPOSE, { channel: req.body.channel === 'sms' ? 'sms' : undefined }); // sent to the worker's mobile, not HR's
  if (result.error) return res.status(429).json(result);
  addAudit(req.user.email, 'assisted_registration_otp', `OTP sent to worker mobile ${mobile}`);
  res.json(result);
});

router.post('/otp/verify', requirePermission('workers.register_assisted'), (req, res) => {
  const { mobile, otp } = req.body || {};
  if (!mobile || !otp) return res.status(400).json({ error: 'mobile and otp are required' });
  const noLoc = needLocation(req.user);
  if (noLoc) return res.status(400).json({ error: noLoc });
  const result = verifyOtp(mobile, PURPOSE, otp);
  if (!result.ok) { auditFailedLogin(mobile, 'worker', `assisted registration by ${req.user.email}: ${result.error}`); return res.status(400).json({ error: result.error }); }

  let w = db.prepare('SELECT * FROM workers WHERE mobile = ?').get(mobile);
  if (w && w.blacklisted) return res.status(403).json({ error: 'This mobile belongs to a blacklisted worker and cannot register again' });
  if (w && !['draft', 'sent_back'].includes(w.status)) return res.status(409).json({ error: `This mobile is already registered (status: ${w.status})` });
  if (!w) {
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO workers (id, mobile, status, kyc_status, created_at) VALUES (?,?,?,?,?)').run(id, mobile, 'draft', 'pending', Date.now());
    w = db.prepare('SELECT * FROM workers WHERE id = ?').get(id);
  }
  db.prepare('UPDATE workers SET registered_by = ?, location_id = ? WHERE id = ?').run(req.user.email, req.user.location_id, w.id);

  const sid = startSession('assisted', w.id, mobile, `Site HR ${req.user.email} started registering worker ${mobile} (worker OTP confirmed)`);
  const token = issueToken({ sub: w.id, role: 'worker', mobile, sid, assistedBy: req.user.id, assistedByEmail: req.user.email, assistedLocationId: req.user.location_id }, '2h');
  res.json({ token, worker: db.prepare('SELECT * FROM workers WHERE id = ?').get(w.id) });
});

module.exports = router;

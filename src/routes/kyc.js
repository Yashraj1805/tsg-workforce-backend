const express = require('express');
const crypto = require('node:crypto');
const { db, addAudit } = require('../db');
const { requireAuth } = require('../middleware/auth');
const setu = require('../services/setuClient');
const gemini = require('../services/geminiClient');

const router = express.Router();

// ---- Live-preview face detection (BR-02 assist): polled every couple of seconds by
// the app while the camera preview is open, so the punch selfie auto-captures once a
// face is framed instead of requiring a manual shutter tap. Deliberately separate from
// the actual identity check in compareFaces (see punches.js) — this only answers "is a
// face here," not "is it the right person." ----
router.post('/face-detect', requireAuth('worker'), async (req, res) => {
  const { frameDataUrl } = req.body || {};
  if (!frameDataUrl) return res.status(400).json({ error: 'frameDataUrl is required' });
  if (!gemini.isConfigured()) return res.status(503).json({ error: 'Gemini not configured — auto-scan unavailable' });
  const result = await gemini.detectFace(frameDataUrl);
  if (!result.ok) return res.status(502).json({ error: result.error });
  res.json({ faceDetected: result.faceDetected, reason: result.reason });
});

// ---- Aadhaar via DigiLocker (BRD FR-K06 / R05) ----
router.post('/digilocker/init', requireAuth('worker'), async (req, res) => {
  const { redirectUrl } = req.body || {};
  if (!redirectUrl) return res.status(400).json({ error: 'redirectUrl is required (where DigiLocker sends the worker back to)' });
  try {
    const result = await setu.createDigilockerRequest(redirectUrl);
    db.prepare('INSERT INTO digilocker_requests (id, worker_id, status, created_at) VALUES (?,?,?,?)')
      .run(result.id, req.auth.sub, 'unauthenticated', Date.now());
    res.json(result); // { id, status, url, validUpto } — app opens `url` for the worker to authenticate/consent
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.get('/digilocker/:id/complete', requireAuth('worker'), async (req, res) => {
  const reqRow = db.prepare('SELECT * FROM digilocker_requests WHERE id = ? AND worker_id = ?').get(req.params.id, req.auth.sub);
  if (!reqRow) return res.status(404).json({ error: 'Unknown DigiLocker request for this worker' });
  try {
    const result = await setu.fetchDigilockerAadhaar(req.params.id);
    if (result.status !== 'complete') return res.status(409).json({ error: `DigiLocker flow not complete yet (status: ${result.status})` });

    const masked = result.aadhaar.maskedNumber;
    const dup = db.prepare('SELECT id, name FROM workers WHERE aadhaar_masked = ? AND id != ? AND status != ?').get(masked, req.auth.sub, 'rejected');
    if (dup) return res.status(409).json({ error: `This Aadhaar is already registered to worker ${dup.name} (BR-09 duplicate block)` });

    db.prepare('UPDATE workers SET aadhaar_ref_id = ?, aadhaar_masked = ?, aadhaar_verified = 1 WHERE id = ?')
      .run(req.params.id, masked, req.auth.sub);
    db.prepare("UPDATE digilocker_requests SET status = 'complete' WHERE id = ?").run(req.params.id);
    addAudit(req.auth.mobile, 'aadhaar_verified', `Aadhaar verified via DigiLocker, masked ${masked}`);

    const w = db.prepare('SELECT * FROM workers WHERE id = ?').get(req.auth.sub);
    res.json({ verified: true, maskedNumber: masked, nameOnAadhaar: result.aadhaar.name, dob: result.aadhaar.dateOfBirth, gender: result.aadhaar.gender, worker: w });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ---- PAN (BRD FR-K07 / R05) ----
router.post('/pan/verify', requireAuth('worker'), async (req, res) => {
  const { pan } = req.body || {};
  if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(pan || '')) return res.status(400).json({ error: 'Enter a valid PAN, e.g. ABCDE1234F' });

  const dup = db.prepare('SELECT id, name FROM workers WHERE pan_number = ? AND id != ? AND status != ?').get(pan, req.auth.sub, 'rejected');
  if (dup) return res.status(409).json({ error: `This PAN is already registered to worker ${dup.name} (BR-09 duplicate block)` });

  try {
    const result = await setu.verifyPan(pan);
    if (result.verification !== 'success') {
      return res.status(422).json({ error: result.message || 'PAN verification failed', raw: result });
    }
    const w = db.prepare('SELECT * FROM workers WHERE id = ?').get(req.auth.sub);
    if (w.name && result.data.full_name) {
      const nameMatch = normalizeName(w.name) === normalizeName(result.data.full_name);
      if (!nameMatch) {
        return res.status(422).json({ error: `PAN name "${result.data.full_name}" does not match registered name "${w.name}" (FR-K07 requires a match)`, panName: result.data.full_name });
      }
    }
    db.prepare('UPDATE workers SET pan_number = ?, pan_verified = 1 WHERE id = ?').run(pan, req.auth.sub);
    addAudit(req.auth.mobile, 'pan_verified', `PAN verified: ${pan.slice(0, 5)}XXXX${pan.slice(-1)}`);

    const updated = db.prepare('SELECT * FROM workers WHERE id = ?').get(req.auth.sub);
    if (updated.aadhaar_verified && updated.pan_verified) {
      db.prepare("UPDATE workers SET kyc_status = 'verified' WHERE id = ?").run(req.auth.sub);
    }
    res.json({ verified: true, fullName: result.data.full_name, worker: db.prepare('SELECT * FROM workers WHERE id = ?').get(req.auth.sub) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

function normalizeName(s) { return (s || '').trim().toLowerCase().replace(/\s+/g, ' '); }

function setuConfigured() {
  return !!(process.env.SETU_CLIENT_ID && process.env.SETU_CLIENT_SECRET && process.env.SETU_PRODUCT_INSTANCE_ID);
}

// ---- Dev-only bypass, for testing the rest of the app before Setu credentials exist.
// Self-disables the moment real credentials are set — once Setu is configured, real
// verification is required and this always returns 403. Remove this route entirely
// before any real deployment; it should never ship reachable in production. ----
router.post('/skip-dev', requireAuth('worker'), (req, res) => {
  if (setuConfigured()) {
    return res.status(403).json({ error: 'Setu credentials are configured — real Aadhaar/PAN verification is required now, skip is disabled.' });
  }
  db.prepare(`UPDATE workers SET
      aadhaar_verified = 1, aadhaar_masked = COALESCE(aadhaar_masked, 'XXXX-XXXX-DEV0'),
      pan_number = COALESCE(pan_number, 'DEVSKIP000X'), pan_verified = 1, kyc_status = 'verified'
    WHERE id = ?`).run(req.auth.sub);
  addAudit(req.auth.mobile, 'kyc_dev_skip', 'Aadhaar + PAN verification skipped — dev mode, no Setu credentials configured yet');
  res.json({ worker: db.prepare('SELECT * FROM workers WHERE id = ?').get(req.auth.sub) });
});

module.exports = router;

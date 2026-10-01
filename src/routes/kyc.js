const express = require('express');
const crypto = require('node:crypto');
const { db, addAudit } = require('../db');
const { requireAuth } = require('../middleware/auth');
const setu = require('../services/setuClient');
const gemini = require('../services/geminiClient');
const { parseAadhaarQr, aadhaarKey } = require('../services/aadhaarQr');

const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/;

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
    const last4 = String(masked || '').replace(/\D/g, '').slice(-4);
    const key = aadhaarKey(last4, result.aadhaar.dateOfBirth);
    const me = db.prepare('SELECT * FROM workers WHERE id = ?').get(req.auth.sub);
    // The card the worker scanned (R04) must be the same Aadhaar they just proved they
    // own through DigiLocker's OTP — otherwise someone could scan another person's card.
    if (me.aadhaar_key && key && me.aadhaar_key !== key) {
      addAudit(req.auth.mobile, 'aadhaar_mismatch', `DigiLocker Aadhaar (…${last4}) differs from scanned QR`);
      return res.status(409).json({ error: 'The Aadhaar verified in DigiLocker is not the same card that was scanned — scan your own Aadhaar card again' });
    }
    // Duplicate block on last-4 + DOB (last-4 alone collides between different people).
    const dup = key && db.prepare('SELECT id, name FROM workers WHERE aadhaar_key = ? AND id != ? AND status != ?').get(key, req.auth.sub, 'rejected');
    if (dup) return res.status(409).json({ error: `This Aadhaar is already registered to worker ${dup.name} (BR-09 duplicate block)` });

    db.prepare('UPDATE workers SET aadhaar_ref_id = ?, aadhaar_masked = ?, aadhaar_key = COALESCE(?, aadhaar_key), aadhaar_name = ?, aadhaar_verified = 1 WHERE id = ?')
      .run(req.params.id, masked, key, result.aadhaar.name || null, req.auth.sub);
    db.prepare("UPDATE digilocker_requests SET status = 'complete' WHERE id = ?").run(req.params.id);
    addAudit(req.auth.mobile, 'aadhaar_verified', `Aadhaar verified via DigiLocker, masked ${masked}`);

    const w = db.prepare('SELECT * FROM workers WHERE id = ?').get(req.auth.sub);
    res.json({ verified: true, maskedNumber: masked, nameOnAadhaar: result.aadhaar.name, dob: result.aadhaar.dateOfBirth, gender: result.aadhaar.gender, worker: w });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ---- Aadhaar QR captured by camera (BRD R04, design rule 4) ----
// The app scans the QR on the card and sends its raw text. Decoded here (never on the
// phone), only last-4/name/DOB/gender are kept, and empty profile fields are filled in
// so the worker doesn't have to type them. Not proof of identity on its own — the
// DigiLocker step (Aadhaar OTP, through the API) is still what sets aadhaar_verified,
// and it must match this card.
router.post('/aadhaar-qr', requireAuth('worker'), (req, res) => {
  const { qrText } = req.body || {};
  if (!qrText) return res.status(400).json({ error: 'qrText is required' });
  let qr;
  try { qr = parseAadhaarQr(qrText); } catch (e) { return res.status(422).json({ error: e.message }); }
  if (qr.signature === 'invalid') {
    addAudit(req.auth.mobile, 'aadhaar_qr_forged', 'Aadhaar QR signature did not verify against the UIDAI certificate');
    return res.status(422).json({ error: 'This Aadhaar QR failed UIDAI signature check — it may be edited or fake' });
  }
  const key = aadhaarKey(qr.last4, qr.dob);
  const w = db.prepare('SELECT * FROM workers WHERE id = ?').get(req.auth.sub);
  if (w.aadhaar_verified && w.aadhaar_key && key && w.aadhaar_key !== key) {
    return res.status(409).json({ error: 'A different Aadhaar is already verified on this registration' });
  }
  const dup = key && db.prepare('SELECT id, name FROM workers WHERE aadhaar_key = ? AND id != ? AND status != ?').get(key, w.id, 'rejected');
  if (dup) return res.status(409).json({ error: `This Aadhaar is already registered to worker ${dup.name} (BR-09 duplicate block)` });

  db.prepare(`UPDATE workers SET
      aadhaar_masked = COALESCE(aadhaar_masked, ?), aadhaar_key = ?, aadhaar_name = ?, aadhaar_qr_format = ?, aadhaar_qr_signature = ?, aadhaar_qr_at = ?,
      name = COALESCE(NULLIF(name, ''), ?), dob = COALESCE(NULLIF(dob, ''), ?), gender = COALESCE(NULLIF(gender, ''), ?)
    WHERE id = ?`)
    .run(`XXXX-XXXX-${qr.last4}`, key, qr.name || null, qr.format, qr.signature, Date.now(), qr.name || null, qr.dob || null, qr.gender || null, w.id);
  addAudit(req.auth.mobile, 'aadhaar_qr_scanned', `Aadhaar QR (${qr.format}, signature ${qr.signature}) …${qr.last4}`);
  res.json({ last4: qr.last4, name: qr.name, dob: qr.dob, gender: qr.gender, format: qr.format, signature: qr.signature,
    worker: db.prepare('SELECT * FROM workers WHERE id = ?').get(w.id) });
});

// ---- PAN card photo, number read by OCR (BRD R04) ----
router.post('/pan/photo', requireAuth('worker'), async (req, res) => {
  const { photoDataUrl } = req.body || {};
  if (!photoDataUrl) return res.status(400).json({ error: 'photoDataUrl is required' });
  if (!gemini.isConfigured()) return res.status(503).json({ error: 'PAN reading is not available (GEMINI_API_KEY not set) — enter the PAN number instead', manualEntry: true });
  const r = await gemini.readPanCard(photoDataUrl);
  if (!r.ok) return res.status(502).json({ error: `Could not read the PAN card: ${r.error}`, manualEntry: true });
  const pan = (r.panNumber || '').toUpperCase().replace(/\s/g, '');
  if (!r.isPanCard) return res.status(422).json({ error: 'That doesn\'t look like a PAN card — take a clear photo of the front of the PAN card' });
  if (!PAN_RE.test(pan)) return res.status(422).json({ error: 'Could not read the PAN number clearly — retake the photo in good light, card flat and filling the frame' });
  db.prepare('UPDATE workers SET pan_photo_data_url = ?, pan_ocr_number = ?, pan_ocr_name = ? WHERE id = ?')
    .run(photoDataUrl, pan, r.nameOnCard || null, req.auth.sub);
  addAudit(req.auth.mobile, 'pan_photo_read', `PAN read from photo: ${pan.slice(0, 5)}XXXX${pan.slice(-1)} (confidence ${r.confidence})`);
  res.json({ panNumber: pan, nameOnCard: r.nameOnCard, confidence: r.confidence });
});

// ---- PAN (BRD FR-K07 / R05) ----
// Verifies the number read from the PAN photo; a typed `pan` is only the fallback for
// when the photo can't be read (no Gemini key / OCR failure).
router.post('/pan/verify', requireAuth('worker'), async (req, res) => {
  const me = db.prepare('SELECT pan_ocr_number FROM workers WHERE id = ?').get(req.auth.sub);
  const pan = ((req.body || {}).pan || me.pan_ocr_number || '').toUpperCase();
  if (!PAN_RE.test(pan)) return res.status(400).json({ error: 'Take a photo of the PAN card first (or enter a valid PAN, e.g. ABCDE1234F)' });

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

const setuConfigured = setu.isConfigured;

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

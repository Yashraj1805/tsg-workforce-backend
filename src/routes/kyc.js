const express = require('express');
const crypto = require('node:crypto');
const { db, addAudit } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const setu = require('../services/kycProvider'); // Meon (live) or Setu, same interface
const gemini = require('../services/geminiClient');
const { parseAadhaarQr, aadhaarKey, careOfName } = require('../services/aadhaarQr');
const { namesMatch } = require('../services/nameMatch');
const { checkDocument } = require('../services/identityChecks');
const { checkImages } = require('../services/images');
const { makeThumb } = require('../services/thumbs');

// DPDP: no identity document is read or sent to a verification provider before the
// worker has accepted the consent text (wizard step 1). Any accepted version counts
// here; the exact current version is enforced at submit (routes/workers.js).
function requireConsent(req, res, next) {
  const w = db.prepare('SELECT consent_version FROM workers WHERE id = ?').get(req.auth.sub);
  if (!w) return res.status(404).json({ error: 'Worker not found' });
  if (!w.consent_version) return res.status(400).json({ error: 'Read and accept the consent first', consentRequired: true });
  next();
}
const { decodeQrFromDataUrl } = require('../services/qrImage');

const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/;

// Blacklist and duplicate hits are both audited — a blacklisted person trying to
// re-register is exactly what Security/HR need to see.
function refuse(res, req, hit) {
  addAudit(req.auth.mobile, hit.kind === 'blacklisted' ? 'blacklist_hit' : 'duplicate_blocked', hit.audit);
  return res.status(hit.status).json({ error: hit.error, blocked: hit.kind });
}

const router = express.Router();

// ---- Live-preview face detection (BR-02 assist): polled every couple of seconds by
// the app while the camera preview is open, so the punch selfie auto-captures once a
// face is framed instead of requiring a manual shutter tap. Deliberately separate from
// the actual identity check in compareFaces (see punches.js) — this only answers "is a
// face here," not "is it the right person." ----
router.post('/face-detect', requireAuth('worker'), async (req, res) => {
  const { frameDataUrl } = req.body || {};
  if (!frameDataUrl) return res.status(400).json({ error: 'frameDataUrl is required' });
  const bad = checkImages(req.body, { frameDataUrl: 'frame' }); if (bad) return res.status(bad.status).json({ error: bad.error });
  if (!gemini.isConfigured()) return res.status(503).json({ error: 'Gemini not configured — auto-scan unavailable' });
  const result = await gemini.detectFace(frameDataUrl);
  if (!result.ok) return res.status(502).json({ error: result.error });
  res.json({ faceDetected: result.faceDetected, reason: result.reason });
});

// ---- Aadhaar via DigiLocker (BRD FR-K06 / R05) ----
// Where DigiLocker/Meon sends the worker after consent: a plain page on this server that
// tells them to go back to the app (the app then calls /complete with the request id).
router.get('/digilocker/return', (req, res) => {
  res.type('html').send(`<!doctype html><html lang="hi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TSG Workforce</title>
<style>body{font-family:system-ui,sans-serif;background:#f3f4fc;color:#15172e;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
.c{background:#fff;border-radius:20px;padding:28px 22px;max-width:420px;text-align:center;box-shadow:0 10px 30px rgba(23,27,80,.1)}.ok{font-size:56px;color:#19a974}.hi{font-size:22px;font-weight:800;margin:8px 0}.en{color:#666c9c}</style></head>
<body><div class="c"><div class="ok">&#10003;</div><div class="hi">DigiLocker में सत्यापन पूरा हुआ</div><div class="en">Verification done in DigiLocker.</div>
<p class="hi" style="font-size:17px">अब <b>TSG Workforce</b> ऐप पर वापस जाएँ और <b>"I've completed verification"</b> दबाएँ।</p><p class="en">Go back to the TSG Workforce app and tap "I've completed verification".</p></div></body></html>`);
});

router.post('/digilocker/init', requireAuth('worker'), requireConsent, async (req, res) => {
  // The app may pass its own redirectUrl; by default the worker lands on /digilocker/return above.
  const redirectUrl = (req.body || {}).redirectUrl || `${req.protocol}://${req.get('host')}/api/kyc/digilocker/return`;
  try {
    const result = await setu.createDigilockerRequest(redirectUrl, 'aadhaar,pan');
    db.prepare('INSERT INTO digilocker_requests (id, worker_id, status, created_at, client_token, provider) VALUES (?,?,?,?,?,?)')
      .run(result.id, req.auth.sub, 'unauthenticated', Date.now(), result.clientToken || null, result.provider);
    addAudit(req.auth.mobile, 'digilocker_started', `DigiLocker request ${result.id.slice(0, 8)}… via ${result.provider}`);
    res.json({ id: result.id, url: result.url, provider: result.provider }); // app opens `url` for the worker to authenticate/consent
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.get('/digilocker/:id/complete', requireAuth('worker'), async (req, res) => {
  const reqRow = db.prepare('SELECT * FROM digilocker_requests WHERE id = ? AND worker_id = ?').get(req.params.id, req.auth.sub);
  if (!reqRow) return res.status(404).json({ error: 'Unknown DigiLocker request for this worker' });
  try {
    const result = await setu.fetchDigilocker(reqRow);
    if (result.status !== 'complete') return res.status(409).json({ error: 'DigiLocker verification is not finished yet - complete it in the browser, then tap again', pending: true });

    // 2026-10-15: seen live with masked/photo/address all empty while status still came
    // back 'complete' - the provider's field names for this response apparently don't
    // all match what meonClient.js expects. Logging the raw shape here (never the
    // worker's own PII beyond what's already in this request) so the next real
    // completion shows exactly what to fix, and failing loudly instead of silently
    // marking a worker verified with no real Aadhaar data behind it.
    if (!result.aadhaar.maskedNumber) {
      console.error('[kyc] DigiLocker complete() but no Aadhaar number extracted — raw response:', JSON.stringify(result.raw || result).slice(0, 2000));
      return res.status(502).json({ error: 'DigiLocker returned incomplete data — try again, or ask HR to check the server log if this keeps happening' });
    }
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
    // R05: the name on the verified Aadhaar must match the registration name.
    if (me.name && result.aadhaar.name && !namesMatch(me.name, result.aadhaar.name)) {
      addAudit(req.auth.mobile, 'aadhaar_name_mismatch', `Aadhaar name "${result.aadhaar.name}" vs registered "${me.name}"`);
      return res.status(422).json({ error: `Aadhaar name "${result.aadhaar.name}" does not match registered name "${me.name}" (R05) — correct your name to match Aadhaar`, aadhaarName: result.aadhaar.name });
    }
    // Blacklist / duplicate on last-4 + DOB (last-4 alone collides between different people).
    const hit = checkDocument('aadhaar_key', key, req.auth.sub);
    if (hit) return refuse(res, req, hit);

    // DigiLocker-issued Aadhaar fills whatever the QR scan did not (name/DOB/gender/father/address).
    db.prepare(`UPDATE workers SET aadhaar_ref_id = ?, aadhaar_masked = ?, aadhaar_key = COALESCE(?, aadhaar_key), aadhaar_name = ?, aadhaar_verified = 1,
        name = COALESCE(NULLIF(name, ''), ?), dob = COALESCE(NULLIF(dob, ''), ?), gender = COALESCE(NULLIF(gender, ''), ?),
        father_name = COALESCE(NULLIF(father_name, ''), ?), address = COALESCE(NULLIF(address, ''), ?), aadhaar_photo_url = COALESCE(?, aadhaar_photo_url) WHERE id = ?`)
      .run(req.params.id, masked, key, result.aadhaar.name || null, result.aadhaar.name || null, result.aadhaar.dateOfBirth || null,
        result.aadhaar.gender ? result.aadhaar.gender.toLowerCase() : null, result.aadhaar.fatherName || null, result.aadhaar.address || null, result.aadhaar.photoUrl || null, req.auth.sub);
    db.prepare("UPDATE digilocker_requests SET status = 'complete' WHERE id = ?").run(req.params.id);
    addAudit(req.auth.mobile, 'aadhaar_verified', `Aadhaar verified via DigiLocker (${reqRow.provider || 'setu'}), masked ${masked}`);

    // Bulk-import cross-check: HR may have entered the last 4 Aadhaar digits from the
    // worker's paperwork at import time. A mismatch against what DigiLocker just verified
    // doesn't block the worker (could just be an HR typo) - flagged for HR to resolve
    // before approving instead (see workers.js POST /:id/approve).
    if (me.expected_aadhaar_last4 && me.expected_aadhaar_last4 !== last4) {
      db.prepare('UPDATE workers SET aadhaar_last4_mismatch = 1 WHERE id = ?').run(req.auth.sub);
      addAudit(req.auth.mobile, 'aadhaar_last4_mismatch', `DigiLocker-verified Aadhaar ends ${last4}, but HR entered ${me.expected_aadhaar_last4} at bulk import — needs HR review before approval`);
    }

    // 2026-10-15 (Harpreet): there's no separate live-selfie step anymore — the Aadhaar
    // photo IS the worker's photo everywhere (HR screens, gate-check, duplicate-face
    // detection, punch-in match). COALESCE so a photo from some other path is never
    // overwritten.
    if (result.aadhaar.photoUrl) {
      const thumb = await makeThumb(result.aadhaar.photoUrl).catch(() => null);
      db.prepare('UPDATE workers SET photo_data_url = COALESCE(photo_data_url, ?), photo_thumb = COALESCE(photo_thumb, ?) WHERE id = ?')
        .run(result.aadhaar.photoUrl, thumb || 'none', req.auth.sub);
    }

    // PAN from the same DigiLocker consent (Meon returns it alongside Aadhaar). A full,
    // unmasked number is verified on the spot - subject to the same blacklist/duplicate
    // and name-match rules as the standalone PAN step.
    let panNote = null;
    const pan = result.pan;
    if (pan && pan.number && PAN_RE.test(pan.number) && !pan.masked) {
      const panHit = checkDocument('pan_number', pan.number, req.auth.sub);
      if (panHit) return refuse(res, req, panHit);
      const nm = result.aadhaar.name;
      if (pan.name && nm && !namesMatch(nm, pan.name)) {
        panNote = `PAN name "${pan.name}" differs from Aadhaar name "${nm}"`;
        addAudit(req.auth.mobile, 'pan_name_mismatch', panNote);
      } else {
        db.prepare('UPDATE workers SET pan_number = ?, pan_name = ?, pan_verified = 1 WHERE id = ?').run(pan.number, pan.name || nm || null, req.auth.sub);
        addAudit(req.auth.mobile, 'pan_verified', `PAN verified via DigiLocker: ${pan.number.slice(0, 5)}XXXX${pan.number.slice(-1)}`);
        panNote = 'verified';
      }
    } else if (pan && (pan.number || pan.name)) {
      // Masked number only: remember the name so the PAN-photo step can cross-check.
      db.prepare('UPDATE workers SET pan_name = COALESCE(pan_name, ?) WHERE id = ?').run(pan.name || null, req.auth.sub);
      panNote = 'masked';
    }
    const after = db.prepare('SELECT * FROM workers WHERE id = ?').get(req.auth.sub);
    if (after.aadhaar_verified && after.pan_verified) db.prepare("UPDATE workers SET kyc_status = 'verified' WHERE id = ?").run(req.auth.sub);

    const w = db.prepare('SELECT * FROM workers WHERE id = ?').get(req.auth.sub);
    res.json({ verified: true, maskedNumber: masked, nameOnAadhaar: result.aadhaar.name, dob: result.aadhaar.dateOfBirth, gender: result.aadhaar.gender, pan: panNote, worker: w });
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
router.post('/aadhaar-qr', requireAuth('worker'), requireConsent, (req, res) => {
  const { qrText } = req.body || {};
  if (!qrText) return res.status(400).json({ error: 'qrText is required' });
  if (typeof qrText !== 'string' || qrText.length > 12000) return res.status(400).json({ error: 'That is not an Aadhaar QR' });
  return acceptAadhaarQr(req, res, qrText);
});

// Fallback when the live scanner can't read the dense Secure QR (and ML Kit on the phone
// couldn't read the photo either): decode the QR from a still photo here.
router.post('/aadhaar-qr-image', requireAuth('worker'), requireConsent, (req, res) => {
  const { photoDataUrl } = req.body || {};
  if (!photoDataUrl) return res.status(400).json({ error: 'photoDataUrl is required' });
  const bad = checkImages(req.body, { photoDataUrl: 'document' }); if (bad) return res.status(bad.status).json({ error: bad.error });
  let text;
  try { text = decodeQrFromDataUrl(photoDataUrl); } catch (e) { return res.status(400).json({ error: e.message }); }
  if (!text) return res.status(422).json({ error: 'Could not read the QR in the photo — hold the phone closer so the QR fills most of the photo, in good light, without glare' });
  return acceptAadhaarQr(req, res, text);
});

function acceptAadhaarQr(req, res, qrText) {
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
  const hit = checkDocument('aadhaar_key', key, w.id);
  if (hit) return refuse(res, req, hit);

  db.prepare(`UPDATE workers SET
      aadhaar_masked = COALESCE(aadhaar_masked, ?), aadhaar_key = ?, aadhaar_name = ?, aadhaar_qr_format = ?, aadhaar_qr_signature = ?, aadhaar_qr_at = ?,
      name = COALESCE(NULLIF(name, ''), ?), dob = COALESCE(NULLIF(dob, ''), ?), gender = COALESCE(NULLIF(gender, ''), ?),
      father_name = COALESCE(NULLIF(father_name, ''), ?), address = COALESCE(NULLIF(address, ''), ?)
    WHERE id = ?`)
    .run(`XXXX-XXXX-${qr.last4}`, key, qr.name || null, qr.format, qr.signature, Date.now(), qr.name || null, qr.dob || null, qr.gender || null,
      careOfName(qr.careOf) || null, qr.address || null, w.id);
  addAudit(req.auth.mobile, 'aadhaar_qr_scanned', `Aadhaar QR (${qr.format}, signature ${qr.signature}) …${qr.last4}`);
  // Not blocking here — the worker may simply have typed their name differently first;
  // the app shows the warning, and submit refuses until the names agree (R05).
  const nameMatches = !w.name || !qr.name || namesMatch(w.name, qr.name);
  res.json({ last4: qr.last4, name: qr.name, dob: qr.dob, gender: qr.gender, format: qr.format, signature: qr.signature, nameMatches,
    worker: db.prepare('SELECT * FROM workers WHERE id = ?').get(w.id) });
}

// ---- PAN card photo, number read by OCR (BRD R04) ----
router.post('/pan/photo', requireAuth('worker'), requireConsent, async (req, res) => {
  const { photoDataUrl } = req.body || {};
  if (!photoDataUrl) return res.status(400).json({ error: 'photoDataUrl is required' });
  const bad = checkImages(req.body, { photoDataUrl: 'document' }); if (bad) return res.status(bad.status).json({ error: bad.error });
  if (!gemini.isConfigured()) return res.status(503).json({ error: 'PAN reading is not available (GEMINI_API_KEY not set) — enter the PAN number instead', manualEntry: true });
  const r = await gemini.readPanCard(photoDataUrl);
  if (!r.ok) return res.status(502).json({ error: `Could not read the PAN card: ${r.error}`, manualEntry: true });
  const pan = (r.panNumber || '').toUpperCase().replace(/\s/g, '');
  if (!r.isPanCard) return res.status(422).json({ error: 'That doesn\'t look like a PAN card — take a clear photo of the front of the PAN card' });
  if (!PAN_RE.test(pan)) return res.status(422).json({ error: 'Could not read the PAN number clearly — retake the photo in good light, card flat and filling the frame' });
  const tamperNote = r.tamperSuspected ? (r.tamperNote || 'possible digital editing detected') : null;
  db.prepare('UPDATE workers SET pan_photo_data_url = ?, pan_ocr_number = ?, pan_ocr_name = ?, pan_tamper_note = ? WHERE id = ?')
    .run(photoDataUrl, pan, r.nameOnCard || null, tamperNote, req.auth.sub);
  addAudit(req.auth.mobile, 'pan_photo_read', `PAN read from photo: ${pan.slice(0, 5)}XXXX${pan.slice(-1)} (confidence ${r.confidence})${tamperNote ? ` — TAMPER FLAG: ${tamperNote}` : ''}`);
  res.json({ panNumber: pan, nameOnCard: r.nameOnCard, confidence: r.confidence, tamperSuspected: !!r.tamperSuspected });
});

// ---- PAN (BRD FR-K07 / R05) ----
// Verifies the number read from the PAN photo; a typed `pan` is only the fallback for
// when the photo can't be read (no Gemini key / OCR failure).
router.post('/pan/verify', requireAuth('worker'), requireConsent, async (req, res) => {
  const me = db.prepare('SELECT pan_ocr_number FROM workers WHERE id = ?').get(req.auth.sub);
  const pan = ((req.body || {}).pan || me.pan_ocr_number || '').toUpperCase();
  if (!PAN_RE.test(pan)) return res.status(400).json({ error: 'Take a photo of the PAN card first (or enter a valid PAN, e.g. ABCDE1234F)' });

  const hit = checkDocument('pan_number', pan, req.auth.sub);
  if (hit) return refuse(res, req, hit);

  // Already verified through DigiLocker (Meon returns PAN with Aadhaar): the card the
  // worker photographed must be that same PAN.
  const already = db.prepare('SELECT pan_number, pan_name, pan_verified FROM workers WHERE id = ?').get(req.auth.sub);
  if (!setu.panApiConfigured() && already && already.pan_verified && already.pan_number) {
    if (already.pan_number !== pan) return res.status(422).json({ error: `This PAN card (${pan.slice(0, 5)}XXXX${pan.slice(-1)}) is not the PAN verified in DigiLocker - photograph your own PAN card` });
    return res.json({ verified: true, fullName: already.pan_name, viaDigilocker: true, worker: db.prepare('SELECT * FROM workers WHERE id = ?').get(req.auth.sub) });
  }
  if (!setu.panApiConfigured()) {
    return res.status(503).json({ error: 'PAN is verified through DigiLocker in the previous step - complete DigiLocker (Aadhaar + PAN) first', panApiUnavailable: true });
  }

  try {
    const result = await setu.verifyPan(pan);
    if (result.verification !== 'success') {
      return res.status(422).json({ error: result.message || 'PAN verification failed', raw: result });
    }
    const w = db.prepare('SELECT * FROM workers WHERE id = ?').get(req.auth.sub);
    if (w.name && result.data.full_name && !namesMatch(w.name, result.data.full_name)) {
      return res.status(422).json({ error: `PAN name "${result.data.full_name}" does not match registered name "${w.name}" (R05 requires a match)`, panName: result.data.full_name });
    }
    // BRD §10 screen 7: "Name must match Aadhaar".
    if (w.aadhaar_name && result.data.full_name && !namesMatch(w.aadhaar_name, result.data.full_name)) {
      return res.status(422).json({ error: `PAN name "${result.data.full_name}" does not match Aadhaar name "${w.aadhaar_name}" (R05)`, panName: result.data.full_name });
    }
    db.prepare('UPDATE workers SET pan_number = ?, pan_name = ?, pan_verified = 1 WHERE id = ?').run(pan, result.data.full_name || null, req.auth.sub);
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


const setuConfigured = setu.isConfigured;

// ---- Dev-only bypass, for testing the rest of the app before Setu credentials exist.
// Self-disables the moment real credentials are set — once Setu is configured, real
// verification is required and this always returns 403. Remove this route entirely
// before any real deployment; it should never ship reachable in production. ----
router.post('/skip-dev', requireAuth('worker'), (req, res) => {
  if (process.env.NODE_ENV === 'production' || process.env.DEV_BYPASS !== '1') return res.status(404).json({ error: 'Not found' });
  if (setuConfigured()) {
    return res.status(403).json({ error: 'Setu credentials are configured — real Aadhaar/PAN verification is required now, skip is disabled.' });
  }
  db.prepare(`UPDATE workers SET
      aadhaar_verified = 1, aadhaar_masked = COALESCE(aadhaar_masked, 'XXXX-XXXX-DEV0'),
      pan_number = COALESCE(pan_number, 'DEVSKIP-' || substr(id, 1, 8)), pan_verified = 1, kyc_status = 'verified'
    WHERE id = ?`).run(req.auth.sub);
  addAudit(req.auth.mobile, 'kyc_dev_skip', 'Aadhaar + PAN verification skipped — dev mode, no Setu credentials configured yet');
  res.json({ worker: db.prepare('SELECT * FROM workers WHERE id = ?').get(req.auth.sub) });
});

// Temporary diagnostic (2026-10-15): re-fetches the same completed DigiLocker session's
// raw payload without a fresh OTP, so the real Meon field names can be read off once and
// the photo field fixed (the full e-Aadhaar document ended up as the profile photo
// instead of just the face - meonClient.js's photoUrl field guess was wrong). Remove once
// that's fixed and confirmed.
router.get('/debug-raw/:workerId', requirePermission('users.manage'), async (req, res) => {
  const meon = require('../services/meonClient');
  const reqRow = db.prepare('SELECT * FROM digilocker_requests WHERE worker_id = ? ORDER BY created_at DESC LIMIT 1').get(req.params.workerId);
  if (!reqRow) return res.status(404).json({ error: 'No DigiLocker request for this worker' });
  try {
    const r = await meon.fetchDigilockerData(reqRow.client_token, reqRow.id);
    res.json(r);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

module.exports = router;

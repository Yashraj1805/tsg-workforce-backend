const express = require('express');
const crypto = require('node:crypto');
const { db, addAudit } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const gemini = require('../services/geminiClient');
const setu = require('../services/kycProvider'); // Meon (live) or Setu, same interface
const { parseAadhaarQr, aadhaarKey, careOfName } = require('../services/aadhaarQr');
const { decodeQrFromDataUrl } = require('../services/qrImage');
const { namesMatch } = require('../services/nameMatch');
const { checkDocument } = require('../services/identityChecks');
const { can } = require('../rbac');
const { checkImages } = require('../services/images');

const router = express.Router();
const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/;

// ---- Vendors (BRD R01) ----
// GET is readable by any authenticated role — a worker needs the vendor/location
// list during registration to pick from; only mutations are HR-only.
router.get('/vendors', requireAuth(), (req, res) => {
  const rows = db.prepare('SELECT * FROM vendors ORDER BY created_at DESC').all();
  // The contact person's PAN/Aadhaar details are for the System Admin who verifies them —
  // a worker picking their agency, or a Site HR, gets the business fields only.
  if (req.user && can(req.user.role, 'masters.write')) return res.json(rows);
  res.json(rows.map(v => { const o = { ...v }; for (const c of VENDOR_KYC_COLS) delete o[c]; o.contact_kyc_done = !!(v.contact_pan_verified && v.contact_aadhaar_verified); return o; }));
});

// R01: "Vendor list: name, GSTIN, contact, contract dates". Validates what's given and
// merges it over the existing row (for PUT), so the same function serves both.
const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function readVendor(body, existing) {
  // body[k] can legitimately be null (e.g. a tamper flag cleared after a retake) —
  // String(null) would otherwise stringify to the text "null" instead of staying NULL.
  const pick = (k, col) => body[k] !== undefined ? (body[k] === null ? null : String(body[k]).trim() || null) : (existing ? existing[col] : null);
  const v = {
    name: pick('name', 'name'),
    gstin: pick('gstin', 'gstin'), pan: pick('pan', 'pan'),
    contact_person: pick('contactPerson', 'contact_person'), phone: pick('phone', 'phone'),
    contract_start: pick('contractStart', 'contract_start'), contract_end: pick('contractEnd', 'contract_end'),
    status: pick('status', 'status') || 'active',
    // Contact person's KYC — captured client-side via the vendor-kyc endpoints below
    // (OCR/QR-parse are stateless, run before the vendor row exists) and sent along
    // with the rest of the form on save.
    contact_pan_photo_data_url: pick('contactPanPhotoDataUrl', 'contact_pan_photo_data_url'),
    contact_pan_number: pick('contactPanNumber', 'contact_pan_number'),
    contact_pan_name: pick('contactPanName', 'contact_pan_name'),
    contact_pan_tamper_note: pick('contactPanTamperNote', 'contact_pan_tamper_note'),
    // Never taken from the client (unlike the other KYC fields above, which are only
    // ever OCR/QR-parse output, not a trust claim) — the worker-KYC pattern in kyc.js
    // only sets *_verified after a real setu.verifyPan() call on the server, and vendor
    // contact KYC follows the same rule: this stays whatever it already was (0 on
    // create) and only /vendor-kyc/pan-verify below can flip it to 1, by writing
    // straight to the DB after its own successful Setu check.
    contact_pan_verified: existing ? existing.contact_pan_verified : 0,
    contact_aadhaar_masked: pick('contactAadhaarMasked', 'contact_aadhaar_masked'),
    contact_aadhaar_key: pick('contactAadhaarKey', 'contact_aadhaar_key'),
    contact_aadhaar_name: pick('contactAadhaarName', 'contact_aadhaar_name'),
    contact_aadhaar_qr_format: pick('contactAadhaarQrFormat', 'contact_aadhaar_qr_format'),
    contact_aadhaar_qr_signature: pick('contactAadhaarQrSignature', 'contact_aadhaar_qr_signature'),
    contact_aadhaar_qr_at: body.contactAadhaarQrAt !== undefined ? body.contactAadhaarQrAt : (existing ? existing.contact_aadhaar_qr_at : null),
  };
  if (v.gstin) v.gstin = v.gstin.toUpperCase();
  if (v.pan) v.pan = v.pan.toUpperCase();
  if (v.contact_pan_number) v.contact_pan_number = v.contact_pan_number.toUpperCase();
  if (!v.name) return { error: 'name is required' };
  if (v.gstin && !GSTIN_RE.test(v.gstin)) return { error: 'GSTIN should be 15 characters, e.g. 07ABCDE1234F1Z5' };
  if (v.phone && !/^\d{10}$/.test(v.phone)) return { error: 'Phone should be a 10-digit mobile number' };
  if (v.contact_pan_number && !PAN_RE.test(v.contact_pan_number)) return { error: 'Contact person PAN looks invalid, e.g. ABCDE1234F' };
  for (const d of ['contract_start', 'contract_end']) if (v[d] && !DATE_RE.test(v[d])) return { error: 'Contract dates must be YYYY-MM-DD' };
  if (v.contract_start && v.contract_end && v.contract_end < v.contract_start) return { error: 'Contract end date is before the start date' };
  if (!['active', 'inactive'].includes(v.status)) return { error: 'status must be "active" or "inactive"' };
  return { v };
}

const VENDOR_KYC_COLS = ['contact_pan_photo_data_url', 'contact_pan_number', 'contact_pan_name', 'contact_pan_tamper_note',
  'contact_pan_verified', 'contact_aadhaar_masked', 'contact_aadhaar_key', 'contact_aadhaar_name',
  'contact_aadhaar_qr_format', 'contact_aadhaar_qr_signature', 'contact_aadhaar_qr_at'];
const VENDOR_COLS = ['name', 'gstin', 'pan', 'contact_person', 'phone', 'contract_start', 'contract_end', 'status', ...VENDOR_KYC_COLS];

router.post('/vendors', requirePermission('masters.write'), (req, res) => {
  const { v, error } = readVendor(req.body || {}, null);
  if (error) return res.status(400).json({ error });
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO vendors (id, ${VENDOR_COLS.join(', ')}, created_at) VALUES (?,${VENDOR_COLS.map(() => '?').join(',')},?)`)
    .run(id, ...VENDOR_COLS.map(c => v[c]), Date.now());
  addAudit(req.auth.email, 'add_vendor', `${v.name} (contract ${v.contract_start || '?'} to ${v.contract_end || '?'})${v.contact_pan_number ? `, contact KYC: PAN ${v.contact_pan_number.slice(0, 5)}XXXX${v.contact_pan_number.slice(-1)}` : ''}${v.contact_aadhaar_masked ? `, Aadhaar ${v.contact_aadhaar_masked}` : ''}${v.contact_pan_tamper_note ? ` — TAMPER FLAG: ${v.contact_pan_tamper_note}` : ''}`);
  res.status(201).json(db.prepare('SELECT * FROM vendors WHERE id = ?').get(id));
});

router.put('/vendors/:id', requirePermission('masters.write'), (req, res) => {
  const old = db.prepare('SELECT * FROM vendors WHERE id = ?').get(req.params.id);
  if (!old) return res.status(404).json({ error: 'Not found' });
  const { v, error } = readVendor(req.body || {}, old);
  if (error) return res.status(400).json({ error });
  db.prepare(`UPDATE vendors SET ${VENDOR_COLS.map(c => `${c}=?`).join(', ')} WHERE id=?`)
    .run(...VENDOR_COLS.map(c => v[c]), old.id);
  // KYC fields (full PAN number, base64 photo) are deliberately excluded from this
  // generic diff and never written to audit_log unmasked — audit.read's audience
  // (central_hr, security, system_admin) is broader than masters.write, and the log
  // is retained/exported longer than the primary table. A changed KYC field only gets
  // a masked one-line note, same shape as add_vendor's.
  const changed = Object.keys(v).filter(k => !VENDOR_KYC_COLS.includes(k) && v[k] !== old[k]).map(k => `${k}: ${old[k] ?? '-'} -> ${v[k] ?? '-'}`);
  const kycChanged = VENDOR_KYC_COLS.some(k => v[k] !== old[k]);
  if (kycChanged) changed.push(`contact KYC updated${v.contact_pan_number ? ` (PAN ${v.contact_pan_number.slice(0, 5)}XXXX${v.contact_pan_number.slice(-1)})` : ''}${v.contact_aadhaar_masked ? `, Aadhaar ${v.contact_aadhaar_masked}` : ''}${v.contact_pan_tamper_note ? ` — TAMPER FLAG: ${v.contact_pan_tamper_note}` : ''}`);
  addAudit(req.auth.email, 'edit_vendor', `${old.name}: ${changed.join(', ') || 'no changes'}`);
  res.json(db.prepare('SELECT * FROM vendors WHERE id = ?').get(old.id));
});

// ---- Vendor contact-person KYC (Aadhaar is an individual document — the "vendor"
// here is the authorized contact, not the company). Stateless: the vendor row may
// not exist yet when HR is mid-way through the "Add vendor" form, so these just
// read/verify a photo or QR and hand back the parsed result; the form includes it
// in the vendor create/update payload above when HR saves. ----
router.post('/vendor-kyc/pan-photo', requirePermission('masters.write'), async (req, res) => {
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
  res.json({ panNumber: pan, nameOnCard: r.nameOnCard || null, confidence: r.confidence, tamperSuspected: !!r.tamperSuspected, tamperNote });
});

router.post('/vendor-kyc/aadhaar-qr', requirePermission('masters.write'), (req, res) => {
  const { qrText } = req.body || {};
  if (!qrText) return res.status(400).json({ error: 'qrText is required' });
  if (typeof qrText !== 'string' || qrText.length > 12000) return res.status(400).json({ error: 'That is not an Aadhaar QR' });
  return acceptVendorAadhaarQr(req, res, qrText);
});
router.post('/vendor-kyc/aadhaar-qr-image', requirePermission('masters.write'), (req, res) => {
  const { photoDataUrl } = req.body || {};
  if (!photoDataUrl) return res.status(400).json({ error: 'photoDataUrl is required' });
  const bad = checkImages(req.body, { photoDataUrl: 'document' }); if (bad) return res.status(bad.status).json({ error: bad.error });
  let text;
  try { text = decodeQrFromDataUrl(photoDataUrl); } catch (e) { return res.status(400).json({ error: e.message }); }
  if (!text) return res.status(422).json({ error: 'Could not read the QR in the photo — hold the phone closer so the QR fills most of the photo, in good light, without glare' });
  return acceptVendorAadhaarQr(req, res, text);
});
function acceptVendorAadhaarQr(req, res, qrText) {
  let qr;
  try { qr = parseAadhaarQr(qrText); } catch (e) { return res.status(422).json({ error: e.message }); }
  if (qr.signature === 'invalid') {
    addAudit(req.auth.email, 'vendor_aadhaar_qr_forged', 'Aadhaar QR signature did not verify against the UIDAI certificate (vendor contact KYC)');
    return res.status(422).json({ error: 'This Aadhaar QR failed UIDAI signature check — it may be edited or fake' });
  }
  const key = aadhaarKey(qr.last4, qr.dob);
  // Not a worker registration, so this doesn't block (a vendor contact isn't subject
  // to R06/R14 the way a worker is) — but HR should still know if this Aadhaar belongs
  // to a worker who was exited-and-blacklisted, or is already a live worker, rather
  // than silently missing it (identityChecks.js' checkDocument is worker-table-scoped;
  // '' as the exclude-id is safe since no real worker id is ever empty).
  const hit = checkDocument('aadhaar_key', key, '');
  if (hit) addAudit(req.auth.email, 'vendor_kyc_flag', `Vendor contact Aadhaar ${hit.audit} (not blocked — vendor contact, not a worker registration)`);
  res.json({
    maskedNumber: `XXXX-XXXX-${qr.last4}`, aadhaarKey: key,
    name: qr.name || null, dob: qr.dob || null, gender: qr.gender || null,
    careOf: careOfName(qr.careOf) || null, address: qr.address || null,
    format: qr.format, signature: qr.signature,
    warning: hit ? `This Aadhaar ${hit.kind === 'blacklisted' ? 'belongs to a blacklisted worker' : 'is already registered to a worker'} — ${hit.audit}` : null,
  });
}

// PAN authenticity check against the issuer (via Setu) — separate from the OCR step
// above, same as worker KYC. Gracefully degrades until real Setu credentials exist.
// `vendorId`, if given, persists the verified flag straight to that vendor's row here
// on the server — contact_pan_verified is never accepted from the client (readVendor
// above), precisely so it can only ever become true through this real check.
router.post('/vendor-kyc/pan-verify', requirePermission('masters.write'), async (req, res) => {
  const pan = ((req.body || {}).pan || '').toUpperCase();
  const aadhaarName = (req.body || {}).aadhaarName || null;
  const vendorId = (req.body || {}).vendorId || null;
  if (!PAN_RE.test(pan)) return res.status(400).json({ error: 'Enter a valid PAN, e.g. ABCDE1234F' });
  if (!setu.panApiConfigured()) return res.status(503).json({ error: 'Standalone PAN verification API is not enabled yet - the OCR-read PAN is saved as unverified for now', panApiUnavailable: true });
  try {
    const result = await setu.verifyPan(pan);
    if (result.verification !== 'success') return res.status(422).json({ error: result.message || 'PAN verification failed', raw: result });
    if (aadhaarName && result.data.full_name && !namesMatch(aadhaarName, result.data.full_name)) {
      return res.status(422).json({ error: `PAN name "${result.data.full_name}" does not match Aadhaar name "${aadhaarName}"`, panName: result.data.full_name });
    }
    const hit = checkDocument('pan_number', pan, '');
    if (hit) addAudit(req.auth.email, 'vendor_kyc_flag', `Vendor contact PAN ${hit.audit} (not blocked — vendor contact, not a worker registration)`);
    if (vendorId) {
      db.prepare('UPDATE vendors SET contact_pan_verified = 1 WHERE id = ?').run(vendorId);
      addAudit(req.auth.email, 'vendor_pan_verified', `${pan.slice(0, 5)}XXXX${pan.slice(-1)} for vendor ${vendorId}`);
    }
    res.json({ verified: true, fullName: result.data.full_name || null, warning: hit ? `This PAN ${hit.kind === 'blacklisted' ? 'belongs to a blacklisted worker' : 'is already registered to a worker'} — ${hit.audit}` : null });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ---- Jobs (BRD §10 screen 8: "One choice. The list is set by admin.") ----
router.get('/jobs', requireAuth(), (req, res) => {
  res.json(db.prepare('SELECT * FROM jobs ORDER BY sort, name').all());
});
router.post('/jobs', requirePermission('masters.write'), (req, res) => {
  const { name, nameHi, icon } = req.body || {};
  if (!(name || '').trim()) return res.status(400).json({ error: 'name is required' });
  const id = crypto.randomUUID();
  const sort = (db.prepare('SELECT MAX(sort) m FROM jobs').get().m || 0) + 1;
  db.prepare('INSERT INTO jobs (id, name, name_hi, icon, active, sort) VALUES (?,?,?,?,1,?)').run(id, name.trim(), (nameHi || '').trim() || null, (icon || '').trim() || null, sort);
  addAudit(req.auth.email, 'add_job', name.trim());
  res.status(201).json(db.prepare('SELECT * FROM jobs WHERE id = ?').get(id));
});
router.put('/jobs/:id', requirePermission('masters.write'), (req, res) => {
  const j = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!j) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  const next = {
    name: b.name !== undefined ? String(b.name).trim() : j.name,
    name_hi: b.nameHi !== undefined ? (String(b.nameHi).trim() || null) : j.name_hi,
    icon: b.icon !== undefined ? (String(b.icon).trim() || null) : j.icon,
    active: b.active !== undefined ? (b.active ? 1 : 0) : j.active,
  };
  if (!next.name) return res.status(400).json({ error: 'name is required' });
  db.prepare('UPDATE jobs SET name = ?, name_hi = ?, icon = ?, active = ? WHERE id = ?').run(next.name, next.name_hi, next.icon, next.active, j.id);
  addAudit(req.auth.email, 'edit_job', `${j.name}${next.name !== j.name ? ' -> ' + next.name : ''}${next.active !== j.active ? (next.active ? ' (re-activated)' : ' (retired)') : ''}`);
  res.json(db.prepare('SELECT * FROM jobs WHERE id = ?').get(j.id));
});

// Everything the registration wizard offers as a choice, plus the current consent text.
router.get('/registration-options', requireAuth(), (req, res) => {
  const { EDUCATION, EXPERIENCE, CONSENT } = require('../registrationOptions');
  // devSkipAllowed mirrors exactly when /api/kyc/skip-dev will accept (dev server, no
  // Setu creds) — so the wizard's "skip KYC" button never renders where it would fail,
  // and above all never renders in production.
  res.json({ jobs: db.prepare('SELECT * FROM jobs WHERE active = 1 ORDER BY sort, name').all(), education: EDUCATION, experience: EXPERIENCE, consent: CONSENT,
    devSkipAllowed: process.env.NODE_ENV !== 'production' && process.env.DEV_BYPASS === '1' && !setu.isConfigured() });
});

// ---- Locations (BRD R02) ----
router.get('/locations', requireAuth(), (req, res) => {
  res.json(db.prepare('SELECT * FROM locations ORDER BY created_at DESC').all());
});

router.post('/locations', requirePermission('masters.write'), (req, res) => {
  const { name, brand, lat, lng, radius, accuracyLimit } = req.body || {};
  if (!name || typeof lat !== 'number' || typeof lng !== 'number') return res.status(400).json({ error: 'name, lat and lng are required' });
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO locations (id, name, brand, lat, lng, radius, accuracy_limit, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, name, brand || null, lat, lng, radius || 150, accuracyLimit || 100, Date.now());
  addAudit(req.auth.email, 'add_location', name);
  res.status(201).json(db.prepare('SELECT * FROM locations WHERE id = ?').get(id));
});

router.put('/locations/:id', requirePermission('masters.write'), (req, res) => {
  const l = db.prepare('SELECT * FROM locations WHERE id = ?').get(req.params.id);
  if (!l) return res.status(404).json({ error: 'Not found' });
  const { name, brand, lat, lng, radius, accuracyLimit } = req.body || {};
  // BRD §11 screen 9: weekly off day shows grey on the worker calendar (0 = Sunday … 6, null = none).
  const wo = (req.body || {}).weeklyOff;
  if (wo !== undefined && wo !== null && !(Number.isInteger(wo) && wo >= 0 && wo <= 6)) return res.status(400).json({ error: 'weeklyOff must be 0 (Sunday) to 6 (Saturday) or null' });
  const v = (x) => (x === undefined ? null : x);
  db.prepare('UPDATE locations SET name=COALESCE(?,name), brand=COALESCE(?,brand), lat=COALESCE(?,lat), lng=COALESCE(?,lng), radius=COALESCE(?,radius), accuracy_limit=COALESCE(?,accuracy_limit) WHERE id=?')
    .run(v(name), v(brand), v(lat), v(lng), v(radius), v(accuracyLimit), req.params.id);
  if (wo !== undefined) db.prepare('UPDATE locations SET weekly_off = ? WHERE id = ?').run(wo, l.id);
  addAudit(req.auth.email, 'edit_location', `${l.name} -> ${lat ?? l.lat}, ${lng ?? l.lng}, radius ${radius ?? l.radius}m${wo !== undefined ? `, weekly off ${wo ?? 'none'}` : ''}`);
  res.json(db.prepare('SELECT * FROM locations WHERE id = ?').get(req.params.id));
});

module.exports = router;

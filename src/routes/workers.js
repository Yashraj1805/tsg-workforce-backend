const express = require('express');
const crypto = require('node:crypto');
const { db, addAudit } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { workerScopeSql } = require('../rbac');
const setu = require('../services/setuClient');
const time = require('../services/time');
const { namesMatch } = require('../services/nameMatch');
const { checkDocument, checkFace, checkRegistrationPhoto } = require('../services/identityChecks');
const { haversineMeters } = require('../services/geo');
const { EDUCATION, EXPERIENCE, CONSENT } = require('../registrationOptions');
const { notifyWorker } = require('../services/notify');

const router = express.Router();

function getWorker(id) { return db.prepare('SELECT * FROM workers WHERE id = ?').get(id); }

// ---- Worker: view / edit own profile ----
router.get('/me', requireAuth('worker'), (req, res) => {
  const w = getWorker(req.auth.sub);
  if (!w) return res.status(404).json({ error: 'Worker not found' });
  // Include the assigned location's coordinates/radius so the app can show a
  // pre-punch GPS/geofence check without needing a separate HR-only endpoint.
  const location = w.location_id ? db.prepare('SELECT id, name, brand, lat, lng, radius, accuracy_limit, weekly_off FROM locations WHERE id = ?').get(w.location_id) : null;
  const vendor = w.vendor_id ? db.prepare('SELECT id, name, phone FROM vendors WHERE id = ?').get(w.vendor_id) : null;
  // BRD §11 screen 10: "Missed punch — worker cannot edit. Button calls site HR."
  const siteHr = w.location_id ? db.prepare("SELECT name, phone FROM hr_users WHERE role = 'site_hr' AND status = 'active' AND location_id = ? AND phone IS NOT NULL ORDER BY created_at LIMIT 1").get(w.location_id) : null;
  res.json({ ...w, location, vendor, siteHr: siteHr || null });
});

router.put('/me', requireAuth('worker'), async (req, res) => {
  const w = getWorker(req.auth.sub);
  if (!w) return res.status(404).json({ error: 'Worker not found' });
  if (w.status === 'approved') return res.status(400).json({ error: 'Approved profile cannot be self-edited — contact HR' });

  // location_id is NOT editable here: BRD §10 screen 9 "Site is set by GPS" — see
  // POST /me/site-from-gps (or the Site HR's site, for assisted registration).
  // designation follows job_id (screen 8: one choice from the admin's job list).
  const fields = ['name', 'father_name', 'dob', 'gender', 'address', 'emergency_contact',
    'vendor_id', 'vendor_code', 'job_id', 'doj', 'qualification', 'experience', 'photo_data_url', 'bank_passbook_data_url'];
  const body = req.body || {};
  const updates = fields.filter(f => body[toCamel(f)] !== undefined);
  const extra = {}; // derived columns written alongside

  // vendor_id is a foreign key — an empty string from an empty <select> isn't a valid
  // reference and must not reach the database as one. Treat '' as "not set yet" (null),
  // and if a real id is given, confirm it exists so a bad reference fails clearly.
  if (updates.includes('vendor_id')) {
    const val = body.vendorId || null;
    const vendor = val && db.prepare('SELECT * FROM vendors WHERE id = ?').get(val);
    if (val && !vendor) {
      return res.status(400).json({ error: 'Selected vendor does not exist — ask HR to add it first' });
    }
    // R01: no new registrations under a vendor that's deactivated or out of contract.
    const today = time.today();
    if (vendor && vendor.id !== w.vendor_id && (vendor.status !== 'active' || (vendor.contract_end && vendor.contract_end < today) || (vendor.contract_start && vendor.contract_start > today))) {
      return res.status(400).json({ error: `${vendor.name} has no active contract — choose another vendor or ask HR` });
    }
    body.vendorId = val;
  }
  if (updates.includes('job_id')) {
    const job = body.jobId && db.prepare('SELECT * FROM jobs WHERE id = ? AND active = 1').get(body.jobId);
    if (body.jobId && !job) return res.status(400).json({ error: 'Pick a job from the list' });
    body.jobId = job ? job.id : null;
    extra.designation = job ? job.name : null;
  }
  if (updates.includes('qualification') && body.qualification && !EDUCATION.some(e => e.id === body.qualification)) {
    return res.status(400).json({ error: 'Pick education from the list' });
  }
  if (updates.includes('experience') && body.experience && !EXPERIENCE.some(e => e.id === body.experience)) {
    return res.status(400).json({ error: 'Pick experience from the list' });
  }
  if (updates.includes('emergency_contact') && body.emergencyContact && !/^\d{10}$/.test(body.emergencyContact)) {
    return res.status(400).json({ error: 'Emergency contact must be a 10-digit mobile number' });
  }
  // Screen 5: "Live check, one face only." A photo of a photo/screen, no face, or a group
  // photo is refused; if the check can't run (no Gemini key / outage) the photo is kept
  // and the note tells HR it wasn't checked.
  if (updates.includes('photo_data_url') && body.photoDataUrl) {
    const check = await checkRegistrationPhoto(body.photoDataUrl);
    if (!check.ok) return res.status(422).json({ error: check.error, photoCheck: true });
    extra.photo_check_note = check.note;
  }

  const cols = [...updates, ...Object.keys(extra)];
  if (cols.length) {
    const values = [...updates.map(f => body[toCamel(f)]), ...Object.values(extra)];
    db.prepare(`UPDATE workers SET ${cols.map(f => `${f} = ?`).join(', ')} WHERE id = ?`).run(...values, w.id);
  }
  res.json(getWorker(w.id));
});

// BRD §10 screen 9: "Site is set by GPS". The phone sends its position; the server picks
// the TSG site whose geofence contains it (same distance + accuracy rules as punching),
// so a worker can only be registered at a site they're actually standing at.
router.post('/me/site-from-gps', requireAuth('worker'), (req, res) => {
  const w = getWorker(req.auth.sub);
  if (!w) return res.status(404).json({ error: 'Worker not found' });
  if (w.status === 'approved') return res.status(400).json({ error: 'Approved profile cannot be self-edited — contact HR' });
  if (req.auth.assistedBy) return res.status(400).json({ error: 'Registered by Site HR — the site is the Site HR\'s own location' });
  const { lat, lng, accuracy } = req.body || {};
  if (typeof lat !== 'number' || typeof lng !== 'number') return res.status(400).json({ error: 'lat/lng are required' });
  const inside = db.prepare('SELECT * FROM locations').all()
    .map(l => ({ ...l, distanceM: Math.round(haversineMeters(lat, lng, l.lat, l.lng)) }))
    .filter(l => l.distanceM <= l.radius)
    .sort((a, b) => a.distanceM - b.distanceM);
  if (!inside.length) return res.status(422).json({ error: 'You are not at a TSG site — register while you are at your work site' });
  const site = inside[0];
  if (accuracy != null && accuracy > site.accuracy_limit) {
    return res.status(422).json({ error: `GPS accuracy too low (${Math.round(accuracy)} m) — move to an open area and try again` });
  }
  db.prepare('UPDATE workers SET location_id = ? WHERE id = ?').run(site.id, w.id);
  res.json({ location: { id: site.id, name: site.name, brand: site.brand, distanceM: site.distanceM }, worker: getWorker(w.id) });
});

// BRD §10 screen 4: consent saved with date, time and version.
router.post('/me/consent', requireAuth('worker'), (req, res) => {
  const { version, language } = req.body || {};
  if (version !== CONSENT.version) return res.status(400).json({ error: 'The consent text has changed — please read it again', currentVersion: CONSENT.version });
  const now = Date.now();
  db.prepare('INSERT INTO consents (id, worker_id, version, language, accepted_at, device_id, assisted_by) VALUES (?,?,?,?,?,?,?)')
    .run(crypto.randomUUID(), req.auth.sub, version, language || null, now, (req.body || {}).deviceId || null, req.auth.assistedByEmail || null);
  db.prepare('UPDATE workers SET consent_version = ?, consent_at = ? WHERE id = ?').run(version, now, req.auth.sub);
  addAudit(req.auth.mobile, 'consent_given', `Consent ${version} (${language || '?'})${req.auth.assistedByEmail ? `, with Site HR ${req.auth.assistedByEmail}` : ''}`);
  res.json(getWorker(req.auth.sub));
});

function toCamel(snake) { return snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase()); }

router.post('/me/submit', requireAuth('worker'), async (req, res) => {
  const w = getWorker(req.auth.sub);
  if (!w) return res.status(404).json({ error: 'Worker not found' });
  if (!w.aadhaar_verified || !w.pan_verified) {
    return res.status(400).json({ error: 'Aadhaar and PAN must both be verified before submitting for HR approval' });
  }
  // R04: documents captured by camera. Only enforced once real KYC is configured — the
  // dev KYC skip (kyc.js /skip-dev) exists precisely because there's nothing to scan yet.
  if (setu.isConfigured() && (!w.aadhaar_qr_at || !w.pan_photo_data_url)) {
    return res.status(400).json({ error: 'Scan the Aadhaar QR and take a photo of the PAN card before submitting (R04)' });
  }
  // R05, re-checked at submit: the profile name can still be edited after KYC, so the
  // match done at verification time alone isn't enough.
  for (const [doc, docName] of [['Aadhaar', w.aadhaar_name], ['PAN', w.pan_name]]) {
    if (w.name && docName && !namesMatch(w.name, docName)) {
      return res.status(400).json({ error: `Your name "${w.name}" does not match the name on your ${doc} ("${docName}") — correct it before submitting (R05)` });
    }
  }
  // BRD §10 screen 7: "Name must match Aadhaar" — PAN against Aadhaar directly, not only
  // each against the typed name.
  if (w.aadhaar_name && w.pan_name && !namesMatch(w.aadhaar_name, w.pan_name)) {
    return res.status(400).json({ error: `PAN name "${w.pan_name}" does not match Aadhaar name "${w.aadhaar_name}" (R05)` });
  }
  if (!w.name || !w.location_id || !w.vendor_id) {
    return res.status(400).json({ error: 'Complete your profile (name, vendor, site) before submitting' });
  }
  if (!w.job_id) return res.status(400).json({ error: 'Choose your job before submitting' });
  if (!w.photo_data_url) return res.status(400).json({ error: 'Take your live photo before submitting' });
  if (w.consent_version !== CONSENT.version) return res.status(400).json({ error: 'Read and accept the consent before submitting', consentVersion: CONSENT.version });
  // R06 / blacklist, re-checked at submit: documents may have been registered by
  // someone else since they were verified, and the face can only be checked now that
  // the registration photo is final.
  for (const [field, value] of [['aadhaar_key', w.aadhaar_key], ['pan_number', w.pan_number]]) {
    const hit = checkDocument(field, value, w.id);
    if (hit) return refuseSubmit(res, w, hit);
  }
  const face = await checkFace(w);
  db.prepare('UPDATE workers SET face_check_note = ?, face_check_status = ? WHERE id = ?').run(face.note, face.verdict, w.id);
  if (!face.ok) return refuseSubmit(res, w, { ...face, audit: face.note });

  db.prepare("UPDATE workers SET status = 'pending' WHERE id = ?").run(w.id);
  addAudit(w.mobile, 'submit_registration', `Worker ${w.name} submitted for HR approval (${face.note})`);
  res.json(getWorker(w.id));
});

function refuseSubmit(res, w, hit) {
  addAudit(w.mobile, hit.kind === 'blacklisted' ? 'blacklist_hit' : 'duplicate_blocked', hit.audit);
  return res.status(hit.status).json({ error: hit.error, blocked: hit.kind });
}

// ---- HR: review and manage workers ----
// ---- Gate check (proposal: "No HR approval, no entry. Security at the gate checks the
// portal.") Search by mobile or name; returns only what a guard needs to decide entry —
// photo, name, vendor, site and whether they're allowed in — never KYC details. Each
// lookup is audited. Defined before '/:id' so the path isn't read as a worker id.
router.get('/gate-check', requirePermission('workers.gatecheck'), (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 3) return res.status(400).json({ error: 'Enter at least 3 characters of the mobile number or name' });
  const scope = workerScopeSql(req.user, 'w');
  const rows = db.prepare(`SELECT w.id, w.name, w.mobile, w.photo_data_url, w.status, w.blacklisted, w.designation, w.exit_date,
        v.name AS vendor_name, l.name AS location_name
      FROM workers w LEFT JOIN vendors v ON v.id = w.vendor_id LEFT JOIN locations l ON l.id = w.location_id
      WHERE ${scope.sql} AND (w.mobile LIKE ? OR lower(w.name) LIKE ?) ORDER BY w.name LIMIT 10`)
    .all(...scope.args, `%${q}%`, `%${q.toLowerCase()}%`);
  addAudit(req.user.email, 'gate_check', `Searched "${q}": ${rows.length} result(s)`);
  res.json(rows.map(r => ({
    id: r.id, name: r.name, mobileLast4: (r.mobile || '').slice(-4), photo: r.photo_data_url, designation: r.designation,
    vendor: r.vendor_name, location: r.location_name, status: r.status, blacklisted: !!r.blacklisted,
    entryAllowed: r.status === 'approved' && !r.blacklisted,
  })));
});

// Every admin read goes through the caller's scope (rbac.js) — e.g. a site HR only
// ever sees their own location's workers, a vendor coordinator only their vendor's.
router.get('/', requirePermission('workers.read'), (req, res) => {
  const { status } = req.query;
  const scope = workerScopeSql(req.user);
  let sql = `SELECT * FROM workers WHERE ${scope.sql}`;
  const args = [...scope.args];
  if (status) { sql += ' AND status = ?'; args.push(status); }
  res.json(db.prepare(sql + ' ORDER BY created_at DESC').all(...args));
});

// Out-of-scope workers 404 rather than 403, so the response doesn't confirm they exist.
function getScopedWorker(user, id) {
  const scope = workerScopeSql(user);
  return db.prepare(`SELECT * FROM workers WHERE id = ? AND ${scope.sql}`).get(id, ...scope.args);
}

router.get('/:id', requirePermission('workers.read'), (req, res) => {
  const w = getScopedWorker(req.user, req.params.id);
  if (!w) return res.status(404).json({ error: 'Not found' });
  const location = w.location_id ? db.prepare('SELECT id, name, brand, lat, lng, radius, accuracy_limit FROM locations WHERE id = ?').get(w.location_id) : null;
  const vendor = w.vendor_id ? db.prepare('SELECT id, name, phone FROM vendors WHERE id = ?').get(w.vendor_id) : null;
  res.json({ ...w, location, vendor });
});

// R08: every approved worker is linked to one reporting manager (TSG employee) with an
// email — that email is also what scopes the reporting_manager role (rbac.js) and who
// gets the daily team email.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function readManager(body) {
  const name = (body.reportingManagerName || '').trim();
  const email = (body.reportingManagerEmail || '').trim().toLowerCase();
  if (!name || !EMAIL_RE.test(email)) return { error: 'Reporting manager name and a valid email are required (R08)' };
  return { name, email };
}

router.post('/:id/approve', requirePermission('workers.approve'), (req, res) => {
  const w = getScopedWorker(req.user, req.params.id);
  if (!w) return res.status(404).json({ error: 'Not found' });
  if (w.status !== 'pending') return res.status(400).json({ error: `Cannot approve a worker with status "${w.status}"` });
  // BRD §12: "Approve is enabled only when Aadhaar, PAN, face match and duplicate checks
  // all pass." Duplicates/blacklist already stop a worker at submit; a face check that
  // flagged a possible match or couldn't run needs HR to confirm they compared the
  // photos, with a note that goes in the audit log.
  if (!w.aadhaar_verified || !w.pan_verified) return res.status(400).json({ error: 'Aadhaar and PAN are not both verified — cannot approve' });
  if (w.face_check_status === 'blocked') return res.status(400).json({ error: 'Face check matched another worker — cannot approve' });
  const faceReviewNote = ((req.body || {}).faceReviewNote || '').trim();
  if (w.face_check_status !== 'clear' && !faceReviewNote) {
    return res.status(400).json({ error: `Face check needs HR review (${w.face_check_note || 'not run'}) — compare the photos and add a note`, needsFaceReview: true });
  }
  const mgr = readManager(req.body || {});
  if (mgr.error) return res.status(400).json({ error: mgr.error });
  db.prepare("UPDATE workers SET status = 'approved', send_back_reason = NULL, reporting_manager_name = ?, reporting_manager_email = ? WHERE id = ?")
    .run(mgr.name, mgr.email, w.id);
  addAudit(req.auth.email, 'approve_registration', `Approved ${w.name} (${w.id}), reporting manager ${mgr.name} <${mgr.email}>${faceReviewNote ? `; face reviewed by HR: ${faceReviewNote}` : ''}`);
  notifyWorker(w, 'TSG Workforce: your registration is approved. You can now punch in at your site.');
  res.json(getWorker(w.id));
});

router.put('/:id/reporting-manager', requirePermission('workers.manage'), (req, res) => {
  const w = getScopedWorker(req.user, req.params.id);
  if (!w) return res.status(404).json({ error: 'Not found' });
  const mgr = readManager(req.body || {});
  if (mgr.error) return res.status(400).json({ error: mgr.error });
  db.prepare('UPDATE workers SET reporting_manager_name = ?, reporting_manager_email = ? WHERE id = ?').run(mgr.name, mgr.email, w.id);
  logEvent(w.id, req.user, 'manager_change', `Reporting manager ${w.reporting_manager_email || '-'} -> ${mgr.name} <${mgr.email}>`, null);
  addAudit(req.auth.email, 'change_reporting_manager', `${w.name}: ${w.reporting_manager_email || '-'} -> ${mgr.email}`);
  res.json(getWorker(w.id));
});

// Previously-used managers, so HR can pick instead of retyping the same email.
router.get('/meta/reporting-managers', requirePermission('workers.approve'), (req, res) => {
  res.json(db.prepare(`SELECT reporting_manager_name AS name, reporting_manager_email AS email, COUNT(*) AS workers
    FROM workers WHERE reporting_manager_email IS NOT NULL GROUP BY reporting_manager_email ORDER BY name`).all());
});

router.post('/:id/send-back', requirePermission('workers.approve'), (req, res) => {
  const { reason } = req.body || {};
  if (!reason) return res.status(400).json({ error: 'reason is required' });
  const w = getScopedWorker(req.user, req.params.id);
  if (!w) return res.status(404).json({ error: 'Not found' });
  db.prepare("UPDATE workers SET status = 'sent_back', send_back_reason = ? WHERE id = ?").run(reason, w.id);
  addAudit(req.auth.email, 'sendback_registration', `Sent back ${w.name}: ${reason}`);
  notifyWorker(w, `TSG Workforce: your registration was sent back — ${reason}. Open the app to fix it.`);
  res.json(getWorker(w.id));
});

router.post('/:id/reject', requirePermission('workers.approve'), (req, res) => {
  const w = getScopedWorker(req.user, req.params.id);
  if (!w) return res.status(404).json({ error: 'Not found' });
  db.prepare("UPDATE workers SET status = 'rejected' WHERE id = ?").run(w.id);
  addAudit(req.auth.email, 'reject_registration', `Rejected ${w.name}`);
  res.json(getWorker(w.id));
});

// ---- R14: transfer, exit, blacklist (+ R03 device change) ----
// BRD §8 "Records are never overwritten. Every change is logged with name and reason":
// every action here needs a reason and leaves a worker_events row (shown on the
// worker's history in the HR app) as well as the global audit log.
function logEvent(workerId, user, type, detail, reason) {
  db.prepare('INSERT INTO worker_events (id, worker_id, ts, by_user, type, detail, reason) VALUES (?,?,?,?,?,?,?)')
    .run(crypto.randomUUID(), workerId, Date.now(), user.email, type, detail, reason);
}
function needReason(body) { return (body.reason || '').trim() || null; }

router.get('/:id/history', requirePermission('workers.read'), (req, res) => {
  const w = getScopedWorker(req.user, req.params.id);
  if (!w) return res.status(404).json({ error: 'Not found' });
  res.json(db.prepare('SELECT * FROM worker_events WHERE worker_id = ? ORDER BY ts DESC').all(w.id));
});

router.post('/:id/exit', requirePermission('workers.manage'), (req, res) => {
  const body = req.body || {};
  const reason = needReason(body);
  if (!reason) return res.status(400).json({ error: 'reason is required' });
  const w = getScopedWorker(req.user, req.params.id);
  if (!w) return res.status(404).json({ error: 'Not found' });
  if (w.status === 'exited') return res.status(400).json({ error: 'Worker has already exited' });
  const blacklist = !!body.blacklist;
  const exitDate = body.exitDate || time.today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(exitDate)) return res.status(400).json({ error: 'exitDate must be YYYY-MM-DD' });
  db.prepare("UPDATE workers SET status = 'exited', blacklisted = ?, exit_date = ?, exit_reason = ? WHERE id = ?").run(blacklist ? 1 : 0, exitDate, reason, w.id);
  logEvent(w.id, req.user, blacklist ? 'exit_blacklisted' : 'exit', `Exited on ${exitDate}${blacklist ? ', blacklisted (Aadhaar, PAN and face can never register again)' : ''}`, reason);
  addAudit(req.auth.email, 'exit_worker', `Exited ${w.name}${blacklist ? ' (blacklisted)' : ''}: ${reason}`);
  res.json(getWorker(w.id));
});

router.post('/:id/transfer', requirePermission('workers.manage'), (req, res) => {
  const body = req.body || {};
  const reason = needReason(body);
  if (!reason) return res.status(400).json({ error: 'reason is required' });
  const w = getScopedWorker(req.user, req.params.id);
  if (!w) return res.status(404).json({ error: 'Not found' });
  if (w.status !== 'approved') return res.status(400).json({ error: `Only an approved worker can be transferred (status is "${w.status}")` });
  const locationId = body.locationId || w.location_id;
  const vendorId = body.vendorId || w.vendor_id;
  const loc = db.prepare('SELECT id, name FROM locations WHERE id = ?').get(locationId);
  const ven = db.prepare('SELECT id, name FROM vendors WHERE id = ?').get(vendorId);
  if (!loc || !ven) return res.status(400).json({ error: 'Selected location or vendor does not exist' });
  if (locationId === w.location_id && vendorId === w.vendor_id) return res.status(400).json({ error: 'Nothing to change — pick a different location or vendor' });
  const before = { loc: db.prepare('SELECT name FROM locations WHERE id = ?').get(w.location_id), ven: db.prepare('SELECT name FROM vendors WHERE id = ?').get(w.vendor_id) };
  db.prepare('UPDATE workers SET location_id = ?, vendor_id = ? WHERE id = ?').run(locationId, vendorId, w.id);
  const detail = `Location ${before.loc ? before.loc.name : '-'} -> ${loc.name}; vendor ${before.ven ? before.ven.name : '-'} -> ${ven.name}`;
  logEvent(w.id, req.user, 'transfer', detail, reason);
  addAudit(req.auth.email, 'transfer_worker', `Transferred ${w.name}: ${detail} (${reason})`);
  res.json(getWorker(w.id));
});

// R03: one phone per worker; a change needs HR approval. Clearing the bound device lets
// the worker's next punch bind their new phone (punches.js binds on first use).
router.post('/:id/reset-device', requirePermission('workers.manage'), (req, res) => {
  const reason = needReason(req.body || {});
  if (!reason) return res.status(400).json({ error: 'reason is required' });
  const w = getScopedWorker(req.user, req.params.id);
  if (!w) return res.status(404).json({ error: 'Not found' });
  if (!w.device_id) return res.status(400).json({ error: 'No phone is registered for this worker yet' });
  db.prepare('UPDATE workers SET device_id = NULL WHERE id = ?').run(w.id);
  logEvent(w.id, req.user, 'device_reset', 'Registered phone cleared — next punch binds the new phone', reason);
  addAudit(req.auth.email, 'reset_device', `${w.name}: ${reason}`);
  res.json(getWorker(w.id));
});

module.exports = router;

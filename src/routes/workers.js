const express = require('express');
const crypto = require('node:crypto');
const { db, addAudit } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { workerScopeSql } = require('../rbac');
const setu = require('../services/setuClient');
const time = require('../services/time');
const { namesMatch } = require('../services/nameMatch');
const { checkDocument, checkFace } = require('../services/identityChecks');

const router = express.Router();

function getWorker(id) { return db.prepare('SELECT * FROM workers WHERE id = ?').get(id); }

// ---- Worker: view / edit own profile ----
router.get('/me', requireAuth('worker'), (req, res) => {
  const w = getWorker(req.auth.sub);
  if (!w) return res.status(404).json({ error: 'Worker not found' });
  // Include the assigned location's coordinates/radius so the app can show a
  // pre-punch GPS/geofence check without needing a separate HR-only endpoint.
  const location = w.location_id ? db.prepare('SELECT id, name, brand, lat, lng, radius, accuracy_limit FROM locations WHERE id = ?').get(w.location_id) : null;
  const vendor = w.vendor_id ? db.prepare('SELECT id, name FROM vendors WHERE id = ?').get(w.vendor_id) : null;
  res.json({ ...w, location, vendor });
});

router.put('/me', requireAuth('worker'), (req, res) => {
  const w = getWorker(req.auth.sub);
  if (!w) return res.status(404).json({ error: 'Worker not found' });
  if (w.status === 'approved') return res.status(400).json({ error: 'Approved profile cannot be self-edited — contact HR' });

  const fields = ['name', 'father_name', 'dob', 'gender', 'address', 'emergency_contact',
    'vendor_id', 'vendor_code', 'location_id', 'designation', 'doj', 'qualification', 'experience', 'photo_data_url'];
  const body = req.body || {};
  const updates = fields.filter(f => body[toCamel(f)] !== undefined);

  // vendor_id/location_id are foreign keys — an empty string from an empty <select>
  // isn't a valid reference and must not be sent to the database as one (it would
  // violate the foreign key constraint and crash with a raw 500). Treat '' as "not
  // set yet" (null), and if a real id is given, confirm it actually exists so a
  // stale/bad reference fails with a clear error instead of a database crash.
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
  if (updates.includes('location_id')) {
    const val = body.locationId || null;
    if (val && !db.prepare('SELECT 1 FROM locations WHERE id = ?').get(val)) {
      return res.status(400).json({ error: 'Selected location does not exist — ask HR to add it first' });
    }
    // Site HR assisted registration: the worker is registered at that HR's own site.
    if (req.auth.assistedBy && val !== req.auth.assistedLocationId) {
      return res.status(400).json({ error: 'A worker registered by Site HR must be at that Site HR\'s location' });
    }
    body.locationId = val;
  }

  if (updates.length) {
    const sql = `UPDATE workers SET ${updates.map(f => `${f} = ?`).join(', ')} WHERE id = ?`;
    db.prepare(sql).run(...updates.map(f => body[toCamel(f)]), w.id);
  }
  res.json(getWorker(w.id));
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
  if (!w.name || !w.location_id || !w.vendor_id) {
    return res.status(400).json({ error: 'Complete your profile (name, vendor, location) before submitting' });
  }
  // R06 / blacklist, re-checked at submit: documents may have been registered by
  // someone else since they were verified, and the face can only be checked now that
  // the registration photo is final.
  for (const [field, value] of [['aadhaar_key', w.aadhaar_key], ['pan_number', w.pan_number]]) {
    const hit = checkDocument(field, value, w.id);
    if (hit) return refuseSubmit(res, w, hit);
  }
  const face = await checkFace(w);
  db.prepare('UPDATE workers SET face_check_note = ? WHERE id = ?').run(face.note, w.id);
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
  const mgr = readManager(req.body || {});
  if (mgr.error) return res.status(400).json({ error: mgr.error });
  db.prepare("UPDATE workers SET status = 'approved', send_back_reason = NULL, reporting_manager_name = ?, reporting_manager_email = ? WHERE id = ?")
    .run(mgr.name, mgr.email, w.id);
  addAudit(req.auth.email, 'approve_registration', `Approved ${w.name} (${w.id}), reporting manager ${mgr.name} <${mgr.email}>`);
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

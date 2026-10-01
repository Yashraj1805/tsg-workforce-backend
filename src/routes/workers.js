const express = require('express');
const { db, addAudit } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { workerScopeSql } = require('../rbac');
const setu = require('../services/setuClient');

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
    if (val && !db.prepare('SELECT 1 FROM vendors WHERE id = ?').get(val)) {
      return res.status(400).json({ error: 'Selected vendor does not exist — ask HR to add it first' });
    }
    body.vendorId = val;
  }
  if (updates.includes('location_id')) {
    const val = body.locationId || null;
    if (val && !db.prepare('SELECT 1 FROM locations WHERE id = ?').get(val)) {
      return res.status(400).json({ error: 'Selected location does not exist — ask HR to add it first' });
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

router.post('/me/submit', requireAuth('worker'), (req, res) => {
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
  if (!w.name || !w.location_id || !w.vendor_id) {
    return res.status(400).json({ error: 'Complete your profile (name, vendor, location) before submitting' });
  }
  db.prepare("UPDATE workers SET status = 'pending' WHERE id = ?").run(w.id);
  addAudit(w.mobile, 'submit_registration', `Worker ${w.name} submitted for HR approval`);
  res.json(getWorker(w.id));
});

// ---- HR: review and manage workers ----
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

router.post('/:id/exit', requirePermission('workers.manage'), (req, res) => {
  const { reason, blacklist } = req.body || {};
  const w = getScopedWorker(req.user, req.params.id);
  if (!w) return res.status(404).json({ error: 'Not found' });
  db.prepare("UPDATE workers SET status = 'exited', blacklisted = ? WHERE id = ?").run(blacklist ? 1 : 0, w.id);
  addAudit(req.auth.email, 'exit_worker', `Exited ${w.name}${blacklist ? ' (blacklisted)' : ''}: ${reason || ''}`);
  res.json(getWorker(w.id));
});

router.post('/:id/transfer', requirePermission('workers.manage'), (req, res) => {
  const { locationId, vendorId } = req.body || {};
  const w = getScopedWorker(req.user, req.params.id);
  if (!w) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE workers SET location_id = COALESCE(?, location_id), vendor_id = COALESCE(?, vendor_id) WHERE id = ?')
    .run(locationId || null, vendorId || null, w.id);
  addAudit(req.auth.email, 'transfer_worker', `Transferred ${w.name} -> location=${locationId || w.location_id}, vendor=${vendorId || w.vendor_id}`);
  res.json(getWorker(w.id));
});

module.exports = router;

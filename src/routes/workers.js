const express = require('express');
const { db, addAudit } = require('../db');
const { requireAuth } = require('../middleware/auth');

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
  if (!w.name || !w.location_id || !w.vendor_id) {
    return res.status(400).json({ error: 'Complete your profile (name, vendor, location) before submitting' });
  }
  db.prepare("UPDATE workers SET status = 'pending' WHERE id = ?").run(w.id);
  addAudit(w.mobile, 'submit_registration', `Worker ${w.name} submitted for HR approval`);
  res.json(getWorker(w.id));
});

// ---- HR: review and manage workers ----
router.get('/', requireAuth('hr'), (req, res) => {
  const { status } = req.query;
  const rows = status
    ? db.prepare('SELECT * FROM workers WHERE status = ? ORDER BY created_at DESC').all(status)
    : db.prepare('SELECT * FROM workers ORDER BY created_at DESC').all();
  res.json(rows);
});

router.get('/:id', requireAuth('hr'), (req, res) => {
  const w = getWorker(req.params.id);
  if (!w) return res.status(404).json({ error: 'Not found' });
  const location = w.location_id ? db.prepare('SELECT id, name, brand, lat, lng, radius, accuracy_limit FROM locations WHERE id = ?').get(w.location_id) : null;
  const vendor = w.vendor_id ? db.prepare('SELECT id, name, phone FROM vendors WHERE id = ?').get(w.vendor_id) : null;
  res.json({ ...w, location, vendor });
});

router.post('/:id/approve', requireAuth('hr'), (req, res) => {
  const w = getWorker(req.params.id);
  if (!w) return res.status(404).json({ error: 'Not found' });
  if (w.status !== 'pending') return res.status(400).json({ error: `Cannot approve a worker with status "${w.status}"` });
  db.prepare("UPDATE workers SET status = 'approved', send_back_reason = NULL WHERE id = ?").run(w.id);
  addAudit(req.auth.email, 'approve_registration', `Approved ${w.name} (${w.id})`);
  res.json(getWorker(w.id));
});

router.post('/:id/send-back', requireAuth('hr'), (req, res) => {
  const { reason } = req.body || {};
  if (!reason) return res.status(400).json({ error: 'reason is required' });
  const w = getWorker(req.params.id);
  if (!w) return res.status(404).json({ error: 'Not found' });
  db.prepare("UPDATE workers SET status = 'sent_back', send_back_reason = ? WHERE id = ?").run(reason, w.id);
  addAudit(req.auth.email, 'sendback_registration', `Sent back ${w.name}: ${reason}`);
  res.json(getWorker(w.id));
});

router.post('/:id/reject', requireAuth('hr'), (req, res) => {
  const w = getWorker(req.params.id);
  if (!w) return res.status(404).json({ error: 'Not found' });
  db.prepare("UPDATE workers SET status = 'rejected' WHERE id = ?").run(w.id);
  addAudit(req.auth.email, 'reject_registration', `Rejected ${w.name}`);
  res.json(getWorker(w.id));
});

router.post('/:id/exit', requireAuth('hr'), (req, res) => {
  const { reason, blacklist } = req.body || {};
  const w = getWorker(req.params.id);
  if (!w) return res.status(404).json({ error: 'Not found' });
  db.prepare("UPDATE workers SET status = 'exited', blacklisted = ? WHERE id = ?").run(blacklist ? 1 : 0, w.id);
  addAudit(req.auth.email, 'exit_worker', `Exited ${w.name}${blacklist ? ' (blacklisted)' : ''}: ${reason || ''}`);
  res.json(getWorker(w.id));
});

router.post('/:id/transfer', requireAuth('hr'), (req, res) => {
  const { locationId, vendorId } = req.body || {};
  const w = getWorker(req.params.id);
  if (!w) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE workers SET location_id = COALESCE(?, location_id), vendor_id = COALESCE(?, vendor_id) WHERE id = ?')
    .run(locationId || null, vendorId || null, w.id);
  addAudit(req.auth.email, 'transfer_worker', `Transferred ${w.name} -> location=${locationId || w.location_id}, vendor=${vendorId || w.vendor_id}`);
  res.json(getWorker(w.id));
});

module.exports = router;

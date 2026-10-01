// Proposal "Process 3: transfer and exit":
//   Transfer — requested by the hiring manager → accepted at the new location by Site HR →
//              location updated in the portal by Central HR.
//   Exit     — informed the same day by the hiring manager → login deactivated by Central
//              HR → misconduct: blacklisted by Central HR.
// Reporting managers and Site HR raise requests for workers they can see; an exit request
// emails Central HR immediately; Central HR completes it (the same performTransfer /
// performExit as the HR screen), which writes the worker's history.
const express = require('express');
const crypto = require('node:crypto');
const { db, addAudit } = require('../db');
const { requirePermission } = require('../middleware/auth');
const { workerScopeSql, ROLE_SCOPE } = require('../rbac');
const { performExit, performTransfer, getScopedWorker } = require('./workers');
const { sendEmail } = require('../services/notify');

db.exec(`CREATE TABLE IF NOT EXISTS worker_requests (id TEXT PRIMARY KEY, worker_id TEXT NOT NULL REFERENCES workers(id), type TEXT NOT NULL,
  to_location_id TEXT, to_vendor_id TEXT, exit_date TEXT, blacklist_suggested INTEGER NOT NULL DEFAULT 0, reason TEXT NOT NULL,
  status TEXT NOT NULL, raised_by TEXT NOT NULL, raised_at INTEGER NOT NULL, accepted_by TEXT, accepted_at INTEGER,
  decided_by TEXT, decided_at INTEGER, decision_note TEXT)`);

const router = express.Router();
const get = (id) => db.prepare('SELECT * FROM worker_requests WHERE id = ?').get(id);
const centralEmails = () => db.prepare("SELECT email FROM hr_users WHERE status = 'active' AND role = 'central_hr'").all().map(r => r.email);

// Requests visible to this user: for workers in their scope, plus (Site HR) transfers
// coming into their site, plus their own.
function visible(user) {
  const s = workerScopeSql(user, 'w');
  const extra = ROLE_SCOPE[user.role] === 'location' && user.location_id ? ' OR r.to_location_id = ?' : '';
  return db.prepare(`SELECT r.*, w.name AS worker_name, lf.name AS from_location, lt.name AS to_location, vt.name AS to_vendor
      FROM worker_requests r JOIN workers w ON w.id = r.worker_id
      LEFT JOIN locations lf ON lf.id = w.location_id LEFT JOIN locations lt ON lt.id = r.to_location_id LEFT JOIN vendors vt ON vt.id = r.to_vendor_id
      WHERE (${s.sql}${extra} OR r.raised_by = ?) ORDER BY r.raised_at DESC LIMIT 200`)
    .all(...s.args, ...(extra ? [user.location_id] : []), user.email);
}

router.get('/', requirePermission('requests.view'), (req, res) => res.json(visible(req.user)));

router.post('/', requirePermission('requests.raise'), (req, res) => {
  const b = req.body || {};
  const reason = (b.reason || '').trim();
  if (b.type !== 'transfer' && b.type !== 'exit') return res.status(400).json({ error: 'type must be "transfer" or "exit"' });
  if (!reason) return res.status(400).json({ error: 'reason is required' });
  const w = getScopedWorker(req.user, b.workerId || '');
  if (!w) return res.status(404).json({ error: 'Worker not found' });
  if (w.status !== 'approved') return res.status(400).json({ error: 'Only an active (approved) worker can be transferred or exited' });
  if (db.prepare("SELECT 1 FROM worker_requests WHERE worker_id = ? AND type = ? AND status IN ('pending', 'accepted')").get(w.id, b.type)) {
    return res.status(409).json({ error: `There is already an open ${b.type} request for this worker` });
  }
  if (b.type === 'transfer') {
    const loc = b.toLocationId ? db.prepare('SELECT id FROM locations WHERE id = ?').get(b.toLocationId) : null;
    const ven = b.toVendorId ? db.prepare('SELECT id FROM vendors WHERE id = ?').get(b.toVendorId) : null;
    if (!loc && !ven) return res.status(400).json({ error: 'Pick the new location and/or vendor' });
    if ((b.toLocationId || w.location_id) === w.location_id && (b.toVendorId || w.vendor_id) === w.vendor_id) return res.status(400).json({ error: 'Nothing to change' });
  }
  if (b.exitDate && !/^\d{4}-\d{2}-\d{2}$/.test(b.exitDate)) return res.status(400).json({ error: 'exitDate must be YYYY-MM-DD' });
  const id = crypto.randomUUID();
  // A transfer within the same site (vendor change only) needs no new-site acceptance.
  const needsSite = b.type === 'transfer' && b.toLocationId && b.toLocationId !== w.location_id;
  db.prepare(`INSERT INTO worker_requests (id, worker_id, type, to_location_id, to_vendor_id, exit_date, blacklist_suggested, reason, status, raised_by, raised_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, w.id, b.type, b.toLocationId || null, b.toVendorId || null, b.exitDate || null, b.blacklist ? 1 : 0, reason,
      needsSite ? 'pending' : 'accepted', req.user.email, Date.now());
  addAudit(req.user.email, `request_${b.type}`, `${w.name}: ${reason}`);
  if (b.type === 'exit') {
    // "Exit informed same day" — Central HR is told immediately.
    sendEmail(centralEmails(), `TSG Workforce: exit request — ${w.name}`,
      `${req.user.name || req.user.email} reports that ${w.name} is leaving${b.exitDate ? ` on ${b.exitDate}` : ''}.\nReason: ${reason}${b.blacklist ? '\nMisconduct reported — blacklisting suggested.' : ''}\n\nOpen TSG Workforce → Requests to deactivate.`);
  }
  res.status(201).json(get(id));
});

// Site HR of the new location accepts the incoming worker.
router.post('/:id/accept', requirePermission('requests.raise'), (req, res) => {
  const r = get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  if (r.type !== 'transfer' || r.status !== 'pending') return res.status(400).json({ error: 'Only a pending transfer can be accepted' });
  if (!(req.user.role === 'site_hr' && req.user.location_id === r.to_location_id) && req.user.role !== 'central_hr') {
    return res.status(403).json({ error: 'Only the Site HR of the new location can accept this transfer' });
  }
  db.prepare("UPDATE worker_requests SET status = 'accepted', accepted_by = ?, accepted_at = ? WHERE id = ?").run(req.user.email, Date.now(), r.id);
  addAudit(req.user.email, 'accept_transfer', r.worker_id);
  res.json(get(r.id));
});

// Central HR carries it out (or rejects it).
router.post('/:id/complete', requirePermission('workers.manage'), (req, res) => {
  const r = get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  if (r.status !== 'accepted' && !(r.type === 'exit' && r.status === 'pending')) {
    return res.status(400).json({ error: r.status === 'pending' ? 'Waiting for the new site\'s Site HR to accept' : `Request is already ${r.status}` });
  }
  const w = getScopedWorker(req.user, r.worker_id);
  if (!w) return res.status(404).json({ error: 'Worker not found' });
  const b = req.body || {};
  const reason = `${r.reason} (requested by ${r.raised_by})`;
  const out = r.type === 'transfer'
    ? performTransfer(w, req.user, { locationId: r.to_location_id, vendorId: r.to_vendor_id, reason })
    : performExit(w, req.user, { exitDate: r.exit_date, reason, blacklist: b.blacklist !== undefined ? !!b.blacklist : !!r.blacklist_suggested });
  if (out.error) return res.status(400).json({ error: out.error });
  db.prepare("UPDATE worker_requests SET status = 'done', decided_by = ?, decided_at = ? WHERE id = ?").run(req.user.email, Date.now(), r.id);
  res.json({ request: get(r.id), worker: out.worker });
});

router.post('/:id/reject', requirePermission('requests.raise'), (req, res) => {
  const r = get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  if (r.status === 'done' || r.status === 'rejected') return res.status(400).json({ error: `Request is already ${r.status}` });
  const note = ((req.body || {}).reason || '').trim();
  if (!note) return res.status(400).json({ error: 'reason is required' });
  const mayReject = req.user.role === 'central_hr' || (req.user.role === 'site_hr' && r.type === 'transfer' && req.user.location_id === r.to_location_id);
  if (!mayReject) return res.status(403).json({ error: 'Only Central HR or the receiving Site HR can reject this' });
  db.prepare("UPDATE worker_requests SET status = 'rejected', decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?").run(req.user.email, Date.now(), note, r.id);
  addAudit(req.user.email, 'reject_request', `${r.type} ${r.worker_id}: ${note}`);
  res.json(get(r.id));
});

module.exports = router;

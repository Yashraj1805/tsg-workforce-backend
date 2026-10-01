const express = require('express');
const crypto = require('node:crypto');
const { db, addAudit } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Raised by site HR on a worker's behalf — workers cannot self-raise (BRD screen 10:
// "Worker cannot edit. Button calls site HR" / R13).
router.post('/', requireAuth('hr'), (req, res) => {
  const { workerId, date, reason } = req.body || {};
  if (!workerId || !date || !reason) return res.status(400).json({ error: 'workerId, date and reason are required' });
  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare('INSERT INTO regularisations (id, worker_id, date, reason, maker, status, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, workerId, date, reason, req.auth.name || req.auth.email, 'pending', now);
  addAudit(req.auth.email, 'raise_regularisation', `${date} for worker ${workerId}: ${reason}`);
  res.status(201).json(db.prepare('SELECT * FROM regularisations WHERE id = ?').get(id));
});

// Worker: read-only view of their own regularisation requests (raised by site HR on
// their behalf — see the POST handler above for why workers can't raise their own).
router.get('/mine', requireAuth('worker'), (req, res) => {
  res.json(db.prepare('SELECT * FROM regularisations WHERE worker_id = ? ORDER BY created_at DESC').all(req.auth.sub));
});

router.get('/', requireAuth('hr'), (req, res) => {
  const { status } = req.query;
  const rows = status
    ? db.prepare('SELECT * FROM regularisations WHERE status = ? ORDER BY created_at DESC').all(status)
    : db.prepare('SELECT * FROM regularisations ORDER BY created_at DESC').all();
  res.json(rows);
});

// Maker and checker must be different people (BR-08).
router.post('/:id/decide', requireAuth('hr'), (req, res) => {
  const { decision } = req.body || {};
  if (decision !== 'approved' && decision !== 'rejected') return res.status(400).json({ error: 'decision must be "approved" or "rejected"' });
  const r = db.prepare('SELECT * FROM regularisations WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  if (r.status !== 'pending') return res.status(400).json({ error: `Already ${r.status}` });
  const checker = req.auth.name || req.auth.email;
  if (r.maker === checker) return res.status(403).json({ error: 'Maker and checker must be different people (BR-08) — log in as a different HR user' });

  db.prepare('UPDATE regularisations SET status = ?, checker = ?, decided_at = ? WHERE id = ?')
    .run(decision, checker, Date.now(), r.id);
  addAudit(req.auth.email, 'regularisation_' + decision, `${r.date} for worker ${r.worker_id}`);
  res.json(db.prepare('SELECT * FROM regularisations WHERE id = ?').get(r.id));
});

module.exports = router;

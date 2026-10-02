const express = require('express');
const crypto = require('node:crypto');
const { db, addAudit } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { workerScopeSql, workerIdScopeSql } = require('../rbac');
const { isLocked } = require('../services/attendance');
const gemini = require('../services/geminiClient');

const router = express.Router();

// Raised by site HR on a worker's behalf — workers cannot self-raise (BRD screen 10:
// "Worker cannot edit. Button calls site HR" / R13). The worker must be inside the
// raiser's scope, so a site HR can't raise for another site's staff.
router.post('/', requirePermission('regularisations.raise'), async (req, res) => {
  const { workerId, date, reason } = req.body || {};
  if (!workerId || !date || !reason) return res.status(400).json({ error: 'workerId, date and reason are required' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  if (isLocked(date.slice(0, 7))) return res.status(409).json({ error: `Attendance for ${date.slice(0, 7)} is locked — no corrections after month-end` });
  const scope = workerScopeSql(req.user);
  if (!db.prepare(`SELECT 1 FROM workers WHERE id = ? AND ${scope.sql}`).get(workerId, ...scope.args)) {
    return res.status(404).json({ error: 'Worker not found' });
  }
  const id = crypto.randomUUID();
  const now = Date.now();
  // AI triage (non-fatal if it fails or Gemini isn't configured — the request still
  // gets raised either way, just without the tag/note). recentCount includes this one,
  // so the approver sees "Nth this month" without having to go count the worker's history.
  let category = null, triageNote = null;
  if (gemini.isConfigured()) {
    try {
      const recentCount = 1 + db.prepare('SELECT COUNT(*) c FROM regularisations WHERE worker_id = ? AND created_at >= ?').get(workerId, now - 30 * 86400000).c;
      const r = await gemini.ask(
        `An HR attendance-correction request. Reason given by the raiser (may be in Hindi, English, or mixed): "${reason}". This worker has had ${recentCount} such request(s), including this one, in the last 30 days. Classify the reason into exactly one category. Then write one short, neutral sentence for the approving HR person — a practical read of whether this looks routine or worth a closer look, based only on the reason text and the 30-day count above, never inventing any other fact about the worker.`,
        { type: 'object', properties: {
            category: { type: 'string', enum: ['medical', 'personal', 'official_travel', 'technical_device', 'forgot_punch', 'other'] },
            triageNote: { type: 'string' },
          }, required: ['category', 'triageNote'] },
        8000
      );
      if (r.ok) { category = r.category; triageNote = r.triageNote; }
    } catch (e) { /* non-fatal */ }
  }
  db.prepare('INSERT INTO regularisations (id, worker_id, date, reason, maker, maker_id, status, created_at, reason_category, ai_triage_note) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, workerId, date, reason, req.user.name || req.user.email, req.user.id, 'pending', now, category, triageNote);
  addAudit(req.user.email, 'raise_regularisation', `${date} for worker ${workerId}: ${reason}`);
  res.status(201).json(db.prepare('SELECT * FROM regularisations WHERE id = ?').get(id));
});

// Worker: read-only view of their own regularisation requests (raised by site HR on
// their behalf — see the POST handler above for why workers can't raise their own).
router.get('/mine', requireAuth('worker'), (req, res) => {
  res.json(db.prepare('SELECT * FROM regularisations WHERE worker_id = ? ORDER BY created_at DESC').all(req.auth.sub));
});

router.get('/', requirePermission('regularisations.read'), (req, res) => {
  const { status } = req.query;
  const scope = workerIdScopeSql(req.user);
  let sql = `SELECT * FROM regularisations WHERE ${scope.sql}`;
  const args = [...scope.args];
  if (status) { sql += ' AND status = ?'; args.push(status); }
  res.json(db.prepare(sql + ' ORDER BY created_at DESC').all(...args));
});

// Maker and checker must be different people (BR-08). Compared by user id; rows raised
// before maker_id existed fall back to the old display-name comparison.
router.post('/:id/decide', requirePermission('regularisations.decide'), (req, res) => {
  const { decision } = req.body || {};
  if (decision !== 'approved' && decision !== 'rejected') return res.status(400).json({ error: 'decision must be "approved" or "rejected"' });
  const scope = workerIdScopeSql(req.user);
  const r = db.prepare(`SELECT * FROM regularisations WHERE id = ? AND ${scope.sql}`).get(req.params.id, ...scope.args);
  if (!r) return res.status(404).json({ error: 'Not found' });
  if (r.status !== 'pending') return res.status(400).json({ error: `Already ${r.status}` });
  if (isLocked(r.date.slice(0, 7))) return res.status(409).json({ error: `Attendance for ${r.date.slice(0, 7)} is locked — no corrections after month-end` });
  const checker = req.user.name || req.user.email;
  const samePerson = r.maker_id ? r.maker_id === req.user.id : r.maker === checker;
  if (samePerson) return res.status(403).json({ error: 'Maker and checker must be different people (BR-08) — log in as a different HR user' });

  db.prepare('UPDATE regularisations SET status = ?, checker = ?, checker_id = ?, decided_at = ? WHERE id = ?')
    .run(decision, checker, req.user.id, Date.now(), r.id);
  addAudit(req.user.email, 'regularisation_' + decision, `${r.date} for worker ${r.worker_id}`);
  res.json(db.prepare('SELECT * FROM regularisations WHERE id = ?').get(r.id));
});

module.exports = router;

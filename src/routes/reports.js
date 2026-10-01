// R16 (vendor side): vendor bill check — system attendance days vs invoice days per
// vendor per month, gap highlighted — plus the month-end attendance lock it depends on.
const express = require('express');
const crypto = require('node:crypto');
const { db, addAudit } = require('../db');
const { requirePermission } = require('../middleware/auth');
const { workerScopeSql, ROLE_SCOPE } = require('../rbac');
const { systemDays, daysByVendor, isLocked } = require('../services/attendance');

const router = express.Router();
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const currentMonth = () => new Date().toISOString().slice(0, 7);
const round = (n) => Math.round(n * 10) / 10;

// Vendors the caller may see: a vendor coordinator only their own; others all.
function vendorsInScope(user) {
  if (ROLE_SCOPE[user.role] === 'vendor') return db.prepare('SELECT * FROM vendors WHERE id = ?').all(user.vendor_id || '');
  return db.prepare('SELECT * FROM vendors ORDER BY name').all();
}

function billRows(user, month) {
  const totals = daysByVendor(month, workerScopeSql(user, 'w'));
  return vendorsInScope(user).map(v => {
    const sys = totals[v.id] || { days: 0, workers: new Set() };
    const inv = db.prepare('SELECT * FROM vendor_invoices WHERE vendor_id = ? AND month = ?').get(v.id, month);
    const systemDays = round(sys.days);
    const gap = inv ? round(inv.invoice_days - systemDays) : null;
    return {
      vendorId: v.id, vendorName: v.name, gstin: v.gstin, workers: sys.workers.size, systemDays,
      invoiceDays: inv ? inv.invoice_days : null, invoiceRef: inv ? inv.invoice_ref : null, amount: inv ? inv.amount : null,
      enteredBy: inv ? inv.entered_by : null,
      gap, // > 0: vendor billed more days than the system recorded
      status: !inv ? 'no_invoice' : gap > 0 ? 'overbilled' : gap < 0 ? 'underbilled' : 'match',
    };
  }).filter(r => r.systemDays > 0 || r.invoiceDays != null);
}

function csv(rows, headers) {
  const cell = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return '﻿' + [headers.map(h => cell(h[0])).join(','), ...rows.map(r => headers.map(h => cell(r[h[1]])).join(','))].join('\r\n');
}
function sendCsv(res, name, body) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send(body);
}

router.get('/vendor-bill', requirePermission('billing.read'), (req, res) => {
  const month = req.query.month || currentMonth();
  if (!MONTH_RE.test(month)) return res.status(400).json({ error: 'month must be YYYY-MM' });
  const rows = billRows(req.user, month);
  if (req.query.format === 'csv') {
    return sendCsv(res, `vendor-bill-check-${month}.csv`, csv(rows, [
      ['Vendor', 'vendorName'], ['GSTIN', 'gstin'], ['Workers', 'workers'], ['System days', 'systemDays'],
      ['Invoice days', 'invoiceDays'], ['Gap (invoice - system)', 'gap'], ['Status', 'status'], ['Invoice ref', 'invoiceRef'], ['Amount', 'amount'],
    ]));
  }
  const lock = db.prepare('SELECT * FROM attendance_locks WHERE month = ?').get(month);
  res.json({ month, locked: !!lock, lock: lock || null, rows });
});

// Day-wise detail for one vendor (the "Day-wise attendance per vendor" muster behind a bill).
router.get('/vendor-bill/:vendorId/workers', requirePermission('billing.read'), (req, res) => {
  const month = req.query.month || currentMonth();
  if (!MONTH_RE.test(month)) return res.status(400).json({ error: 'month must be YYYY-MM' });
  if (!vendorsInScope(req.user).some(v => v.id === req.params.vendorId)) return res.status(404).json({ error: 'Not found' });
  const names = Object.fromEntries(db.prepare('SELECT id, name, mobile FROM workers').all().map(w => [w.id, w]));
  const rows = [];
  for (const [workerId, { days }] of systemDays(month, workerScopeSql(req.user, 'w'))) {
    const mine = [...days].filter(([, d]) => d.vendorId === req.params.vendorId && d.value);
    if (!mine.length) continue;
    rows.push({ workerId, name: names[workerId] ? names[workerId].name : workerId, mobile: names[workerId] ? names[workerId].mobile : '',
      days: round(mine.reduce((s, [, d]) => s + d.value, 0)), dates: mine.map(([day, d]) => d.value === 1 ? day : `${day} (½)`).sort().join(' ') });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  if (req.query.format === 'csv') {
    return sendCsv(res, `vendor-days-${month}.csv`, csv(rows, [['Worker', 'name'], ['Mobile', 'mobile'], ['System days', 'days'], ['Dates', 'dates']]));
  }
  res.json({ month, rows });
});

// Finance records what the vendor invoiced. Only for a locked month — until Central HR
// locks it, the system days can still change (late corrections).
router.put('/vendor-invoices', requirePermission('billing.write'), (req, res) => {
  const { vendorId, month, invoiceRef } = req.body || {};
  const invoiceDays = Number((req.body || {}).invoiceDays);
  const amount = (req.body || {}).amount != null && (req.body || {}).amount !== '' ? Number(req.body.amount) : null;
  if (!MONTH_RE.test(month || '')) return res.status(400).json({ error: 'month must be YYYY-MM' });
  if (!db.prepare('SELECT 1 FROM vendors WHERE id = ?').get(vendorId || '')) return res.status(400).json({ error: 'Unknown vendor' });
  if (!Number.isFinite(invoiceDays) || invoiceDays < 0) return res.status(400).json({ error: 'invoiceDays must be a number, 0 or more' });
  if (amount != null && !Number.isFinite(amount)) return res.status(400).json({ error: 'amount must be a number' });
  if (!isLocked(month)) return res.status(409).json({ error: `Attendance for ${month} is not locked yet — Central HR locks the month first, then invoices are checked against it` });
  const old = db.prepare('SELECT * FROM vendor_invoices WHERE vendor_id = ? AND month = ?').get(vendorId, month);
  db.prepare(`INSERT INTO vendor_invoices (id, vendor_id, month, invoice_days, invoice_ref, amount, entered_by, updated_at) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT (vendor_id, month) DO UPDATE SET invoice_days = excluded.invoice_days, invoice_ref = excluded.invoice_ref, amount = excluded.amount, entered_by = excluded.entered_by, updated_at = excluded.updated_at`)
    .run(old ? old.id : crypto.randomUUID(), vendorId, month, invoiceDays, invoiceRef || null, amount, req.user.email, Date.now());
  addAudit(req.user.email, 'vendor_invoice', `${month} vendor ${vendorId}: invoice days ${old ? old.invoice_days + ' -> ' : ''}${invoiceDays}${invoiceRef ? ` (ref ${invoiceRef})` : ''}`);
  res.json(billRows(req.user, month).find(r => r.vendorId === vendorId) || null);
});

// ---- Month-end lock (proposal: "Attendance locked by 2nd, Central HR") ----
router.post('/attendance-lock', requirePermission('attendance.lock'), (req, res) => {
  const { month } = req.body || {};
  if (!MONTH_RE.test(month || '')) return res.status(400).json({ error: 'month must be YYYY-MM' });
  if (month >= currentMonth()) return res.status(400).json({ error: 'Only a finished month can be locked' });
  if (isLocked(month)) return res.status(400).json({ error: `${month} is already locked` });
  db.prepare('INSERT INTO attendance_locks (month, locked_by, locked_at) VALUES (?,?,?)').run(month, req.user.email, Date.now());
  addAudit(req.user.email, 'attendance_lock', `Locked attendance for ${month}`);
  res.json({ month, locked: true });
});

router.delete('/attendance-lock/:month', requirePermission('attendance.lock'), (req, res) => {
  const reason = ((req.body || {}).reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'reason is required to unlock a month' });
  if (!isLocked(req.params.month)) return res.status(404).json({ error: 'Month is not locked' });
  db.prepare('DELETE FROM attendance_locks WHERE month = ?').run(req.params.month);
  addAudit(req.user.email, 'attendance_unlock', `Unlocked ${req.params.month}: ${reason}`);
  res.json({ month: req.params.month, locked: false });
});

module.exports = router;

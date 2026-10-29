// R16 (vendor side): vendor bill check — system attendance days vs invoice days per
// vendor per month, gap highlighted — plus the month-end attendance lock it depends on.
const express = require('express');
const crypto = require('node:crypto');
const { db, addAudit } = require('../db');
const { requirePermission } = require('../middleware/auth');
const { workerScopeSql, ROLE_SCOPE } = require('../rbac');
const { systemDays, daysByVendor, isLocked } = require('../services/attendance');
const reports = require('../services/reports');

const router = express.Router();
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const { currentMonth } = require('../services/time');
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
// ---- R16 dashboard + Excel reports (BRD §12, §16) ----
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function readFilters(q) {
  return { brand: q.brand || null, locationId: q.locationId || null, vendorId: q.vendorId || null, jobId: q.jobId || null };
}
async function sendXlsx(res, filename, sheets) {
  const buf = await reports.toXlsx(sheets);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buf);
}

router.get('/dashboard', requirePermission('reports.read'), (req, res) => {
  const day = req.query.date || undefined;
  if (day && !DATE_RE.test(day)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  res.json(reports.dashboard(workerScopeSql(req.user, 'w'), readFilters(req.query), day));
});

// Brands / locations / vendors / jobs available as filters to this user.
router.get('/filters', requirePermission('reports.read'), (req, res) => {
  const scope = workerScopeSql(req.user, 'w');
  const locs = db.prepare(`SELECT DISTINCT l.id, l.name, l.brand FROM workers w JOIN locations l ON l.id = w.location_id WHERE ${scope.sql} ORDER BY l.name`).all(...scope.args);
  const vendors = db.prepare(`SELECT DISTINCT v.id, v.name FROM workers w JOIN vendors v ON v.id = w.vendor_id WHERE ${scope.sql} ORDER BY v.name`).all(...scope.args);
  const jobs = db.prepare('SELECT id, name FROM jobs ORDER BY sort, name').all();
  res.json({ brands: [...new Set(locs.map(l => l.brand).filter(Boolean))].sort(), locations: locs, vendors, jobs });
});

// Month-wise worker × day grid (JSON) behind the Attendance screen's monthly view - same
// computation as muster.xlsx below, just returned for the browser instead of a download.
router.get('/muster', requirePermission('reports.read'), (req, res) => {
  const month = req.query.month || currentMonth();
  if (!MONTH_RE.test(month)) return res.status(400).json({ error: 'month must be YYYY-MM' });
  res.json(reports.musterRows(workerScopeSql(req.user, 'w'), readFilters(req.query), month));
});

router.get('/attendance.xlsx', requirePermission('reports.read'), async (req, res) => {
  const { from, to } = req.query;
  if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '') || to < from) return res.status(400).json({ error: 'from and to (YYYY-MM-DD) are required' });
  if ((Date.parse(to) - Date.parse(from)) / 86400000 > 92) return res.status(400).json({ error: 'At most 3 months at a time' });
  const rows = reports.attendanceRows(workerScopeSql(req.user, 'w'), readFilters(req.query), from, to);
  addAudit(req.user.email, 'report_download', `attendance ${from}..${to} (${rows.length} rows)`);
  await sendXlsx(res, `attendance-${from}-to-${to}.xlsx`, [{ name: 'Attendance', columns: reports.ATTENDANCE_COLUMNS, rows }]);
});

router.get('/muster.xlsx', requirePermission('reports.read'), async (req, res) => {
  const month = req.query.month || currentMonth();
  if (!MONTH_RE.test(month)) return res.status(400).json({ error: 'month must be YYYY-MM' });
  const m = reports.musterRows(workerScopeSql(req.user, 'w'), readFilters(req.query), month);
  addAudit(req.user.email, 'report_download', `muster roll ${month} (${m.rows.length} workers)`);
  await sendXlsx(res, `muster-roll-${month}.xlsx`, [{ name: `Muster ${month}`, ...reports.musterSheet(m) }]);
});

router.get('/vendor-bill.xlsx', requirePermission('billing.read'), async (req, res) => {
  const month = req.query.month || currentMonth();
  if (!MONTH_RE.test(month)) return res.status(400).json({ error: 'month must be YYYY-MM' });
  const rows = billRows(req.user, month);
  await sendXlsx(res, `vendor-bill-check-${month}.xlsx`, [{ name: 'Vendor bill check', columns: [
    { header: 'Vendor', key: 'vendorName', width: 24 }, { header: 'GSTIN', key: 'gstin', width: 18 }, { header: 'Workers', key: 'workers', width: 9 },
    { header: 'System days', key: 'systemDays', width: 12 }, { header: 'Invoice days', key: 'invoiceDays', width: 12 },
    { header: 'Gap (invoice − system)', key: 'gap', width: 20 }, { header: 'Status', key: 'status', width: 14 }, { header: 'Invoice ref', key: 'invoiceRef', width: 14 },
  ], rows }]);
});

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

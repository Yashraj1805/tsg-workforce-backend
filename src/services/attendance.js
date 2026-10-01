// Payable attendance days, computed only from server-saved punches and approved
// missed-punch corrections (BRD §6: "Vendors are paid only on system days").
//
// Day rule — one place to change it once the BRD's open point on half days is settled:
//   punch in + punch out, 4h or more   -> 1
//   punch in + punch out, under 4h     -> 0.5  (same threshold as the app's calendar)
//   punch in, no punch out             -> 0
//   approved missed-punch correction   -> 1  (overrides the above for that day)
// Days are UTC calendar dates, matching how punches.js decides "today" today.
const { db } = require('../db');

const HALF_DAY_HOURS = 4;

function monthRange(month) {
  const [y, m] = month.split('-').map(Number);
  return { from: Date.UTC(y, m - 1, 1), to: Date.UTC(y, m, 1) };
}

function dayValue(ins, outs) {
  if (!ins.length) return 0;
  if (!outs.length) return 0;
  const hours = (Math.max(...outs) - Math.min(...ins)) / 3600000;
  return hours >= HALF_DAY_HOURS ? 1 : 0.5;
}

// Returns Map<workerId, { vendorId, days: Map<YYYY-MM-DD, value> }> for workers matching
// `workerScope` (from rbac.workerScopeSql, aliased w). A day is billed to the vendor
// stamped on that day's punch-in (older punches without a stamp fall back to the
// worker's current vendor).
function systemDays(month, workerScope) {
  const { from, to } = monthRange(month);
  const punches = db.prepare(`SELECT p.worker_id, p.type, p.ts, COALESCE(p.vendor_id, w.vendor_id) AS vendor_id
      FROM punches p JOIN workers w ON w.id = p.worker_id
      WHERE p.result = 'ok' AND p.ts >= ? AND p.ts < ? AND ${workerScope.sql}`).all(from, to, ...workerScope.args);
  const regs = db.prepare(`SELECT r.worker_id, r.date, w.vendor_id FROM regularisations r JOIN workers w ON w.id = r.worker_id
      WHERE r.status = 'approved' AND r.date LIKE ? AND ${workerScope.sql}`).all(month + '-%', ...workerScope.args);

  const byWorkerDay = new Map();
  for (const p of punches) {
    const day = new Date(p.ts).toISOString().slice(0, 10);
    const key = p.worker_id + '|' + day;
    if (!byWorkerDay.has(key)) byWorkerDay.set(key, { workerId: p.worker_id, day, vendorId: null, ins: [], outs: [] });
    const e = byWorkerDay.get(key);
    if (p.type === 'in') { e.ins.push(p.ts); e.vendorId = e.vendorId || p.vendor_id; } else e.outs.push(p.ts);
  }
  const out = new Map();
  const put = (workerId, vendorId, day, value) => {
    if (!out.has(workerId)) out.set(workerId, { days: new Map() });
    out.get(workerId).days.set(day, { value, vendorId });
  };
  for (const e of byWorkerDay.values()) put(e.workerId, e.vendorId, e.day, dayValue(e.ins, e.outs));
  for (const r of regs) {
    const existing = out.get(r.worker_id) && out.get(r.worker_id).days.get(r.date);
    put(r.worker_id, (existing && existing.vendorId) || r.vendor_id, r.date, 1);
  }
  return out;
}

// Totals per vendor: { vendorId: { days, workers: Set } }
function daysByVendor(month, workerScope) {
  const totals = {};
  for (const [workerId, { days }] of systemDays(month, workerScope)) {
    for (const { value, vendorId } of days.values()) {
      if (!vendorId || !value) continue;
      totals[vendorId] = totals[vendorId] || { days: 0, workers: new Set() };
      totals[vendorId].days += value;
      totals[vendorId].workers.add(workerId);
    }
  }
  return totals;
}

function isLocked(month) {
  return !!db.prepare('SELECT 1 FROM attendance_locks WHERE month = ?').get(month);
}

module.exports = { systemDays, daysByVendor, isLocked, monthRange };

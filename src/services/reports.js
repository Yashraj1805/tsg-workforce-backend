// Report data shared by the dashboard, the Excel downloads (R16) and the automatic emails
// (R15). Every query takes the caller's worker scope (rbac.workerScopeSql, alias w), so a
// Team Lead's report only ever contains their site, a vendor coordinator's only their vendor.
// BRD §16: "All reports can be filtered by date, brand, location, vendor and job".
const ExcelJS = require('exceljs');
const { db } = require('../db');
const { dayOf, today, sqlDay } = require('./time');

const HALF_DAY_HOURS = 4; // same threshold as the app calendar and the billing rule

// filters: { brand, locationId, vendorId, jobId } → extra SQL on workers w / locations l
function filterSql(f = {}) {
  const parts = [], args = [];
  if (f.brand) { parts.push('l.brand = ?'); args.push(f.brand); }
  if (f.locationId) { parts.push('w.location_id = ?'); args.push(f.locationId); }
  if (f.vendorId) { parts.push('w.vendor_id = ?'); args.push(f.vendorId); }
  if (f.jobId) { parts.push('w.job_id = ?'); args.push(f.jobId); }
  return { sql: parts.length ? ' AND ' + parts.join(' AND ') : '', args };
}

function activeWorkers(scope, f) {
  const fs = filterSql(f);
  return db.prepare(`SELECT w.*, l.name AS location_name, l.brand AS brand, l.weekly_off AS weekly_off, v.name AS vendor_name
      FROM workers w LEFT JOIN locations l ON l.id = w.location_id LEFT JOIN vendors v ON v.id = w.vendor_id
      WHERE w.status = 'approved' AND ${scope.sql}${fs.sql} ORDER BY l.name, v.name, w.name`).all(...scope.args, ...fs.args);
}

// BRD §12 dashboard: "Live count of active, punched in, not punched, punched out and blocked.
// Filters for brand and vendor."
function dashboard(scope, f, day) {
  const d = day || today();
  const workers = activeWorkers(scope, f);
  const ids = new Set(workers.map(w => w.id));
  const punches = db.prepare(`SELECT worker_id, type, result FROM punches WHERE ${sqlDay('ts')} = ?`).all(d).filter(p => ids.has(p.worker_id));
  const inSet = new Set(punches.filter(p => p.result === 'ok' && p.type === 'in').map(p => p.worker_id));
  const outSet = new Set(punches.filter(p => p.result === 'ok' && p.type === 'out').map(p => p.worker_id));
  const byLocation = {}, byVendor = {};
  for (const w of workers) {
    const k = w.location_name || '—', vk = w.vendor_name || '—';
    byLocation[k] = byLocation[k] || { location: k, active: 0, punchedIn: 0, punchedOut: 0 };
    byLocation[k].active++;
    byVendor[vk] = byVendor[vk] || { vendor: vk, active: 0, punchedIn: 0, punchedOut: 0 };
    byVendor[vk].active++;
    if (inSet.has(w.id)) { byLocation[k].punchedIn++; byVendor[vk].punchedIn++; }
    if (outSet.has(w.id)) { byLocation[k].punchedOut++; byVendor[vk].punchedOut++; }
  }
  return {
    date: d,
    active: workers.length,
    punchedIn: inSet.size,
    notPunched: workers.filter(w => !inSet.has(w.id)).length,
    punchedOut: outSet.size,
    stillIn: [...inSet].filter(id => !outSet.has(id)).length,
    blocked: punches.filter(p => p.result === 'blocked').length,
    pendingApprovals: db.prepare(`SELECT COUNT(*) n FROM workers w LEFT JOIN locations l ON l.id = w.location_id WHERE w.status = 'pending' AND ${scope.sql}${filterSql(f).sql}`).get(...scope.args, ...filterSql(f).args).n,
    byLocation: Object.values(byLocation),
    byVendor: Object.values(byVendor),
  };
}

function dayStatus(ins, outs, regApproved, isOff) {
  if (ins.length && outs.length) {
    const hours = Math.round((Math.max(...outs) - Math.min(...ins)) / 360000) / 10;
    return { status: hours >= HALF_DAY_HOURS ? 'Present' : 'Half day', hours };
  }
  if (regApproved) return { status: 'Present (regularised)', hours: null };
  if (ins.length) return { status: 'Missed punch-out', hours: null };
  return { status: isOff ? 'Weekly off' : 'Absent', hours: null };
}

// Day-wise rows for every active worker in scope, from..to inclusive ('YYYY-MM-DD').
function attendanceRows(scope, f, from, to) {
  const workers = activeWorkers(scope, f);
  if (!workers.length) return [];
  const ids = workers.map(w => w.id);
  const ph = ids.map(() => '?').join(',');
  const punches = db.prepare(`SELECT worker_id, type, ts, offline FROM punches WHERE result = 'ok' AND worker_id IN (${ph}) AND ${sqlDay('ts')} BETWEEN ? AND ?`).all(...ids, from, to);
  const regs = db.prepare(`SELECT worker_id, date FROM regularisations WHERE status = 'approved' AND worker_id IN (${ph}) AND date BETWEEN ? AND ?`).all(...ids, from, to);
  const key = (w, d) => w + '|' + d;
  const byKey = new Map();
  for (const p of punches) {
    const k = key(p.worker_id, dayOf(p.ts));
    if (!byKey.has(k)) byKey.set(k, { ins: [], outs: [], offline: false });
    const e = byKey.get(k); (p.type === 'in' ? e.ins : e.outs).push(p.ts); if (p.offline) e.offline = true;
  }
  const regSet = new Set(regs.map(r => key(r.worker_id, r.date)));
  const days = [];
  for (let t = Date.parse(from + 'T00:00:00Z'); t <= Date.parse(to + 'T00:00:00Z'); t += 86400000) days.push(new Date(t).toISOString().slice(0, 10));
  const fmt = (ts) => ts ? new Date(ts + 330 * 60000).toISOString().slice(11, 16) : '';
  const rows = [];
  for (const w of workers) {
    const joined = dayOf(w.created_at || 0);
    for (const d of days) {
      if (d < joined || d > today()) continue;
      const e = byKey.get(key(w.id, d)) || { ins: [], outs: [] };
      const dow = new Date(d + 'T12:00:00Z').getUTCDay();
      const st = dayStatus(e.ins, e.outs, regSet.has(key(w.id, d)), w.weekly_off === dow);
      if (d === today() && st.status === 'Absent') st.status = 'Not punched yet';
      rows.push({
        date: d, worker: w.name, mobile: w.mobile, job: w.designation || '', vendor: w.vendor_name || '', location: w.location_name || '', brand: w.brand || '',
        in: fmt(e.ins.length ? Math.min(...e.ins) : null), out: fmt(e.outs.length ? Math.max(...e.outs) : null),
        hours: st.hours, status: st.status, offline: e.offline ? 'yes' : '', reportingManager: w.reporting_manager_email || '',
      });
    }
  }
  return rows;
}

// Monthly muster roll: one row per worker, one column per day (P / ½ / M / A / O / R).
function musterRows(scope, f, month) {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const rows = attendanceRows(scope, f, `${month}-01`, `${month}-${String(last).padStart(2, '0')}`);
  const code = { 'Present': 'P', 'Half day': '½', 'Missed punch-out': 'M', 'Absent': 'A', 'Weekly off': 'O', 'Present (regularised)': 'R', 'Not punched yet': '' };
  const byWorker = new Map();
  for (const r of rows) {
    const k = r.mobile;
    if (!byWorker.has(k)) byWorker.set(k, { worker: r.worker, mobile: r.mobile, job: r.job, vendor: r.vendor, location: r.location, days: {}, present: 0 });
    const e = byWorker.get(k);
    e.days[Number(r.date.slice(8))] = code[r.status] ?? '';
    e.present += r.status === 'Present' || r.status === 'Present (regularised)' ? 1 : r.status === 'Half day' ? 0.5 : 0;
  }
  return { days: last, rows: [...byWorker.values()] };
}

const HEADER_STYLE = { font: { bold: true, color: { argb: 'FFFFFFFF' } }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E40AF' } } };

// sheets: [{ name, columns: [{ header, key, width }], rows }] → Buffer (.xlsx)
async function toXlsx(sheets) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'TSG Workforce';
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name.slice(0, 31));
    ws.columns = s.columns;
    ws.addRows(s.rows);
    ws.getRow(1).eachCell(c => { c.font = HEADER_STYLE.font; c.fill = HEADER_STYLE.fill; });
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    if (s.rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: s.columns.length } };
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const ATTENDANCE_COLUMNS = [
  { header: 'Date', key: 'date', width: 12 }, { header: 'Worker', key: 'worker', width: 24 }, { header: 'Mobile', key: 'mobile', width: 13 },
  { header: 'Job', key: 'job', width: 16 }, { header: 'Vendor', key: 'vendor', width: 20 }, { header: 'Location', key: 'location', width: 20 },
  { header: 'Brand', key: 'brand', width: 14 }, { header: 'In', key: 'in', width: 8 }, { header: 'Out', key: 'out', width: 8 },
  { header: 'Hours', key: 'hours', width: 8 }, { header: 'Status', key: 'status', width: 20 }, { header: 'Offline punch', key: 'offline', width: 12 },
];
function musterSheet(m) {
  const cols = [{ header: 'Worker', key: 'worker', width: 22 }, { header: 'Mobile', key: 'mobile', width: 13 }, { header: 'Job', key: 'job', width: 14 },
    { header: 'Vendor', key: 'vendor', width: 18 }, { header: 'Location', key: 'location', width: 18 }];
  for (let d = 1; d <= m.days; d++) cols.push({ header: String(d), key: 'd' + d, width: 4 });
  cols.push({ header: 'Days present', key: 'present', width: 12 });
  return { columns: cols, rows: m.rows.map(r => { const o = { ...r }; for (let d = 1; d <= m.days; d++) o['d' + d] = r.days[d] ?? ''; return o; }) };
}

module.exports = { dashboard, attendanceRows, musterRows, musterSheet, toXlsx, ATTENDANCE_COLUMNS, filterSql };

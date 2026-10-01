// Query builders behind every report in R15/R16 — plain functions returning plain row
// data, used by both the scheduled emails (scheduler.js) and the on-demand Excel export
// route (routes/reports.js), so each report's logic exists in exactly one place.
const { db } = require('../db');

function todayRange(ts) {
  const d = new Date(ts || Date.now());
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return { start, end: start + 24 * 3600000 };
}

function monthRange(monthStr) {
  // monthStr: 'YYYY-MM', defaults to the current month
  const [y, m] = (monthStr || new Date().toISOString().slice(0, 7)).split('-').map(Number);
  const start = new Date(y, m - 1, 1).getTime();
  return { start, end: new Date(y, m, 1).getTime() };
}

function statusForWorkerToday(workerId, punchesToday) {
  const mine = punchesToday.filter(p => p.worker_id === workerId && p.result === 'ok');
  const inP = mine.find(p => p.type === 'in');
  const outP = [...mine].reverse().find(p => p.type === 'out');
  if (!inP) return { status: 'absent', inTime: null, outTime: null };
  if (!outP) return { status: 'missed_punch_out', inTime: inP.ts, outTime: null };
  return { status: 'present', inTime: inP.ts, outTime: outP.ts };
}

function hrEmails() {
  // Reports whose BRD recipient (Security, Location Head, Finance, Vendor...) doesn't
  // have its own login yet — that's the still-unbuilt 9-role system (BRD section 5) —
  // fall back to every HR user rather than silently dropping the report.
  return db.prepare('SELECT email FROM hr_users').all().map(r => r.email).filter(Boolean);
}

function myTeamToday(managerEmail) {
  const { start, end } = todayRange();
  const workers = db.prepare("SELECT * FROM workers WHERE manager_email = ? AND status = 'approved'").all(managerEmail);
  const punches = db.prepare('SELECT * FROM punches WHERE ts >= ? AND ts < ?').all(start, end);
  return workers.map(w => ({ name: w.name, mobile: w.mobile, ...statusForWorkerToday(w.id, punches) }));
}

function allManagerEmails() {
  return db.prepare("SELECT DISTINCT manager_email, manager_name FROM workers WHERE manager_email IS NOT NULL AND manager_email != '' AND status = 'approved'").all();
}

function siteSummary(locationId) {
  const { start, end } = todayRange();
  const workers = locationId
    ? db.prepare("SELECT * FROM workers WHERE location_id = ? AND status = 'approved'").all(locationId)
    : db.prepare("SELECT * FROM workers WHERE status = 'approved'").all();
  const punches = db.prepare('SELECT * FROM punches WHERE ts >= ? AND ts < ?').all(start, end);
  return workers.map(w => {
    const v = w.vendor_id ? db.prepare('SELECT name FROM vendors WHERE id = ?').get(w.vendor_id) : null;
    return { name: w.name, vendor: v ? v.name : '', designation: w.designation || '', ...statusForWorkerToday(w.id, punches) };
  });
}

function missedPunchOut() {
  const { start, end } = todayRange();
  const punches = db.prepare("SELECT * FROM punches WHERE ts >= ? AND ts < ? AND result = 'ok' ORDER BY ts").all(start, end);
  const openIn = {};
  for (const p of punches) {
    if (p.type === 'in') openIn[p.worker_id] = p;
    else if (p.type === 'out') delete openIn[p.worker_id];
  }
  return Object.entries(openIn).map(([workerId, p]) => {
    const w = db.prepare('SELECT name, mobile FROM workers WHERE id = ?').get(workerId);
    return { name: w ? w.name : workerId, mobile: w ? w.mobile : '', inTime: p.ts };
  });
}

function blockedPunchesSince(sinceTs) {
  const rows = db.prepare("SELECT * FROM punches WHERE result = 'blocked' AND ts >= ? ORDER BY ts DESC").all(sinceTs);
  return rows.map(p => {
    const w = db.prepare('SELECT name FROM workers WHERE id = ?').get(p.worker_id);
    return { name: w ? w.name : p.worker_id, type: p.type, reason: p.reason || '', distanceM: p.distance_m, ts: p.ts };
  });
}

function pendingApprovals() {
  return db.prepare("SELECT name, mobile, created_at FROM workers WHERE status = 'pending' ORDER BY created_at").all();
}

function weeklySummary() {
  const end = Date.now();
  const start = end - 7 * 24 * 3600000;
  const locations = db.prepare('SELECT * FROM locations').all();
  return locations.map((loc) => {
    const workerIds = db.prepare("SELECT id FROM workers WHERE location_id = ? AND status = 'approved'").all(loc.id).map(w => w.id);
    if (!workerIds.length) return { location: loc.name, attendancePercent: 0 };
    const placeholders = workerIds.map(() => '?').join(',');
    const row = db.prepare(
      `SELECT COUNT(DISTINCT worker_id || '-' || date(ts / 1000, 'unixepoch')) as c FROM punches
       WHERE type = 'in' AND result = 'ok' AND ts >= ? AND ts < ? AND worker_id IN (${placeholders})`
    ).get(start, end, ...workerIds);
    const possibleDays = workerIds.length * 7;
    return { location: loc.name, attendancePercent: possibleDays ? Math.round((row.c / possibleDays) * 100) : 0 };
  });
}

function musterRoll(monthStr) {
  const { start, end } = monthRange(monthStr);
  const workers = db.prepare("SELECT * FROM workers WHERE status = 'approved'").all();
  return workers.map((w) => {
    const placeholder = db.prepare(
      "SELECT COUNT(DISTINCT date(ts / 1000, 'unixepoch')) as c FROM punches WHERE worker_id = ? AND type = 'in' AND result = 'ok' AND ts >= ? AND ts < ?"
    ).get(w.id, start, end);
    const v = w.vendor_id ? db.prepare('SELECT name FROM vendors WHERE id = ?').get(w.vendor_id) : null;
    return { name: w.name, vendor: v ? v.name : '', daysPresent: placeholder.c };
  });
}

function vendorBillCheck(monthStr) {
  const { start, end } = monthRange(monthStr);
  const vendors = db.prepare('SELECT * FROM vendors').all();
  return vendors.map((v) => {
    const workerIds = db.prepare("SELECT id FROM workers WHERE vendor_id = ? AND status = 'approved'").all(v.id).map(w => w.id);
    let systemDays = 0;
    if (workerIds.length) {
      const placeholders = workerIds.map(() => '?').join(',');
      systemDays = db.prepare(
        `SELECT COUNT(DISTINCT worker_id || '-' || date(ts / 1000, 'unixepoch')) as c FROM punches
         WHERE type = 'in' AND result = 'ok' AND ts >= ? AND ts < ? AND worker_id IN (${placeholders})`
      ).get(start, end, ...workerIds).c;
    }
    return { vendor: v.name, systemDays };
  });
}

module.exports = {
  todayRange, monthRange, hrEmails, allManagerEmails,
  myTeamToday, siteSummary, missedPunchOut, blockedPunchesSince,
  pendingApprovals, weeklySummary, musterRoll, vendorBillCheck,
};

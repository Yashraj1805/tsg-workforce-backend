// Automatic emails (BRD R15, §16). Each report is built per audience (a manager gets only
// their own team, a Site HR only their site), with an Excel attachment, and sent on its
// schedule in IST. Central HR can switch each report on/off, change its time and add
// receivers (e.g. Purchase for the vendor bill check) — "Set once by central HR".
// Blocked punches go out immediately from services/alerts.js, not from here.
// R21: the manager's daily email is also sent as a WhatsApp message when that manager has
// a mobile number on their admin account and WATI is configured.
const crypto = require('node:crypto');
const { db, addAudit } = require('../db');
const { sendEmail, sendWhatsApp } = require('./notify');
const reports = require('./reports');
const { daysByVendor } = require('./attendance');
const { today, dayOf } = require('./time');

db.exec(`CREATE TABLE IF NOT EXISTS email_settings (key TEXT PRIMARY KEY, enabled INTEGER NOT NULL, time TEXT NOT NULL, weekday INTEGER, extra_recipients TEXT, updated_by TEXT, updated_at INTEGER)`);
db.exec(`CREATE TABLE IF NOT EXISTS email_runs (id TEXT PRIMARY KEY, report TEXT NOT NULL, period TEXT NOT NULL, ran_at INTEGER NOT NULL, trigger TEXT, messages INTEGER, sent INTEGER, note TEXT)`);
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS email_runs_period ON email_runs(report, period) WHERE trigger = \'schedule\'');

// BRD §16 table. schedule: daily | weekly (weekday 1 = Monday) | monthly (1st of month).
const REPORTS = [
  { key: 'my_team', title: 'My team today', to: 'Each reporting manager (+ WhatsApp copy)', schedule: 'daily', time: '10:30', shows: 'Own staff: present with in-time, absent, not punched' },
  { key: 'site_summary', title: 'Site summary', to: 'Site HR, location head', schedule: 'daily', time: '11:00', shows: 'Present and absent by vendor and job' },
  { key: 'missed_punch_out', title: 'Missed punch-out', to: 'Site HR, reporting manager', schedule: 'daily', time: '20:00', shows: 'Staff who punched in but not out' },
  { key: 'pending_approvals', title: 'Pending approvals', to: 'Central HR', schedule: 'daily', time: '09:00', shows: 'Workers waiting for approval' },
  { key: 'weekly_summary', title: 'Weekly summary', to: 'Central HR', schedule: 'weekly', weekday: 1, time: '09:00', shows: 'Attendance % by location and vendor' },
  { key: 'muster_roll', title: 'Muster roll', to: 'HR, Finance, vendor', schedule: 'monthly', time: '09:00', shows: 'Day-wise attendance per vendor (last month)' },
  { key: 'vendor_bill', title: 'Vendor bill check', to: 'Finance (+ Purchase as extra receiver)', schedule: 'monthly', time: '09:30', shows: 'System days per vendor (last month)' },
];

function settings() {
  const rows = Object.fromEntries(db.prepare('SELECT * FROM email_settings').all().map(r => [r.key, r]));
  return REPORTS.map(r => {
    const s = rows[r.key];
    return { ...r, enabled: s ? !!s.enabled : true, time: s ? s.time : r.time, weekday: s && s.weekday != null ? s.weekday : r.weekday,
      extraRecipients: s && s.extra_recipients ? s.extra_recipients.split(',').filter(Boolean) : [], updatedBy: s ? s.updated_by : null };
  });
}
function updateSetting(key, body, by) {
  const r = REPORTS.find(x => x.key === key);
  if (!r) return { error: 'Unknown report' };
  const cur = settings().find(x => x.key === key);
  const time = body.time ?? cur.time;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return { error: 'time must be HH:MM (24h)' };
  const weekday = body.weekday ?? cur.weekday ?? null;
  if (weekday != null && !(Number.isInteger(weekday) && weekday >= 0 && weekday <= 6)) return { error: 'weekday must be 0–6' };
  const extra = (body.extraRecipients ?? cur.extraRecipients).map(e => String(e).trim().toLowerCase()).filter(Boolean);
  const bad = extra.find(e => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
  if (bad) return { error: `Not an email address: ${bad}` };
  const enabled = body.enabled ?? cur.enabled;
  db.prepare(`INSERT INTO email_settings (key, enabled, time, weekday, extra_recipients, updated_by, updated_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT (key) DO UPDATE SET enabled = excluded.enabled, time = excluded.time, weekday = excluded.weekday, extra_recipients = excluded.extra_recipients, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .run(key, enabled ? 1 : 0, time, weekday, extra.join(','), by, Date.now());
  addAudit(by, 'email_settings', `${r.title}: ${enabled ? 'on' : 'off'} at ${time}${extra.length ? `, extra receivers ${extra.join(', ')}` : ''}`);
  return { setting: settings().find(x => x.key === key) };
}

// ---- audiences ----
const usersWithRole = (role, locationId) => db.prepare(`SELECT email, name, phone FROM hr_users WHERE status = 'active' AND role = ?${locationId ? ' AND location_id = ?' : ''}`).all(...[role, locationId].filter(Boolean));
const allScope = { sql: '1=1', args: [] };
const managerScope = (email) => ({ sql: 'lower(w.reporting_manager_email) = ?', args: [email.toLowerCase()] });
const siteScope = (locationId) => ({ sql: 'w.location_id = ?', args: [locationId] });
const vendorScope = (vendorId) => ({ sql: 'w.vendor_id = ?', args: [vendorId] });
const fmtDate = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
function lastMonth() { const [y, m] = today().split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; }
const xlsx = (name, columns, rows) => reports.toXlsx([{ name, columns, rows }]);
const attendanceSheet = (rows) => xlsx('Attendance', reports.ATTENDANCE_COLUMNS, rows);

// Each builder returns [{ to: [emails], subject, text, attachments, whatsapp?: [mobiles] }].
const BUILDERS = {
  async my_team() {
    const d = today();
    const managers = db.prepare("SELECT DISTINCT lower(reporting_manager_email) email FROM workers WHERE status = 'approved' AND reporting_manager_email IS NOT NULL").all();
    const out = [];
    for (const { email } of managers) {
      const rows = reports.attendanceRows(managerScope(email), {}, d, d);
      if (!rows.length) continue;
      const present = rows.filter(r => r.in), notIn = rows.filter(r => !r.in);
      const summary = `${present.length} present, ${notIn.length} not punched`;
      const text = [`Your team today (${fmtDate(d)}): ${summary}.`, '',
        'Present:', ...present.map(r => `  ${r.worker} — in ${r.in} (${r.location})`), '',
        'Not punched in yet:', ...(notIn.length ? notIn.map(r => `  ${r.worker} (${r.location})`) : ['  none']), '', 'Full list attached in Excel.'].join('\n');
      const hr = db.prepare("SELECT phone FROM hr_users WHERE lower(email) = ? AND status = 'active' AND phone IS NOT NULL").get(email);
      out.push({ to: [email], subject: `My team today — ${summary}`, text, attachments: [{ filename: `my-team-${d}.xlsx`, content: await attendanceSheet(rows) }], whatsapp: hr ? [hr.phone] : [] });
    }
    return out;
  },
  async site_summary() {
    const d = today();
    const out = [];
    for (const loc of db.prepare('SELECT id, name FROM locations').all()) {
      const to = [...usersWithRole('site_hr', loc.id), ...usersWithRole('location_head', loc.id)].map(u => u.email);
      if (!to.length) continue;
      const rows = reports.attendanceRows(siteScope(loc.id), {}, d, d);
      if (!rows.length) continue;
      const group = {};
      for (const r of rows) { const k = `${r.vendor} / ${r.job || '-'}`; group[k] = group[k] || { p: 0, a: 0 }; r.in ? group[k].p++ : group[k].a++; }
      const text = [`${loc.name} — ${fmtDate(d)}: ${rows.filter(r => r.in).length} present, ${rows.filter(r => !r.in).length} absent / not punched.`, '',
        'By vendor / job (present / absent):', ...Object.entries(group).map(([k, v]) => `  ${k}: ${v.p} / ${v.a}`), '', 'Full list attached in Excel.'].join('\n');
      out.push({ to, subject: `Site summary — ${loc.name} — ${fmtDate(d)}`, text, attachments: [{ filename: `site-summary-${d}.xlsx`, content: await attendanceSheet(rows) }] });
    }
    return out;
  },
  async missed_punch_out() {
    const d = today();
    const rows = reports.attendanceRows(allScope, {}, d, d).filter(r => r.status === 'Missed punch-out');
    const out = [];
    const bySite = {}, byMgr = {};
    for (const r of rows) {
      (bySite[r.location] = bySite[r.location] || []).push(r);
      if (r.reportingManager) (byMgr[r.reportingManager.toLowerCase()] = byMgr[r.reportingManager.toLowerCase()] || []).push(r);
    }
    for (const loc of db.prepare('SELECT id, name FROM locations').all()) {
      const list = bySite[loc.name];
      const to = usersWithRole('site_hr', loc.id).map(u => u.email);
      if (list && to.length) out.push({ to, subject: `Missed punch-out — ${loc.name} — ${list.length}`, text: [`Punched in but not out today (${fmtDate(d)}):`, ...list.map(r => `  ${r.worker} — in ${r.in}`)].join('\n'), attachments: [{ filename: `missed-punch-out-${d}.xlsx`, content: await attendanceSheet(list) }] });
    }
    for (const [email, list] of Object.entries(byMgr)) {
      out.push({ to: [email], subject: `Missed punch-out in your team — ${list.length}`, text: [`Punched in but not out today (${fmtDate(d)}):`, ...list.map(r => `  ${r.worker} — in ${r.in} (${r.location})`)].join('\n'), attachments: [{ filename: `missed-punch-out-${d}.xlsx`, content: await attendanceSheet(list) }] });
    }
    return out;
  },
  async pending_approvals() {
    const rows = db.prepare(`SELECT w.name, w.mobile, w.designation, w.created_at, w.face_check_status, l.name loc, v.name vendor FROM workers w
        LEFT JOIN locations l ON l.id = w.location_id LEFT JOIN vendors v ON v.id = w.vendor_id WHERE w.status = 'pending' ORDER BY w.created_at`).all();
    if (!rows.length) return [];
    const to = usersWithRole('central_hr').map(u => u.email);
    const data = rows.map(r => ({ worker: r.name, mobile: r.mobile, job: r.designation, vendor: r.vendor, location: r.loc, submitted: dayOf(r.created_at), face: r.face_check_status || '' }));
    return [{ to, subject: `${rows.length} worker(s) waiting for approval`, text: ['Waiting for your approval:', ...data.map(r => `  ${r.worker} — ${r.job || '-'} — ${r.vendor || '-'} @ ${r.location || '-'}${r.face && r.face !== 'clear' ? ' (face check needs review)' : ''}`)].join('\n'),
      attachments: [{ filename: 'pending-approvals.xlsx', content: await xlsx('Pending', [{ header: 'Worker', key: 'worker', width: 22 }, { header: 'Mobile', key: 'mobile', width: 13 }, { header: 'Job', key: 'job', width: 16 }, { header: 'Vendor', key: 'vendor', width: 18 }, { header: 'Location', key: 'location', width: 18 }, { header: 'Face check', key: 'face', width: 12 }], data) }] }];
  },
  async weekly_summary() {
    const to = usersWithRole('central_hr').map(u => u.email);
    const end = dayOf(Date.now() - 86400000), start = dayOf(Date.now() - 7 * 86400000);
    const rows = reports.attendanceRows(allScope, {}, start, end).filter(r => r.status !== 'Weekly off');
    const pct = (list) => list.length ? Math.round(100 * list.filter(r => /^Present|Half/.test(r.status)).length / list.length) : 0;
    const group = (k) => Object.entries(rows.reduce((m, r) => { (m[r[k] || '-'] = m[r[k] || '-'] || []).push(r); return m; }, {})).map(([name, list]) => ({ name, days: list.length, pct: pct(list) }));
    const byLoc = group('location'), byVendor = group('vendor');
    const text = [`Attendance ${fmtDate(start)} – ${fmtDate(end)}: ${pct(rows)}% overall.`, '', 'By location:', ...byLoc.map(g => `  ${g.name}: ${g.pct}%`), '', 'By vendor:', ...byVendor.map(g => `  ${g.name}: ${g.pct}%`)].join('\n');
    const cols = [{ header: 'Name', key: 'name', width: 24 }, { header: 'Worker-days', key: 'days', width: 12 }, { header: 'Attendance %', key: 'pct', width: 12 }];
    const buf = await reports.toXlsx([{ name: 'By location', columns: cols, rows: byLoc }, { name: 'By vendor', columns: cols, rows: byVendor }, { name: 'Detail', columns: reports.ATTENDANCE_COLUMNS, rows }]);
    return [{ to, subject: `Weekly attendance summary — ${pct(rows)}%`, text, attachments: [{ filename: `weekly-summary-${end}.xlsx`, content: buf }] }];
  },
  async muster_roll() {
    const month = lastMonth();
    const out = [];
    const hrFin = [...usersWithRole('central_hr'), ...usersWithRole('mis_finance')].map(u => u.email);
    const all = reports.musterRows(allScope, {}, month);
    if (hrFin.length && all.rows.length) out.push({ to: hrFin, subject: `Muster roll — ${month}`, text: `Day-wise attendance for ${month} (all vendors) attached.`, attachments: [{ filename: `muster-roll-${month}.xlsx`, content: await reports.toXlsx([{ name: `Muster ${month}`, ...reports.musterSheet(all) }]) }] });
    // Each vendor's coordinator gets only their own staff.
    for (const vc of db.prepare("SELECT email, vendor_id FROM hr_users WHERE status = 'active' AND role = 'vendor_coordinator' AND vendor_id IS NOT NULL").all()) {
      const m = reports.musterRows(vendorScope(vc.vendor_id), {}, month);
      if (m.rows.length) out.push({ to: [vc.email], subject: `Muster roll — ${month} — your staff`, text: `Day-wise attendance of your staff for ${month}. Invoice on these system days only.`, attachments: [{ filename: `muster-roll-${month}.xlsx`, content: await reports.toXlsx([{ name: `Muster ${month}`, ...reports.musterSheet(m) }]) }] });
    }
    return out;
  },
  async vendor_bill() {
    const month = lastMonth();
    const to = usersWithRole('mis_finance').map(u => u.email);
    const totals = daysByVendor(month, { sql: '1=1', args: [] });
    const rows = db.prepare('SELECT id, name, gstin FROM vendors ORDER BY name').all().map(v => {
      const inv = db.prepare('SELECT invoice_days FROM vendor_invoices WHERE vendor_id = ? AND month = ?').get(v.id, month);
      const sys = totals[v.id] ? Math.round(totals[v.id].days * 10) / 10 : 0;
      return { vendor: v.name, gstin: v.gstin, workers: totals[v.id] ? totals[v.id].workers.size : 0, systemDays: sys, invoiceDays: inv ? inv.invoice_days : '', gap: inv ? Math.round((inv.invoice_days - sys) * 10) / 10 : '' };
    }).filter(r => r.systemDays || r.invoiceDays !== '');
    if (!rows.length) return [];
    return [{ to, subject: `Vendor bill check — ${month}`, text: ['System days per vendor (vendors are paid only on these):', ...rows.map(r => `  ${r.vendor}: ${r.systemDays} days${r.gap !== '' ? `, invoice ${r.invoiceDays} (gap ${r.gap > 0 ? '+' : ''}${r.gap})` : ''}`)].join('\n'),
      attachments: [{ filename: `vendor-bill-check-${month}.xlsx`, content: await xlsx('Vendor bill check', [{ header: 'Vendor', key: 'vendor', width: 24 }, { header: 'GSTIN', key: 'gstin', width: 18 }, { header: 'Workers', key: 'workers', width: 9 }, { header: 'System days', key: 'systemDays', width: 12 }, { header: 'Invoice days', key: 'invoiceDays', width: 12 }, { header: 'Gap', key: 'gap', width: 8 }], rows) }] }];
  },
};

// Build + send one report. trigger: 'schedule' | 'manual'. Returns a summary.
async function runReport(key, trigger, by) {
  const s = settings().find(x => x.key === key);
  if (!s) throw new Error('Unknown report');
  const messages = await BUILDERS[key]();
  let sent = 0, recipients = 0;
  for (const m of messages) {
    const to = [...new Set([...m.to, ...s.extraRecipients])];
    recipients += to.length;
    const r = await sendEmail(to, `TSG Workforce: ${m.subject}`, m.text, m.attachments);
    if (r.ok) sent++;
    for (const mobile of m.whatsapp || []) await sendWhatsApp(mobile, `${m.subject}\n\n${m.text}`.slice(0, 3500));
  }
  const period = periodKey(s);
  const note = messages.length ? `${messages.length} message(s) to ${recipients} receiver(s)${sent < messages.length ? ` — ${messages.length - sent} not delivered (SMTP not configured or failed)` : ''}` : 'nothing to send';
  try {
    db.prepare('INSERT INTO email_runs (id, report, period, ran_at, trigger, messages, sent, note) VALUES (?,?,?,?,?,?,?,?)')
      .run(crypto.randomUUID(), key, trigger === 'schedule' ? period : `${period}#${Date.now()}`, Date.now(), trigger, messages.length, sent, note);
  } catch (e) { /* a scheduled run for this period already logged */ }
  addAudit(by || 'system', 'email_report', `${s.title} (${trigger}): ${note}`);
  return { key, messages: messages.length, recipients, sent, note, preview: messages.map(m => ({ to: m.to, subject: m.subject })) };
}

// IST clock parts for scheduling.
function istNow() {
  const d = new Date(Date.now() + 330 * 60000);
  return { date: d.toISOString().slice(0, 10), hhmm: d.toISOString().slice(11, 16), weekday: d.getUTCDay(), dayOfMonth: d.getUTCDate() };
}
function periodKey(s) {
  const n = istNow();
  return s.schedule === 'monthly' ? n.date.slice(0, 7) : n.date; // weekly is keyed by its (single) day too
}
function isDue(s, n) {
  if (!s.enabled || n.hhmm < s.time) return false;
  if (s.schedule === 'weekly' && n.weekday !== (s.weekday ?? 1)) return false;
  if (s.schedule === 'monthly' && n.dayOfMonth !== 1) return false;
  return !db.prepare("SELECT 1 FROM email_runs WHERE report = ? AND period = ? AND trigger = 'schedule'").get(s.key, periodKey(s));
}

// Called every minute. A report whose time passed today (and hasn't run for this period)
// runs once — so a server restart at 10:31 still sends the 10:30 email, but never twice.
let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const n = istNow();
    for (const s of settings()) {
      if (isDue(s, n)) {
        try { await runReport(s.key, 'schedule'); } catch (e) { console.error('[email report]', s.key, e.message); }
      }
    }
  } finally { ticking = false; }
}
function startScheduler() {
  if (process.env.DISABLE_EMAIL_SCHEDULER === '1') return;
  setInterval(tick, 60000).unref();
  setTimeout(tick, 15000).unref();
}

function recentRuns() { return db.prepare('SELECT * FROM email_runs ORDER BY ran_at DESC LIMIT 50').all(); }

module.exports = { REPORTS, settings, updateSetting, runReport, startScheduler, tick, recentRuns, isDue, istNow };

// R15: the BRD's own "Reports and automatic emails" table, each report on its own
// cron schedule. Recipients that need a role this app doesn't have distinct logins for
// yet (Security, Location Head, Finance, Vendor Coordinator — see BRD section 5) fall
// back to every HR user (reports.hrEmails()) rather than being silently dropped; that's
// a known simplification, not a guess at who should get it.
const cron = require('node-cron');
const reports = require('./reports');
const email = require('./emailService');
const whatsapp = require('./whatsappService');
const { buildExcelBuffer } = require('./excelService');

function statusLabel(s) {
  return { present: 'Present', missed_punch_out: 'Missed punch-out', absent: 'Absent' }[s] || s;
}
function fmtTime(ts) { return ts ? new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '-'; }
function tableHtml(headers, rows) {
  return `<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse">
    <tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr>
    ${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}
  </table>`;
}

async function sendMyTeamToday() {
  const managers = reports.allManagerEmails();
  for (const m of managers) {
    const rows = reports.myTeamToday(m.manager_email);
    if (!rows.length) continue;
    const present = rows.filter(r => r.status !== 'absent').length;
    const absent = rows.length - present;
    const html = `<h3>Your team today</h3><p>${present} present, ${absent} absent</p>` +
      tableHtml(['Name', 'Status', 'In'], rows.map(r => [r.name, statusLabel(r.status), fmtTime(r.inTime)]));
    const buf = await buildExcelBuffer('My team today', [{ header: 'Name', key: 'name' }, { header: 'Status', key: 'status' }, { header: 'In time', key: 'inTime' }], rows.map(r => ({ name: r.name, status: statusLabel(r.status), inTime: fmtTime(r.inTime) })));
    await email.sendEmail({ to: m.manager_email, subject: `Your team today — ${new Date().toLocaleDateString('en-IN')}`, html, attachments: [{ filename: 'my-team-today.xlsx', content: buf }] });
    await whatsapp.sendWhatsApp({ to: m.manager_email, text: `Your team today: ${present} present, ${absent} absent. Full list in your email.` }); // R21
  }
}

async function sendSiteSummary() {
  const rows = reports.siteSummary();
  if (!rows.length) return;
  const present = rows.filter(r => r.status !== 'absent').length;
  const html = `<h3>Site summary</h3><p>${present}/${rows.length} present</p>` +
    tableHtml(['Name', 'Vendor', 'Job', 'Status'], rows.map(r => [r.name, r.vendor, r.designation, statusLabel(r.status)]));
  const buf = await buildExcelBuffer('Site summary', [{ header: 'Name', key: 'name' }, { header: 'Vendor', key: 'vendor' }, { header: 'Job', key: 'designation' }, { header: 'Status', key: 'status' }], rows.map(r => ({ ...r, status: statusLabel(r.status) })));
  await email.sendEmail({ to: reports.hrEmails(), subject: `Site summary — ${new Date().toLocaleDateString('en-IN')}`, html, attachments: [{ filename: 'site-summary.xlsx', content: buf }] });
}

async function sendMissedPunchOut() {
  const rows = reports.missedPunchOut();
  if (!rows.length) return; // BRD: "If nobody is absent, no action is needed."
  const html = `<h3>Missed punch-out</h3>` + tableHtml(['Name', 'Mobile', 'Punched in at'], rows.map(r => [r.name, r.mobile, fmtTime(r.inTime)]));
  await email.sendEmail({ to: reports.hrEmails(), subject: `Missed punch-out — ${new Date().toLocaleDateString('en-IN')}`, html });
}

async function sendBlockedPunchAlert(punchRow, workerName) {
  // "Immediately" — called directly from punches.js on a block, not on a cron schedule.
  const html = `<h3>Blocked punch</h3>` + tableHtml(
    ['Name', 'Type', 'Reason', 'Distance'],
    [[workerName, punchRow.type, punchRow.reason || '', punchRow.distance_m != null ? `${punchRow.distance_m}m` : '-']]
  );
  await email.sendEmail({ to: reports.hrEmails(), subject: `Blocked punch — ${workerName}`, html });
}

async function sendPendingApprovals() {
  const rows = reports.pendingApprovals();
  if (!rows.length) return;
  const html = `<h3>Pending approvals</h3>` + tableHtml(['Name', 'Mobile', 'Submitted'], rows.map(r => [r.name, r.mobile, new Date(r.created_at).toLocaleDateString('en-IN')]));
  await email.sendEmail({ to: reports.hrEmails(), subject: `Pending approvals (${rows.length})`, html });
}

async function sendWeeklySummary() {
  const rows = reports.weeklySummary();
  const html = `<h3>Weekly attendance summary</h3>` + tableHtml(['Location', 'Attendance %'], rows.map(r => [r.location, r.attendancePercent + '%']));
  await email.sendEmail({ to: reports.hrEmails(), subject: 'Weekly attendance summary', html });
}

async function sendMusterRoll() {
  const monthStr = new Date().toISOString().slice(0, 7);
  const rows = reports.musterRoll(monthStr);
  const buf = await buildExcelBuffer('Muster roll', [{ header: 'Name', key: 'name' }, { header: 'Vendor', key: 'vendor' }, { header: 'Days present', key: 'daysPresent' }], rows);
  await email.sendEmail({ to: reports.hrEmails(), subject: `Muster roll — ${monthStr}`, html: `<p>Muster roll for ${monthStr} attached.</p>`, attachments: [{ filename: `muster-roll-${monthStr}.xlsx`, content: buf }] });
}

async function sendVendorBillCheck() {
  const monthStr = new Date().toISOString().slice(0, 7);
  const rows = reports.vendorBillCheck(monthStr);
  const buf = await buildExcelBuffer('Vendor bill check', [{ header: 'Vendor', key: 'vendor' }, { header: 'System days', key: 'systemDays' }], rows);
  await email.sendEmail({ to: reports.hrEmails(), subject: `Vendor bill check — ${monthStr}`, html: `<p>System attendance days per vendor for ${monthStr} attached. Invoice-day comparison needs the vendor's invoice, not held in this system.</p>`, attachments: [{ filename: `vendor-bill-check-${monthStr}.xlsx`, content: buf }] });
}

function start() {
  if (process.env.DISABLE_SCHEDULER === 'true') return; // for tests/local dev convenience
  cron.schedule('30 10 * * *', () => sendMyTeamToday().catch(e => console.error('[scheduler] myTeamToday', e)));
  cron.schedule('0 11 * * *', () => sendSiteSummary().catch(e => console.error('[scheduler] siteSummary', e)));
  cron.schedule('0 20 * * *', () => sendMissedPunchOut().catch(e => console.error('[scheduler] missedPunchOut', e)));
  cron.schedule('0 9 * * *', () => sendPendingApprovals().catch(e => console.error('[scheduler] pendingApprovals', e)));
  cron.schedule('0 9 * * 1', () => sendWeeklySummary().catch(e => console.error('[scheduler] weeklySummary', e)));
  cron.schedule('0 9 1 * *', () => sendMusterRoll().catch(e => console.error('[scheduler] musterRoll', e)));
  cron.schedule('5 9 1 * *', () => sendVendorBillCheck().catch(e => console.error('[scheduler] vendorBillCheck', e)));
  console.log('[scheduler] R15 automatic email jobs scheduled');
}

module.exports = {
  start,
  sendMyTeamToday, sendSiteSummary, sendMissedPunchOut, sendBlockedPunchAlert,
  sendPendingApprovals, sendWeeklySummary, sendMusterRoll, sendVendorBillCheck,
};

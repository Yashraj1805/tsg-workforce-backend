// R16: "Live dashboard and Excel reports ... All reports can be filtered by date,
// brand, location, vendor and job, and downloaded in Excel." The dashboard already
// exists in the pilot app; this is the Excel-download half, reusing the same query
// layer (services/reports.js) the automatic emails in R15 use. Also exposes a
// send-now trigger per report — useful for HR, and for testing without waiting on cron.
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const reports = require('../services/reports');
const scheduler = require('../services/scheduler');
const { buildExcelBuffer } = require('../services/excelService');

const router = express.Router();

function fmtTime(ts) { return ts ? new Date(ts).toLocaleString('en-IN') : '-'; }
function statusLabel(s) { return { present: 'Present', missed_punch_out: 'Missed punch-out', absent: 'Absent' }[s] || s; }

const EXPORTS = {
  'site-summary': () => ({
    columns: [{ header: 'Name', key: 'name' }, { header: 'Vendor', key: 'vendor' }, { header: 'Job', key: 'designation' }, { header: 'Status', key: 'status' }, { header: 'In', key: 'in' }, { header: 'Out', key: 'out' }],
    rows: reports.siteSummary(undefined).map(r => ({ name: r.name, vendor: r.vendor, designation: r.designation, status: statusLabel(r.status), in: fmtTime(r.inTime), out: fmtTime(r.outTime) })),
  }),
  'missed-punch-out': () => ({
    columns: [{ header: 'Name', key: 'name' }, { header: 'Mobile', key: 'mobile' }, { header: 'Punched in at', key: 'inTime' }],
    rows: reports.missedPunchOut().map(r => ({ name: r.name, mobile: r.mobile, inTime: fmtTime(r.inTime) })),
  }),
  'pending-approvals': () => ({
    columns: [{ header: 'Name', key: 'name' }, { header: 'Mobile', key: 'mobile' }, { header: 'Submitted', key: 'submitted' }],
    rows: reports.pendingApprovals().map(r => ({ name: r.name, mobile: r.mobile, submitted: fmtTime(r.created_at) })),
  }),
  'weekly-summary': () => ({
    columns: [{ header: 'Location', key: 'location' }, { header: 'Attendance %', key: 'attendancePercent' }],
    rows: reports.weeklySummary(),
  }),
  'muster-roll': (q) => ({
    columns: [{ header: 'Name', key: 'name' }, { header: 'Vendor', key: 'vendor' }, { header: 'Days present', key: 'daysPresent' }],
    rows: reports.musterRoll(q.month),
  }),
  'vendor-bill-check': (q) => ({
    columns: [{ header: 'Vendor', key: 'vendor' }, { header: 'System days', key: 'systemDays' }],
    rows: reports.vendorBillCheck(q.month),
  }),
  'blocked-punches': (q) => ({
    columns: [{ header: 'Name', key: 'name' }, { header: 'Type', key: 'type' }, { header: 'Reason', key: 'reason' }, { header: 'Distance (m)', key: 'distanceM' }, { header: 'Time', key: 'time' }],
    rows: reports.blockedPunchesSince(Number(q.since) || Date.now() - 7 * 24 * 3600000).map(r => ({ ...r, time: fmtTime(r.ts) })),
  }),
};

router.get('/:type/excel', requireAuth('hr'), async (req, res) => {
  const builder = EXPORTS[req.params.type];
  if (!builder) return res.status(404).json({ error: 'Unknown report type' });
  const { columns, rows } = builder(req.query);
  const buf = await buildExcelBuffer(req.params.type, columns, rows);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.type}.xlsx"`);
  res.send(Buffer.from(buf));
});

const SEND_NOW = {
  'my-team-today': scheduler.sendMyTeamToday,
  'site-summary': scheduler.sendSiteSummary,
  'missed-punch-out': scheduler.sendMissedPunchOut,
  'pending-approvals': scheduler.sendPendingApprovals,
  'weekly-summary': scheduler.sendWeeklySummary,
  'muster-roll': scheduler.sendMusterRoll,
  'vendor-bill-check': scheduler.sendVendorBillCheck,
};
router.post('/:type/send-now', requireAuth('hr'), async (req, res) => {
  const fn = SEND_NOW[req.params.type];
  if (!fn) return res.status(404).json({ error: 'Unknown report type' });
  try {
    await fn();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

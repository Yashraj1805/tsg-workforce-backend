// R15 automatic emails — Central HR sets them once (on/off, time, extra receivers) and can
// send one now to check it. See services/emailReports.js for what each report contains.
const express = require('express');
const { requirePermission } = require('../middleware/auth');
const emails = require('../services/emailReports');

const router = express.Router();

router.get('/', requirePermission('emails.manage'), (req, res) => {
  res.json({ reports: emails.settings(), runs: emails.recentRuns(),
    delivery: { email: !!process.env.SMTP_HOST, whatsapp: !!(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID) } });
});

router.put('/:key', requirePermission('emails.manage'), (req, res) => {
  const r = emails.updateSetting(req.params.key, req.body || {}, req.user.email);
  if (r.error) return res.status(400).json({ error: r.error });
  res.json(r.setting);
});

router.post('/:key/send-now', requirePermission('emails.manage'), async (req, res) => {
  if (!emails.REPORTS.some(r => r.key === req.params.key)) return res.status(404).json({ error: 'Unknown report' });
  try { res.json(await emails.runReport(req.params.key, 'manual', req.user.email)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

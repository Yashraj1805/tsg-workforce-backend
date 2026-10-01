// System Admin housekeeping: database backups (BRD §9 daily backup).
const express = require('express');
const { requirePermission } = require('../middleware/auth');
const backup = require('../services/backup');

const router = express.Router();

router.get('/backups', requirePermission('users.manage'), (req, res) => {
  res.json({ dir: backup.DIR, backups: backup.list() });
});
router.post('/backups', requirePermission('users.manage'), async (req, res) => {
  try { res.status(201).json(await backup.runBackup(req.user.email)); }
  catch (e) { res.status(500).json({ error: `Backup failed: ${e.message}` }); }
});

module.exports = router;

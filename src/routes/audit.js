const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth('hr'), (req, res) => {
  res.json(db.prepare('SELECT * FROM audit_log ORDER BY ts DESC LIMIT 300').all());
});

module.exports = router;

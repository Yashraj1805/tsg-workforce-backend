// Vehicle RC lookup for the TSG website ("enter your car number → full details").
// The website never holds the Meon key: it calls this endpoint with its own key
// (WEBSITE_API_KEY), and this server calls Meon. Each real lookup costs money, so:
//   - results are cached for VEHICLE_CACHE_DAYS (default 7): the same number again is free
//   - per-IP rate limit (express-rate-limit in server.js) stops a bot running up the bill
//   - every lookup is logged (reg no, ip, cache hit, ms) for the monthly reconciliation
const express = require('express');
const crypto = require('node:crypto');
const { db } = require('../db');
const meon = require('../services/meonClient');

const router = express.Router();
const CACHE_MS = Number(process.env.VEHICLE_CACHE_DAYS || 7) * 86400000;

db.exec(`CREATE TABLE IF NOT EXISTS vehicle_lookups (
  id TEXT PRIMARY KEY, reg_no TEXT NOT NULL, ok INTEGER NOT NULL, not_found INTEGER NOT NULL DEFAULT 0,
  vehicle_json TEXT, raw_json TEXT, source TEXT NOT NULL, ip TEXT, ms INTEGER, created_at INTEGER NOT NULL)`);
db.exec('CREATE INDEX IF NOT EXISTS vehicle_lookups_reg ON vehicle_lookups(reg_no, created_at)');

function requireWebsiteKey(req, res, next) {
  const expected = process.env.WEBSITE_API_KEY;
  if (!expected) return res.status(503).json({ error: 'Vehicle lookup is not enabled on this server (WEBSITE_API_KEY not set)' });
  const given = req.headers['x-website-key'] || '';
  const a = Buffer.from(String(given)), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Invalid website key' });
  next();
}

// POST /api/public/vehicle { regNo }  →  { ok, regNo, vehicle, cached, lookedUpAt }
router.post('/vehicle', requireWebsiteKey, async (req, res) => {
  const regNo = meon.normaliseRegNo((req.body || {}).regNo);
  if (!meon.REG_NO_RE.test(regNo)) return res.status(400).json({ error: 'Enter a valid registration number, e.g. MH12AB1234' });
  const t0 = Date.now();
  const fresh = db.prepare('SELECT * FROM vehicle_lookups WHERE reg_no = ? AND ok = 1 AND created_at > ? ORDER BY created_at DESC LIMIT 1').get(regNo, Date.now() - CACHE_MS);
  if (fresh) {
    db.prepare('INSERT INTO vehicle_lookups (id, reg_no, ok, not_found, source, ip, ms, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(crypto.randomUUID(), regNo, 1, 0, 'cache', req.ip, Date.now() - t0, Date.now());
    return res.json({ ok: true, regNo, vehicle: JSON.parse(fresh.vehicle_json), cached: true, lookedUpAt: fresh.created_at });
  }
  const r = await meon.vahanVerify(regNo);
  db.prepare('INSERT INTO vehicle_lookups (id, reg_no, ok, not_found, vehicle_json, raw_json, source, ip, ms, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(crypto.randomUUID(), regNo, r.ok ? 1 : 0, r.notFound ? 1 : 0, r.ok ? JSON.stringify(r.vehicle) : null, r.raw ? JSON.stringify(r.raw).slice(0, 20000) : null, 'meon', req.ip, Date.now() - t0, Date.now());
  if (!r.ok) return res.status(r.notFound ? 404 : 502).json({ error: r.error, notFound: !!r.notFound });
  res.json({ ok: true, regNo, vehicle: r.vehicle, cached: false, lookedUpAt: Date.now() });
});

// Usage summary for Finance: how many billable (non-cached) lookups this month.
router.get('/vehicle/usage', requireWebsiteKey, (req, res) => {
  // Month boundaries in IST (the server clock is UTC on Railway).
  const ist = new Date(Date.now() + 330 * 60000);
  const month = ist.toISOString().slice(0, 7);
  const startMs = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1) - 330 * 60000;
  const row = db.prepare("SELECT SUM(source = 'meon') AS billable, SUM(source = 'cache') AS cached, COUNT(*) AS total FROM vehicle_lookups WHERE created_at >= ?").get(startMs);
  res.json({ month, ...row });
});

module.exports = router;

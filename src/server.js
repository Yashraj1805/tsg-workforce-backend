require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { db, DATA_DIR } = require('./db'); // initialise schema on boot
const gemini = require('./services/geminiClient');
const backupSvc = require('./services/backup');
const pkg = require('../package.json');

const app = express();
app.set('trust proxy', 1); // Railway/any reverse proxy: rate limits and logs see the real client IP
app.use(helmet());
app.use(cors());

// ---- Request log: one line per request with an id, so a worker's "it didn't work at
// 9:03" can be found. Bodies are never logged (they carry photos and ID numbers).
app.use((req, res, next) => {
  req.id = crypto.randomBytes(6).toString('hex');
  res.setHeader('X-Request-Id', req.id);
  const t0 = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const who = req.user ? req.user.role : req.kiosk ? 'kiosk' : req.auth ? req.auth.role : '-';
    if (req.path !== '/health') console.log(`${req.id} ${req.method} ${req.originalUrl.split('?')[0]} ${res.statusCode} ${ms.toFixed(0)}ms ${who} ${req.ip}`);
  });
  next();
});

// ---- Body limits + rate limits. Login/OTP/pairing bodies are tiny; only image routes
// may carry megabytes. These small parsers run first so the 8 MB one never sees them.
const small = express.json({ limit: '16kb' });
const authLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 40, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many attempts from this network — try again in 15 minutes' } });
const otpLimit = rateLimit({ windowMs: 10 * 60 * 1000, limit: 12, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many OTP requests from this network — try again in 10 minutes' } });
const pairLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many pairing attempts — ask HR for a new code in 15 minutes' } });
app.use('/api/auth', small, authLimit);
app.use(['/api/auth/worker/otp/request', '/api/assisted/otp/request'], otpLimit);
app.use('/api/assisted/otp', small);
app.use('/api/kiosk/pair', small, pairLimit);
// Website vehicle lookup: tiny bodies, strict per-IP limit (each uncached call is billed).
const vehicleLimit = rateLimit({ windowMs: 60 * 60 * 1000, limit: Number(process.env.VEHICLE_LOOKUPS_PER_HOUR || 20), standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many lookups from this network - try again in an hour' } });
app.use('/api/public/vehicle', small, vehicleLimit);
app.use(express.json({ limit: '8mb' })); // selfies/photos travel as base64 data URLs for now

// ---- Health: deep enough that a monitor notices a broken DB, a full disk or a missed
// backup, not just a process that answers.
app.get('/health', (req, res) => {
  const out = { ok: true, version: pkg.version, time: new Date().toISOString(), env: process.env.NODE_ENV || 'development' };
  try { db.prepare('SELECT 1').get(); out.db = 'ok'; } catch (e) { out.ok = false; out.db = e.message; }
  try {
    const s = fs.statfsSync(DATA_DIR);
    out.diskFreeMb = Math.round(s.bavail * s.bsize / 1048576);
    if (out.diskFreeMb < 500) out.ok = false;
  } catch (e) { /* statfs unsupported */ }
  try { out.dbMb = Math.round(fs.statSync(require('node:path').join(DATA_DIR, 'tsg_workforce.sqlite')).size / 1048576); } catch (e) { /* ignore */ }
  out.lastBackupDay = backupSvc.lastBackupDay();
  out.gemini = gemini.isConfigured();
  out.devBypass = process.env.NODE_ENV !== 'production' && process.env.DEV_BYPASS === '1';
  res.status(out.ok ? 200 : 503).json(out);
});

// ---- Admin Portal (HR / Finance / MIS / managers / System Admin): a plain static site,
// not the Capacitor phone app — those roles are mostly laptop users, so they sign in here
// (same /api/auth/hr/login the HR screens in the phone app already used) instead of on a
// phone app built for workers. See admin/app.js.
const ADMIN_DIR = path.join(__dirname, '../admin');
app.use('/admin', express.static(ADMIN_DIR));
app.get(/^\/admin\/.*/, (req, res) => res.sendFile(path.join(ADMIN_DIR, 'index.html')));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/workers', require('./routes/workers'));
app.use('/api/kyc', require('./routes/kyc'));
app.use('/api/punches', require('./routes/punches'));
app.use('/api', require('./routes/masters')); // /api/vendors, /api/locations
app.use('/api/regularisations', require('./routes/regularisations'));
app.use('/api/audit', require('./routes/audit'));
app.use('/api/admin-users', require('./routes/users'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/assisted', require('./routes/assisted'));
app.use('/api/email-reports', require('./routes/emailReports'));
app.use('/api', require('./routes/kiosk')); // /api/kiosks (admin), /api/kiosk/* (gate tablet)
app.use('/api/system', require('./routes/system'));
app.use('/api/worker-requests', require('./routes/workerRequests'));
app.use('/api/assistant', require('./routes/assistant'));
app.use('/api/public', require('./routes/vehicle')); // website: /api/public/vehicle (Meon Vahan RC lookup)

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(`${req.id || '-'} ${req.method} ${req.path} 500:`, err);
  const msg = err.type === 'entity.too.large' ? 'Upload too large — retake the photo (the app should send a smaller one)'
    : err.type === 'entity.parse.failed' ? 'Malformed request body'
    : status >= 500 ? 'Internal server error' : (err.message || 'Request failed');
  res.status(status).json({ error: msg, requestId: req.id });
});

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException', (e) => { console.error('[uncaughtException]', e); process.exit(1); });

const PORT = process.env.PORT || 4000;
const server = app.listen(PORT, () => console.log(`TSG Workforce backend ${pkg.version} listening on http://localhost:${PORT} (${process.env.NODE_ENV || 'development'}${process.env.DEV_BYPASS === '1' ? ', DEV_BYPASS on' : ''})`));
if (process.env.NODE_ENV === 'production' && process.env.DEV_BYPASS === '1') console.warn('[config] DEV_BYPASS is ignored in production');
if (process.env.NODE_ENV === 'production' && !process.env.WHATSAPP_ACCESS_TOKEN && !process.env.SMS_WEBHOOK_URL) console.warn('[config] production with no WhatsApp/SMS gateway — no worker can receive an OTP');
require('./services/emailReports').startScheduler(); // R15 automatic emails
backupSvc.startBackupScheduler(); // BRD 9 daily backup (+ nightly data retention)

// Graceful stop on deploy: finish in-flight requests, flush the WAL, exit.
function shutdown(sig) {
  console.log(`[${sig}] shutting down`);
  server.close(() => { try { db.close(); } catch (e) { /* already closed */ } process.exit(0); });
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

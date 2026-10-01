# TSG Workforce — Backend

A real backend for the TSG Workforce attendance system: Express + SQLite (Node's built-in
`node:sqlite`, no native build tools needed), JWT auth, and a Setu (Pinelabs) KYC client
wired to their actual documented API.

This replaces the pilot APK's local-storage-only data with a real shared database, and
moves every security-critical check — geofence distance, GPS accuracy, one-punch-per-day,
device binding, server timestamps — onto the server, where the BRD requires them to be
(a phone can lie about its own GPS; it can't lie to a server computing distance itself).

## What's built (all BRD v1.0 requirements R01–R21 + the proposal's processes)

Every security check runs here on the server — the app only reports what the phone sees.

| Area | What it does | Where |
|---|---|---|
| Roles (BRD §5) | 8 admin roles + worker, each scoped to its site / vendor / team | `src/rbac.js` |
| Registration (R04–R06, §10) | Aadhaar Secure QR decode (UIDAI signature check), PAN photo OCR, DigiLocker OTP, name matching, duplicate + blacklist on Aadhaar / PAN / face, live one-face photo check, versioned consent, jobs master, site set by GPS, Site HR assisted registration | `routes/kyc.js`, `routes/workers.js`, `services/identityChecks.js`, `routes/assisted.js` |
| Approval (R07, R08, §12) | needs Aadhaar + PAN verified and a clean face check (or HR's note); reporting manager required | `routes/workers.js` |
| Punching (R09–R11, R19, R20) | geofence, accuracy, one in / one out (IST days), server time, device binding, face match + spoof check, fake-GPS (phone mock flag + impossible travel), Security alerts, offline punch with tamper-proof time, gate tablet | `routes/punches.js`, `routes/kiosk.js`, `services/alerts.js` |
| HR (R13, R14, §13) | missed-punch maker ≠ checker, transfer / exit / blacklist with history, phone change, manager change requests, gate check | `routes/regularisations.js`, `routes/workers.js`, `routes/workerRequests.js` |
| Reports (R15, R16, R21, §16) | live dashboard with filters, Excel attendance / muster / vendor bill, month lock, 7 scheduled emails with Excel, WhatsApp copy | `routes/reports.js`, `services/reports.js`, `services/emailReports.js` |
| Audit (R17, R18) | every change, login, logout, failed login; admin logout after 15 min idle | `services/sessions.js` |
| Data (§9) | full Aadhaar never stored; daily backup | `services/backup.js` |

**Needs something outside the code before go-live** (all wired, just switched off until set in `.env`):
- **Setu** (`SETU_*`) — real Aadhaar (DigiLocker) and PAN verification. Until then the dev-only "skip KYC" button works and real-mode rules are off.
- **UIDAI offline-verification certificate** (`AADHAAR_QR_CERT_PATH`) — without it Aadhaar QRs are decoded but their signature isn't checked.
- **SMS gateway** (`SMS_WEBHOOK_URL`) and **SMTP** (`SMTP_*`) — OTPs, approval SMS, alerts and report emails are only logged (dev servers also save emails to `data/outbox/*.eml`).
- **WATI** (`WATI_*`) — WhatsApp copy of the manager's email.
- **Gemini** (`GEMINI_API_KEY`) — face match, spoof check, photo check, PAN OCR. Not a certified biometric API (see `geminiClient.js`); swap for a licensed one when procured.
- Hosting in India on an encrypted volume, `BACKUP_DIR` on separate storage, HTTPS, and legal sign-off of the consent text (`src/registrationOptions.js`, marked DRAFT).
- Production: set `NODE_ENV=production` and `ADMIN_BOOTSTRAP_EMAILS` (see "Roles and access").

## Setup

```
npm install
cp .env.example .env
```

Edit `.env`:
- `JWT_SECRET` — generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- `SETU_CLIENT_ID` / `SETU_CLIENT_SECRET` / `SETU_PRODUCT_INSTANCE_ID` — from Setu after
  sandbox sign-up at https://bridge.setu.co/v2/ (per the email thread, Santosh asked
  Yashraj/DTM team to test the sandbox — these three values are what that unlocks).
  Until these are set, `/api/kyc/*` endpoints return a clear config error instead of
  silently failing.

```
npm start        # node src/server.js
npm run dev       # same, with --watch for auto-restart on file changes
```

Server listens on `http://localhost:4000` (override with `PORT` in `.env`).
`GET /health` confirms it's up.

## Smoke-tested (2026-09-30)

Ran the full loop manually against a live instance before calling this done:
worker OTP login → HR OTP login → HR creates vendor + location → punch attempt from
13km away correctly blocked (`outside_geofence`) → punch-in from inside the geofence
succeeds → duplicate punch-in same day correctly rejected → punch from an unregistered
second device correctly rejected → punch-out succeeds → HR attendance register and
audit log both show the real server-computed distances and timestamps → a regularisation
approval by the same HR user who raised it is correctly rejected (BR-08).

The Setu KYC endpoints (`/api/kyc/digilocker/*`, `/api/kyc/pan/verify`) could **not** be
live-tested — that needs real Setu sandbox credentials, which aren't available yet. The
request/response shapes are built directly from Setu's current docs, not memory, but
that's not the same as having actually called their sandbox.

## API surface

| Area | Endpoints |
|---|---|
| Auth | `POST /api/auth/worker/otp/{request,verify}`, `POST /api/auth/hr/otp/{request,verify}`, `POST /api/auth/logout`, `GET /api/auth/me` |
| Worker profile | `GET/PUT /api/workers/me`, `POST /api/workers/me/{submit,consent,site-from-gps}`, `GET /api/registration-options` |
| HR: workers | `GET /api/workers`, `GET /api/workers/:id[/history]`, `POST /api/workers/:id/{approve,send-back,reject,exit,transfer,reset-device}`, `PUT /api/workers/:id/reporting-manager`, `GET /api/workers/gate-check` |
| Assisted registration | `POST /api/assisted/otp/{request,verify}` (Site HR) |
| KYC | `POST /api/kyc/aadhaar-qr`, `POST /api/kyc/pan/{photo,verify}`, `POST /api/kyc/digilocker/init`, `GET /api/kyc/digilocker/:id/complete` |
| Punches | `POST /api/punches`, `POST /api/punches/offline`, `GET /api/punches/me`, `GET /api/punches` (HR) |
| Gate tablet | `GET/POST/PUT /api/kiosks`, `POST /api/kiosks/:id/new-code`, `POST /api/kiosk/pair`, `GET /api/kiosk/{me,candidates}`, `POST /api/kiosk/punch` |
| Masters | `GET/POST/PUT /api/{vendors,locations,jobs}` |
| Regularisation | `POST /api/regularisations`, `GET /api/regularisations`, `POST /api/regularisations/:id/decide` |
| Change requests | `GET/POST /api/worker-requests`, `POST /api/worker-requests/:id/{accept,complete,reject}` |
| Reports | `GET /api/reports/{dashboard,filters,attendance.xlsx,muster.xlsx,vendor-bill,vendor-bill.xlsx}`, `PUT /api/reports/vendor-invoices`, `POST/DELETE /api/reports/attendance-lock` |
| Automatic emails | `GET /api/email-reports`, `PUT /api/email-reports/:key`, `POST /api/email-reports/:key/send-now` |
| Audit / system | `GET /api/audit`, `GET/POST /api/system/backups` |
| Admin users | `GET/POST/PUT /api/admin-users`, `GET /api/admin-users/roles` |

All non-auth endpoints require `Authorization: Bearer <token>` from the matching OTP
verify call.

## Roles and access (BRD §5)

Admin-portal users have one of 8 roles (plus the worker app's own `worker` role). What each
role can do, and which workers it can see, is defined in one place — `src/rbac.js` — and
routes only ever ask for a permission (`requirePermission('workers.approve')`) and apply
the caller's scope; they never check role names directly.

| Role | Sees | Can change |
|---|---|---|
| Reporting Manager | own team (workers whose `reporting_manager_email` is theirs) | nothing |
| Site HR | own location | raise missed-punch requests |
| Central HR | all | approve/send back/reject, transfer/exit, decide missed-punch |
| Location Head | own location | nothing |
| Vendor Coordinator | own vendor | nothing |
| MIS / Finance | all | nothing |
| Security | blocked punches + audit log only | nothing |
| System Admin | no worker data | vendors, locations, admin users |

Role and scope are re-read from `hr_users` on every request, so a change or deactivation
by a System Admin applies immediately, not when the token expires. A scoped role with
no location/vendor assigned sees nothing (fails closed).

**Getting admin users in:** a System Admin creates them (`POST /api/admin-users`). The first
System Admin comes from `ADMIN_BOOTSTRAP_EMAILS` in `.env`. In production any other
unknown email is refused at login. On a dev server (`NODE_ENV` not `production`), an
unknown email is still auto-created on first login, with the role picked on the
login screen (default Central HR), so every role can be tried out.

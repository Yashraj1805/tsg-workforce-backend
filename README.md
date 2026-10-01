# TSG Workforce — Backend

A real backend for the TSG Workforce attendance system: Express + SQLite (Node's built-in
`node:sqlite`, no native build tools needed), JWT auth, and a Setu (Pinelabs) KYC client
wired to their actual documented API.

This replaces the pilot APK's local-storage-only data with a real shared database, and
moves every security-critical check — geofence distance, GPS accuracy, one-punch-per-day,
device binding, server timestamps — onto the server, where the BRD requires them to be
(a phone can lie about its own GPS; it can't lie to a server computing distance itself).

## What's real here vs. still open

**Working and tested** (see "Smoke-tested" below):
- Worker OTP login/registration, HR OTP login
- Server-side punch-in/out: recomputes distance itself, enforces the worker's *stored*
  location (not whatever the client claims), rejects bad accuracy, blocks a second
  device without HR approval, enforces one in/one out per day, stamps server time
- HR approval workflow, vendor/location masters, regularisation with maker≠checker
  enforcement (BR-08), full audit log
- Setu DigiLocker (Aadhaar) + PAN verification client, built against Setu's actual
  current API docs (confirmed 2026-09-30) — request/response shapes are real, not
  guessed. **Needs real credentials to actually call Setu** (see Setup).

**Still open — same gaps flagged earlier, now scoped against real code:**
- **Face-match/liveness on punch selfies** — not implemented. Setu's quote never
  confirmed they offer this; the `/api/punches` endpoint stores the selfie but doesn't
  verify it against anything yet. This is still the single biggest unaddressed piece.
- **OTP delivery** — OTPs are generated and verified for real, but not actually sent.
  In dev mode the code is logged to the server console and returned in the API
  response (`devOtp`). Needs an SMS gateway (worker mobiles) and email provider (HR)
  — same unsourced dependency as before.
- **The Capacitor app doesn't call this yet** — `tsg-workforce-pilot`'s `www/app.js`
  still reads/writes `localStorage` directly. Pointing it at this backend (fetch calls,
  token storage, replacing the mock KYC screen with the real DigiLocker redirect flow)
  is the next concrete step and hasn't been started.
- Mock-GPS/rooted-device detection, HRMS/Zoho/WATI integration, Excel/PDF report
  exports, hosting/backups/DPDP legal sign-off — unchanged from the earlier gap list.
- HR login currently auto-creates any verified company email as an HR user on first
  login (see `routes/auth.js`) — fine for dev testing, but restrict this to a
  pre-approved allowlist before anything resembling go-live.

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
| Auth | `POST /api/auth/worker/otp/{request,verify}`, `POST /api/auth/hr/otp/{request,verify}` |
| Worker profile | `GET/PUT /api/workers/me`, `POST /api/workers/me/submit` |
| HR: worker review | `GET /api/workers`, `POST /api/workers/:id/{approve,send-back,reject,exit,transfer}` |
| KYC | `POST /api/kyc/digilocker/init`, `GET /api/kyc/digilocker/:id/complete`, `POST /api/kyc/pan/verify` |
| Punches | `POST /api/punches` (worker), `GET /api/punches/me`, `GET /api/punches` (HR, filterable by `workerId`/`date`/`result`) |
| Masters | `GET/POST/PUT /api/vendors`, `GET/POST/PUT /api/locations` |
| Regularisation | `POST /api/regularisations`, `GET /api/regularisations`, `POST /api/regularisations/:id/decide` |
| Audit | `GET /api/audit` |

All non-auth endpoints require `Authorization: Bearer <token>` from the matching OTP
verify call.

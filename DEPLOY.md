# Deploying the backend (Railway)

The server is a single Node process with a SQLite file database. Two things make or
break a deploy:

1. **The database must live on a persistent Volume.** Railway's container disk is
   wiped on every deploy. Without a Volume, every worker, punch and photo is lost each
   time you push. Mount a Volume at `/data` and set `DATA_DIR=/data`.
2. **Node must be 22.5 or newer** — the DB uses `node:sqlite`, which doesn't exist in
   older Node. `package.json` pins `engines.node >= 22.5` so Nixpacks picks a valid one.

## One-time setup

1. Railway → **New Project → Deploy from GitHub repo** → `tsg-workforce-backend`.
2. Service → **Settings → Volumes → Add Volume**, mount path **`/data`**.
3. Service → **Variables** — add these (copy values from your local `.env`, except
   the ones marked *different in cloud*):

   | Variable | Value |
   |---|---|
   | `DATA_DIR` | `/data` *(different in cloud — must match the Volume mount)* |
   | `JWT_SECRET` | a fresh 64-hex string: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` *(different in cloud — never reuse the dev one)* |
   | `GEMINI_API_KEY` | same as local |
   | `GEMINI_MODEL` | `gemini-3.5-flash-lite` |
   | `ADMIN_BOOTSTRAP_EMAILS` | `harpreet@thesachdevgroup.com` |
   | `SETU_BASE_URL` | `https://dg-sandbox.setu.co` (until live Setu creds exist) |
   | `NODE_ENV` | see below |

   Leave `PORT` unset — Railway injects it.
4. Settings → **Networking → Generate Domain**. You get something like
   `tsg-workforce-backend-production.up.railway.app`. That URL (with `https://`) is what
   goes into the app's **Server settings** screen.
5. Deploy. Check `https://<domain>/health` returns `{"ok":true,...}`.

## NODE_ENV — read this before setting it

- **`development`** (what to use for live testing right now): OTPs are returned in
  the API response and shown on the login screen, so anyone can log in without
  SMS/WhatsApp/email being set up. New HR emails auto-create accounts. The dev
  "skip Aadhaar/PAN" button shows in registration. **Do not use this with real
  worker data you care about** — it's a test mode.
- **`production`**: OTPs are only delivered, never returned. That means
  **nobody can log in** until at least one of these is configured:
  - workers: `WATI_API_URL` + `WATI_API_TOKEN` + `WATI_OTP_TEMPLATE` (WhatsApp)
    and/or `SMS_WEBHOOK_URL` (SMS fallback)
  - HR/admin: `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM`
  Only emails in `ADMIN_BOOTSTRAP_EMAILS` or pre-created in Users can sign in.

## Pointing the app at it

In the APK: start screen → **Server settings** → paste the Railway URL → save. The
app stores it on the phone; every API call goes there. No rebuild needed.

## After each `git push` to `master`

Railway redeploys automatically. The Volume keeps the database across deploys.
Schema changes apply on boot (`addColumnIfMissing` in `src/db.js`), so no manual
migration step.

## Backups

The DB is one file: `/data/tsg_workforce.sqlite`. `src/services/backup.js` writes
dated copies under `/data/backups/`. For anything you'd be upset to lose, also copy
that file off the Volume periodically (Railway → Volume → download, or an SSH/CLI
`railway run` copy).

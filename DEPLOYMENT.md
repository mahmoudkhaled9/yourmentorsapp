# Your Mentor CRM — production deployment runbook

Architecture: **frontend** (React static files, `mentorsfront`) served by a web server; **API** (Node.js 22 LTS, ≥ 22.5 +
Express, this repository) behind HTTPS; **MySQL** 8.4+ (tested on 8.4 in CI and 9.6 locally). Everything below that is
written `<like-this>` is a **deployment requirement that has not been decided yet** — nothing here invents a provider,
domain or address.

| Value you must decide | Where it goes |
|---|---|
| Frontend address, e.g. `https://crm.<your-domain>` | API `.env` → `CORS_ORIGIN` |
| API address, e.g. `https://api.<your-domain>` (or the same domain under `/api`) | frontend `.env.production` → `VITE_API_BASE=<…>/api` |
| Server (Linux VPS or a Node-capable host), its OS user | `deploy/*.service` → `User=`, paths |
| Production MySQL host, database, account | API `.env` → `DB_*` |
| Reverse proxy in front of Node? (nginx / Apache / load balancer) | API `.env` → `TRUST_PROXY=1` only if yes |
| First administrator e-mail | API `.env` → `INITIAL_ADMIN_EMAIL` |
| Backup folder (+ off-server copy) | API `.env` → `BACKUP_DIR` |

## 1. Database (once)

Use a **new, empty** database. Never copy the development database (`mentors_crm` on a laptop holds demo data).

```sql
CREATE DATABASE <prod-db> CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER '<prod-user>'@'<api-server-host>' IDENTIFIED BY '<strong-password>';
GRANT ALL PRIVILEGES ON `<prod-db>`.* TO '<prod-user>'@'<api-server-host>';   -- this one database only, no global rights
```

The schema is created by the API itself on its first start (migrations 000–009, recorded in `schema_migrations`,
guarded by a MySQL lock so two instances cannot run them twice). A new production database receives only:
the first administrator (`INITIAL_ADMIN_*`), and the configuration lists the screens need (statuses, sources, job
titles, destinations, property types, the support contact). **No demo users, leads, cold calls, developers or projects.**
The company's users are then created in the application by that administrator.

## 2. API

```bash
# on the server, as <service-user>
git clone https://github.com/<owner>/yourmentorsapp.git /opt/mentors-crm/yourmentorsapp   # or upload the release
cd /opt/mentors-crm/yourmentorsapp
npm ci --omit=dev                                  # exact locked versions
cp .env.production.example .env && chmod 600 .env  # fill in every <...>; JWT_SECRET: npm run gen-secret
NODE_ENV=production node scripts/preflight.mjs     # must end with "PREFLIGHT: ready"
sudo cp deploy/mentors-crm-api.service /etc/systemd/system/ && sudo systemctl daemon-reload
sudo systemctl enable --now mentors-crm-api        # runs the preflight before every start, restarts on failure
journalctl -u mentors-crm-api -f                   # JSON log lines; first start prints the generated admin password
                                                   # once if INITIAL_ADMIN_PASSWORD was left empty
```

Put the API behind HTTPS (the reverse proxy or the host's TLS). Health checks for the proxy / uptime monitor:
`GET /live` (process up) and `GET /api/health` (database reachable; 503 when not). The server shuts down gracefully on
SIGTERM (stops accepting, finishes requests, closes the pool).

## 3. Frontend

```bash
cd mentorsfront
cp .env.production.example .env.production   # VITE_API_BASE=https://<api-host>/api
npm ci
npm run release        # refuses a local / non-HTTPS API; builds; checks; writes release/mentors-frontend-<time>.tar.gz
```

Upload the **contents** of the package to the web root (it includes `.htaccess`). On **Apache** (`mod_rewrite`,
`mod_headers`, `mod_mime` enabled, `AllowOverride All`) that file already provides: SPA fallback (deep links like
`/leads/12` work on refresh), `.mjs` served as JavaScript (PDF import worker), security headers (no framing, nosniff,
referrer policy) and caching (assets one year, `index.html` never). On **nginx**, reproduce the same four things:
`try_files $uri /index.html;`, `types { text/javascript mjs; }`, the `add_header` lines, and the cache rules.
The production build carries a Content-Security-Policy that allows the configured API only.

## 4. Verify the live installation (read-only, safe with real data)

```bash
cd yourmentorsapp
NODE_ENV=production node scripts/preflight.mjs --url https://<api-host>
CHECK_EMAIL=<admin-email> CHECK_PASSWORD=<admin-password> \
  node scripts/post-deploy-check.mjs --api https://<api-host> --app https://<frontend-host>
```

Both must report no problem. Then sign in in a browser, create the real users (reporting lines: director → manager →
supervisor → team leader → agent), one developer, one project, one lead, log one call — and delete the test lead.

## 5. Backups and restore

```bash
sudo cp deploy/mentors-crm-backup.service deploy/mentors-crm-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now mentors-crm-backup.timer   # daily 02:30
systemctl list-timers | grep mentors        # next run
sudo systemctl start mentors-crm-backup     # run one now; check: journalctl -u mentors-crm-backup
```

`scripts/backup-mysql.mjs`: consistent `mysqldump --single-transaction` (no locks while people work), gzip, verified
("Dump completed"), mode 600, keeps `BACKUP_RETENTION_DAYS` (default 14) and deletes only its own older files.
**Copy `BACKUP_DIR` off the server** (another disk or object storage) — a backup on the same disk does not survive the disk.

Restore (replaces the tables of the target database; take a fresh backup of it first):

```bash
node scripts/restore-backup.mjs <file.sql.gz> --confirm <DB_NAME>
```

Test a restore every few months into a **separate** database (`DB_NAME=<prod-db>_restore_test`) and compare counts.

## 6. Upgrades and rollback

Upgrade: backup → `git pull` (or upload) → `npm ci --omit=dev` → `NODE_ENV=production node scripts/preflight.mjs` →
`sudo systemctl restart mentors-crm-api` → post-deploy check. Migrations run on start; they only add or repair
(they never drop data). Frontend: `npm run release`, upload, done (old asset files may stay).

Rollback: API — check out the previous release tag/commit, `npm ci --omit=dev`, restart. A migration that already ran
stays applied (they are additive and the older code ignores the new columns). Restore the pre-upgrade backup only if
data itself must be rolled back. Frontend — upload the previous `release/*.tar.gz`.

## 7. Monitoring

- Uptime monitor on `https://<api-host>/api/health` (alert on non-200) and on the frontend URL.
- `journalctl -u mentors-crm-api` — JSON lines; `level` `error` = 5xx responses and failures (request id included;
  the same id is in the `X-Request-Id` response header and in error messages users see).
- Backups: alert if `journalctl -u mentors-crm-backup` shows a failure or no file newer than 26 h in `BACKUP_DIR`.

## 8. Security notes for operators

- `.env` is readable by the service user only; never commit it. Rotate `JWT_SECRET` to sign everybody out.
- Sessions: JWT in the browser's localStorage, `JWT_EXPIRES_IN` (default 7 days). A password change or admin reset
  revokes that user's older sessions at once; deactivating a user locks them out at once. "Log out" ends the session
  in that browser only.
- Rate limits are per process (fine for one instance; use a shared store before running several API instances).

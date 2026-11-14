# Your Mentor CRM - backend API

Node.js 22 + Express + MySQL 8. The frontend is in `../mentorsfront`.

## First run

```bash
npm install
cp .env.example .env          # then fill in DB_* (never commit .env)
npm run gen-secret -- --write # puts a strong random JWT_SECRET into .env (only that line is changed)
npm start                     # http://localhost:4001  (health: /live, /health, /api/health)
```

The server refuses to start without a real `JWT_SECRET`. Tables are created / upgraded automatically on start
(`src/migrations`, run under a MySQL lock so several instances can start together). Migrations only **add** things;
none of them drops or rewrites data. Each file says how to roll it back by hand.

## Environment variables

| Variable | Meaning |
|---|---|
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | MySQL connection (database must exist, utf8mb4) |
| `DB_POOL_SIZE`, `DB_QUEUE_LIMIT` | connection pool size / max queued queries (defaults 15 / 300) |
| `PORT`, `NODE_ENV` | HTTP port (4001), `production` enables the strict checks |
| `JWT_SECRET`, `JWT_EXPIRES_IN` | token signing secret (required, 32+ random bytes) and lifetime (`7d`) |
| `CORS_ORIGIN` | comma-separated frontend origins allowed to call the API |
| `TRUST_PROXY` | number of reverse proxies in front (so rate limits see the real client IP) |
| `INITIAL_ADMIN_EMAIL`, `INITIAL_ADMIN_PASSWORD` | first administrator, used only on an empty database |
| `TEST_DB_*` | MySQL server for `npm run test:mysql` (a fresh `*_test` database is created per run) |

## Scripts

| Command | What it does |
|---|---|
| `npm start` / `npm run dev` | start the API (dev = restart on change) |
| `npm run dev:demo` | the real API on an **in-memory** database with a demo company (port 4011, no MySQL). Accounts: `admin@demo.test`, `owner@`, `director@`, `manager@`, `leader@`, `agent@`, `agent2@`, `leader2@`, `agent3@demo.test`, password `Demo-Pass-2026` |
| `npm run check` | syntax check of every source file |
| `npm run test:unit` | unit tests (config, validation, phone rules) |
| `npm run test:integration` / `test:api` | API tests over HTTP against the real app on the production table layout (in-memory) |
| `npm run test:canonical` | the same API tests on a database built from scratch by the migrations |
| `npm run test:mysql` | the API tests on a **real MySQL**: creates `mentors_crm_test_<time>`, drops only that database afterwards |
| `npm run test:e2e` | browser tests (runs `mentorsfront`'s `test:e2e`) |
| `npm run test:all` / `verify` | check + unit + integration + canonical |
| `npm run backup` / `restore` | export / import the database |
| `npm run fix:developer-logos` | **dry run** of the developer-logo repair (the shipped data had logos swapped between developers). Add `-- --apply` to update; only rows still holding the exact wrong value are changed. Take a backup first. |

## Rules enforced by the API (not only by the screens)

- Roles: `admin` / `franchise_owner` (everything), `director`, `sales_manager`, `sales_supervisor`, `team_leader`
  (their own team, can assign inside it), `agent` (own records). The team is the `users.parent_id` tree; records outside
  your team answer 404.
- Phones: employees need an Egyptian mobile (11 digits, 010/011/012/015). Client numbers may also be international (`+`).
- Lead requirements: destinations and property types come from admin-managed lists (`/api/destinations`,
  `/api/property-types`, `/api/lead-options`); deactivated choices stay on existing leads but cannot be newly picked.
  `GET /api/leads` filters: `destinationId`, `propertyTypeId`, `purpose`, `finishing`, `delivery`, `budget`, `q`.
- Rate limits on login and on the API, request size limits, helmet security headers, JSON error bodies with field errors.

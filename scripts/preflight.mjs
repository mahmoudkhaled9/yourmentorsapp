// PRODUCTION PREFLIGHT - run on the server before the first start and after every configuration change:
//   NODE_ENV=production node scripts/preflight.mjs                          configuration + database checks
//   NODE_ENV=production node scripts/preflight.mjs --url https://api.<domain> also checks the running API over HTTPS
// Read-only: one READ ONLY transaction against the database, GET/OPTIONS requests against the API. Never prints secrets.
// Exit 0 = ready, 1 = problems (listed), 2 = cannot run.
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { loadConfig } from '../src/config.js';
import { MIGRATIONS } from '../src/migrations/index.js';

const argUrl = (() => { const i = process.argv.indexOf('--url'); return i > 0 ? process.argv[i + 1] : process.env.PUBLIC_API_URL; })();
const problems = [];
const ok = (m) => console.log(`  ok      ${m}`);
const bad = (m) => { problems.push(m); console.log(`  PROBLEM ${m}`); };
const warn = (m) => console.log(`  note    ${m}`);
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/;

console.log('1. Configuration');
const config = loadConfig(process.env);
if (!config.isProd) bad('NODE_ENV is not "production" (HSTS, strict secret checks and JSON logs stay off)');
else ok('NODE_ENV=production');
for (const e of config.errors) bad(e);
for (const w of config.warnings) warn(w);
if (!config.errors.length) ok('JWT_SECRET is set, not a known placeholder and long enough');
if (config.cors.allowAll) bad('CORS_ORIGIN=* lets any website call the API from a browser');
if (!config.cors.origins.length) bad('CORS_ORIGIN is empty: the frontend will be blocked');
for (const origin of config.cors.origins) {
  let u;
  try { u = new URL(origin); } catch { bad(`CORS_ORIGIN "${origin}" is not a URL`); continue; }
  if (u.protocol !== 'https:') bad(`CORS_ORIGIN ${origin} is not HTTPS`);
  else if (LOCAL.test(u.hostname)) bad(`CORS_ORIGIN ${origin} is a local address`);
  else ok(`CORS allows ${origin}`);
}
if (config.trustProxy) ok(`TRUST_PROXY=${config.trustProxy} (only correct when that many proxies sit in front of Node)`);
else warn('TRUST_PROXY unset: correct only if clients reach Node directly; behind nginx/Apache/a load balancer set it to 1');
if (config.seedDemoCatalog) bad('SEED_DEMO_CATALOG=true would insert the sample developers / projects into production');
if (config.initialAdmin.email === 'admin@mentors.com') warn('INITIAL_ADMIN_EMAIL is the default admin@mentors.com: set the real first administrator');

console.log('\n2. Database');
const db = config.db;
if (!db.user || !db.database) bad('DB_USER / DB_NAME are not set');
else if (db.user === 'root') bad('DB_USER=root: use a dedicated account with privileges on this one database only');
else ok(`account "${db.user}" on database "${db.database}" at ${db.host}:${db.port}`);
let conn;
if (db.user && db.database) {
  try {
    conn = await mysql.createConnection({ host: db.host, port: db.port, user: db.user, password: db.password, database: db.database, connectTimeout: 10000 });
  } catch (err) {
    bad(`cannot connect to MySQL: ${err.code ?? 'connection error'}`);
  }
}
if (conn) {
  try {
    await conn.query('START TRANSACTION READ ONLY');
    const [[v]] = await conn.query('SELECT VERSION() AS v, DATABASE() AS d');
    ok(`MySQL ${v.v}, connected to "${v.d}"`);
    const [grants] = await conn.query('SHOW GRANTS');
    const global = grants.map((g) => Object.values(g)[0]).filter((g) => / ON \*\.\* /.test(g) && !/^GRANT USAGE ON/.test(g));
    if (global.length) bad(`the account has GLOBAL privileges (${global.length} grant line(s)): restrict it to \`${db.database}\`.*`);
    else ok('the account has no global privileges');
    const [tables] = await conn.query("SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()");
    if (!Number(tables[0].n)) {
      warn('the database is empty: the first start creates the schema and the first administrator');
      if (!config.initialAdmin.email) bad('INITIAL_ADMIN_EMAIL is not set for the first start');
    } else {
      const [applied] = await conn.query('SELECT id FROM schema_migrations').catch(() => [[]]);
      const done = new Set(applied.map((r) => r.id));
      const pending = MIGRATIONS.map((m) => m.id).filter((id) => !done.has(id));
      if (pending.length) warn(`migrations still to apply at the next start: ${pending.join(', ')} (take a backup first)`);
      else ok(`all ${MIGRATIONS.length} migrations applied`);
      const [cascades] = await conn.query(`SELECT CONCAT(k.TABLE_NAME, '.', k.COLUMN_NAME) AS c FROM information_schema.KEY_COLUMN_USAGE k
        JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
        WHERE k.TABLE_SCHEMA = DATABASE() AND r.DELETE_RULE = 'CASCADE'`);
      if (cascades.length && !pending.includes('009_safe_foreign_keys')) bad(`foreign keys that delete history: ${cascades.map((c) => c.c).join(', ')}`);
      else if (cascades.length) warn(`foreign keys that delete history (${cascades.map((c) => c.c).join(', ')}) - migration 009 repairs them at the next start`);
      else ok('no foreign key deletes history (no ON DELETE CASCADE)');
      const [[admins]] = await conn.query("SELECT COUNT(*) AS n FROM users WHERE role IN ('admin', 'franchise_owner') AND (status IS NULL OR status = 1)").catch(() => [[{ n: 0 }]]);
      if (Number(admins.n)) ok(`${admins.n} active administrator account(s)`); else bad('no active administrator account');
    }
  } catch (err) {
    bad(`database check stopped: ${err.code ?? err.message}`);
  } finally {
    await conn.query('ROLLBACK').catch(() => {});
    await conn.end().catch(() => {});
  }
}

console.log('\n3. Running API');
if (!argUrl) {
  warn('no --url given: the HTTPS checks of the running API were skipped');
} else {
  const base = argUrl.replace(/\/+$/, '').replace(/\/api$/, '');
  try {
    const u = new URL(base);
    if (u.protocol !== 'https:') bad(`${base} is not HTTPS`);
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(10000) });
    const body = await res.json().catch(() => ({}));
    if (res.status === 200 && body.status === 'healthy') ok(`${base}/api/health: healthy (database reachable)`); else bad(`${base}/api/health answered ${res.status}`);
    if (/max-age=\d+/.test(res.headers.get('strict-transport-security') ?? '')) ok('HSTS header present'); else bad('no Strict-Transport-Security header');
    for (const origin of config.cors.origins) {
      const pre = await fetch(`${base}/api/leads`, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'GET' }, signal: AbortSignal.timeout(10000) });
      if (pre.headers.get('access-control-allow-origin') === origin) ok(`browser calls from ${origin} are allowed (CORS)`); else bad(`CORS preflight from ${origin} is not allowed`);
    }
    const anon = await fetch(`${base}/api/leads`, { signal: AbortSignal.timeout(10000) });
    if (anon.status === 401) ok('protected endpoints refuse anonymous requests'); else bad(`GET /api/leads without a token answered ${anon.status}`);
  } catch (err) {
    bad(`cannot reach ${base}: ${err.cause?.code ?? err.message}`);
  }
}

console.log(problems.length ? `\nPREFLIGHT: ${problems.length} problem(s) - fix them before going live` : '\nPREFLIGHT: ready');
process.exit(problems.length ? 1 : 0);

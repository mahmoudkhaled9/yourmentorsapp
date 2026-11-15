// Fills the LOCAL development database with the consistent demo company (scripts/lib/dev-data.mjs):
//   npm run seed:dev                       add whatever is missing (idempotent; existing records are never changed)
//   npm run seed:dev -- --fix-orphans      also detach projects from developers that no longer exist (developer -> none)
// Safety: refuses unless DB_* point at 127.0.0.1:3306 / mentors_crm (or a mentors_crm_test_<...> database) and
// NODE_ENV is not production. Take a backup first. Data goes through the real API (validation, ids, hierarchy, logs).
// Demo-account password: DEV_SEED_PASSWORD, else the one in .dev-seed-accounts.local.txt, else a new random one written
// there (git-ignored, mode 600). It is never printed.
import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { createMysqlPool } from '../src/db.js';
import { createContext } from '../src/server.js';
import { createApp } from '../src/app.js';
import { findOrphans } from '../src/domain/integrity.js';
import { DEMO_ACCOUNTS, seedDemoCompany } from './lib/dev-data.mjs';
import { assertConnectedTo, assertLocalDevTarget } from './lib/local-db-guard.mjs';

const ACCOUNTS_FILE = '.dev-seed-accounts.local.txt';
const fixOrphans = process.argv.includes('--fix-orphans');
const config = loadConfig(process.env);
if (config.errors.length) { console.error(config.errors.join('\n')); process.exit(2); }
try { assertLocalDevTarget(config.db); } catch (err) { console.error(err.message); process.exit(2); }

function demoPassword() {
  if (process.env.DEV_SEED_PASSWORD) return process.env.DEV_SEED_PASSWORD;
  if (fs.existsSync(ACCOUNTS_FILE)) {
    const m = fs.readFileSync(ACCOUNTS_FILE, 'utf8').match(/^password=(.+)$/m);
    if (m) return m[1].trim();
  }
  const password = `Dv-${crypto.randomBytes(12).toString('base64url')}9`;
  fs.writeFileSync(ACCOUNTS_FILE, `# demo accounts created by npm run seed:dev (local development only)\npassword=${password}\n${Object.values(DEMO_ACCOUNTS).filter((e) => e !== DEMO_ACCOUNTS.admin).map((e) => `account=${e}`).join('\n')}\n`, { mode: 0o600 });
  return password;
}

const logger = createLogger({ level: 'warn' });
const pool = createMysqlPool(config.db);
let server;
let ctx;
try {
  const [[row]] = await pool.query('SELECT DATABASE() AS db, @@port AS port');
  await assertConnectedTo(async () => row, config.db.database);
  ctx = await createContext({ config, pool, logger });
  const db = ctx.db;

  if (fixOrphans) {
    // Only the relation the audit found: a project whose developer was deleted keeps everything else, its developer
    // becomes "none" (an admin can pick the right one in the UI). Nothing is invented.
    const devCols = ctx.schema.pick('projects', ['developer_id', 'developerId']);
    let fixed = 0;
    for (const col of devCols) {
      const r = await db.exec(`UPDATE projects SET \`${col}\` = NULL WHERE \`${col}\` IS NOT NULL AND \`${col}\` <> 0 AND NOT EXISTS (SELECT 1 FROM developers d WHERE d.id = projects.\`${col}\`)`);
      fixed += Number(r.affectedRows ?? 0);
    }
    console.log(`--fix-orphans: ${fixed} project developer reference(s) set to "no developer"`);
  }

  const admin = await db.one("SELECT id, role FROM users WHERE role = 'admin' AND (status IS NULL OR status = 1) ORDER BY id LIMIT 1");
  if (!admin) throw new Error('no active administrator in this database');
  const token = ctx.tokens.issue(admin); // in-process: the script already has database access
  server = http.createServer(createApp(ctx));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (method, path, body) => {
    const res = await fetch(`${base}/${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${data.error ?? ''}`);
    return data;
  };
  const created = await seedDemoCompany(call, { password: demoPassword() });
  console.log(`created: ${Object.entries(created).map(([k, v]) => `${v} ${k}`).join(', ')} (existing records untouched)`);
  if (created.users) console.log(`demo accounts: ${Object.values(DEMO_ACCOUNTS).filter((e) => e !== DEMO_ACCOUNTS.admin).join(', ')} - password in ${ACCOUNTS_FILE}`);

  const { problems } = await findOrphans(db, ctx.schema);
  console.log(problems.length ? `orphan references remain: ${problems.map((p) => `${p.relation} (${p.ids.join(', ')})`).join('; ')}` : 'no orphan references');
  process.exitCode = problems.length ? 1 : 0;
} catch (err) {
  console.error(`seed stopped: ${err.message}`);
  process.exitCode = 1;
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  ctx?.onClose.forEach((fn) => fn());
  await pool.end().catch(() => {});
}

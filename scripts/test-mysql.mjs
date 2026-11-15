// Runs the integration suites against a REAL MySQL server, in a brand-new temporary database.
//  - Connection: TEST_DB_HOST/PORT/USER/PASSWORD (fall back to DB_HOST/PORT/USER/PASSWORD from .env).
//  - Creates `mentors_crm_test_<UTC yyyymmddhhmmss>` (CREATE DATABASE without IF NOT EXISTS: if that name already exists the
//    run stops before touching anything), runs the suites in it, then drops ONLY that database (--keep to inspect it).
//  - Your configured database (DB_NAME, required) is only READ, twice: a row count per table before and after, to show
//    the run did not change it. Nothing is ever written to it. Both snapshots are mandatory: if the first one fails the
//    run stops BEFORE creating anything; if the last one fails the run fails.
// Exit code: the test result (0 = all passed); 1 if a snapshot or a safety check failed; 2 if DB_NAME is missing or
// MySQL is unreachable; 3 if the temporary database could not be removed; 130 if interrupted.
import 'dotenv/config';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import mysql from 'mysql2/promise';

const TEMP_NAME = /^mentors_crm_test_\d{14}$/;
const SYSTEM = new Set(['mysql', 'information_schema', 'performance_schema', 'sys']);
const configured = String(process.env.DB_NAME ?? '').trim();
if (!configured) {
  console.error('DB_NAME is not set in .env: it names the real database this run must prove it did not touch. Nothing was done.');
  process.exit(2);
}
const cfg = {
  host: process.env.TEST_DB_HOST ?? process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? process.env.DB_PORT ?? 3306),
  user: process.env.TEST_DB_USER ?? process.env.DB_USER,
  password: process.env.TEST_DB_PASSWORD ?? process.env.DB_PASSWORD,
};
const name = `mentors_crm_test_${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
const keep = process.argv.includes('--keep');

/** Every statement that creates or drops a database goes through this check first. */
function assertTempName(db, createdByThisRun) {
  if (!TEMP_NAME.test(db)) throw new Error(`refusing: "${db}" is not a temporary test database name (mentors_crm_test_<14 digits>)`);
  if (db === configured || SYSTEM.has(db.toLowerCase())) throw new Error(`refusing: "${db}" is a protected database`);
  if (createdByThisRun !== undefined && createdByThisRun !== db) throw new Error(`refusing: "${db}" was not created by this run`);
}
const q = (id) => `\`${id}\``; // only ever called with names that passed assertTempName (letters, digits, underscore)

/** Read-only: one SELECT COUNT(*) per table. Throws on any error (the snapshots are mandatory). */
async function countRows(conn, db) {
  const [tables] = await conn.query('SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = ? ORDER BY TABLE_NAME', [db, 'BASE TABLE']);
  const counts = {};
  for (const { t } of tables) {
    const [[row]] = await conn.query('SELECT COUNT(*) AS n FROM ??.??', [db, t]); // read-only
    counts[t] = Number(row.n);
  }
  return counts;
}

let conn;
try {
  conn = await mysql.createConnection(cfg); // no default database: nothing runs "inside" your real database by accident
} catch (err) {
  console.error(`Cannot connect to MySQL at ${cfg.host}:${cfg.port}: ${err.code ?? 'connection error'}`);
  process.exit(2);
}

let created = null;
let before = null;
let exitCode = 1;
let interrupted = false;
let child = null;
const onSignal = (sig) => { interrupted = true; console.log(`\n${sig} received: stopping the tests, then cleaning up`); child?.kill(sig); };
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);

try {
  const [[real]] = await conn.query('SELECT COUNT(*) AS n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [configured]);
  if (!Number(real.n)) throw new Error(`the configured database "${configured}" does not exist on ${cfg.host}:${cfg.port} - nothing was created`);
  try {
    before = await countRows(conn, configured);
  } catch (err) {
    throw new Error(`the read-only snapshot of "${configured}" failed (${err.code ?? err.message}) - stopping before creating anything`);
  }
  console.log(`read-only snapshot of "${configured}": ${Object.keys(before).length} tables`);

  assertTempName(name);
  const [[exists]] = await conn.query('SELECT COUNT(*) AS n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [name]);
  if (Number(exists.n)) throw new Error(`"${name}" already exists - not touching it; run again in a second`);
  await conn.query(`CREATE DATABASE ${q(name)} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  created = name; // from here on, and only now, cleanup may drop it
  const [[tables]] = await conn.query('SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [name]);
  if (Number(tables.n)) throw new Error(`"${name}" is not empty after creation`);
  console.log(`created temporary test database ${name} on ${cfg.host}:${cfg.port}`);

  if (!interrupted) {
    if (name === configured || !TEMP_NAME.test(name)) throw new Error('refusing to run the tests outside the temporary database');
    // DB_* point at the temporary database too, so even code that reads the normal connection settings can only reach it.
    const env = {
      ...process.env,
      TEST_DB: 'mysql', TEST_DB_NAME: name, TEST_DB_HOST: cfg.host, TEST_DB_PORT: String(cfg.port), TEST_DB_USER: cfg.user ?? '', TEST_DB_PASSWORD: cfg.password ?? '',
      DB_NAME: name, DB_HOST: cfg.host, DB_PORT: String(cfg.port), DB_USER: cfg.user ?? '', DB_PASSWORD: cfg.password ?? '',
    };
    // the same files as `npm run test:integration` (a bare folder argument is not run by node --test)
    const files = fs.readdirSync('test/integration').filter((f) => f.endsWith('.test.js')).sort().map((f) => `test/integration/${f}`);
    if (!files.length) throw new Error('no test files found in test/integration');
    console.log(`running ${files.length} integration suites: ${files.map((f) => f.split('/').pop()).join(', ')}`);
    child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...files], { stdio: 'inherit', env });
    exitCode = await new Promise((resolve) => {
      child.on('exit', (code) => resolve(code ?? 1)); // killed by a signal = failure
      child.on('error', () => resolve(1));
    });
  }
} catch (err) {
  console.error(`test run stopped: ${err.message}`);
  exitCode = exitCode || 1; // an error after passing tests still fails the run
} finally {
  if (created && keep) {
    console.log(`kept ${created} (drop it yourself when done: DROP DATABASE \`${created}\`;)`);
  } else if (created) {
    try {
      assertTempName(created, name);
      await conn.query(`DROP DATABASE ${q(created)}`);
      const [[left]] = await conn.query('SELECT COUNT(*) AS n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [created]);
      if (Number(left.n)) throw new Error('still present');
      console.log(`dropped the temporary database ${created}`);
    } catch (err) {
      console.error(`could NOT remove ${created} (${err.message}). Remove it by hand: DROP DATABASE \`${created}\`;`);
      exitCode = 3;
    }
  }
  if (before) {
    // mandatory final snapshot (also after an error): the run must be able to show the real database is unchanged
    try {
      const after = await countRows(conn, configured);
      const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((t) => before[t] !== after[t]);
      console.log(changed.length
        ? `NOTE: row counts in "${configured}" changed during the run (${changed.join(', ')}) - expected only if someone used the app meanwhile`
        : `"${configured}" unchanged: same ${Object.keys(after).length} tables, same row count in every table`);
    } catch (err) {
      console.error(`the final read-only snapshot of "${configured}" failed (${err.code ?? err.message}): the run cannot show the real database is unchanged`);
      if (exitCode === 0) exitCode = 1;
    }
  }
  await conn.end().catch(() => {});
}
process.exit(interrupted ? 130 : exitCode);

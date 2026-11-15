// Runs the integration suites against a REAL MySQL server, in a brand-new temporary database.
//
// Accounts (scripts/lib/qa-db.mjs, setup SQL in scripts/qa-mysql-setup.sql). QA credentials live in .env.test:
//   DB_USER / DB_PASSWORD                    production account from .env: ONLY read-only row counts of DB_NAME
//   TEST_DB_ADMIN_USER / TEST_DB_ADMIN_PASSWORD creates and drops `mentors_crm_test_<UTC yyyymmddhhmmss>`; never passed on
//   TEST_DB_USER / TEST_DB_PASSWORD          the only credentials the test process receives (allow-listed environment)
//
// Steps: read-only snapshot of DB_NAME -> create the temp database (CREATE DATABASE without IF NOT EXISTS) -> prove the
// test account reaches the temp database and NOT DB_NAME -> run the suites -> drop ONLY the database this run created
// (--keep to inspect it) -> mandatory read-only snapshot of DB_NAME again.
// Exit code: the test result (0 = all passed); 1 if a snapshot or a safety check failed; 2 if not configured or MySQL is
// unreachable; 3 if the temporary database could not be removed; 130 if interrupted.
import dotenv from 'dotenv';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import mysql from 'mysql2/promise';
import { assertTempName, childEnv, resolveAccounts, tempDatabaseName } from './lib/qa-db.mjs';

dotenv.config({ quiet: true });
// shell environment > .env.test > .env (a file never overrides a value set explicitly, e.g. by CI)
if (fs.existsSync('.env.test')) dotenv.config({ path: '.env.test', quiet: true });

let accounts;
try {
  accounts = resolveAccounts(process.env);
} catch (err) {
  console.error(err.message);
  process.exit(2);
}
const { prod, admin, tester } = accounts;
const configured = prod.database;
const name = tempDatabaseName();
const keep = process.argv.includes('--keep');
// --e2e: instead of the API suites, run the frontend's browser tests + interaction audit (../mentorsfront) against the
// real backend on this temporary database
const e2e = process.argv.includes('--e2e');
const q = (id) => `\`${id}\``; // only ever called with names that passed assertTempName (letters, digits, underscore)

/** Read-only: one SELECT COUNT(*) per table, inside a READ ONLY transaction. Throws on any error (mandatory). */
async function countRows() {
  const conn = await mysql.createConnection({ host: prod.host, port: prod.port, user: prod.user, password: prod.password });
  try {
    await conn.query('START TRANSACTION READ ONLY');
    const [tables] = await conn.query('SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = ? ORDER BY TABLE_NAME', [configured, 'BASE TABLE']);
    if (!tables.length) throw new Error(`"${configured}" has no tables or this account cannot see it`);
    const counts = {};
    for (const { t } of tables) {
      const [[row]] = await conn.query('SELECT COUNT(*) AS n FROM ??.??', [configured, t]);
      counts[t] = Number(row.n);
    }
    await conn.query('ROLLBACK');
    return counts;
  } finally {
    await conn.end().catch(() => {});
  }
}

/** The test account must land in the temporary database and must not be able to see the real one. */
async function proveTesterIsolated() {
  const conn = await mysql.createConnection({ ...tester, database: name });
  try {
    const [[row]] = await conn.query('SELECT DATABASE() AS db');
    if (row.db !== name) throw new Error(`test account connected to "${row.db}", expected ${name}`);
    const [[real]] = await conn.query('SELECT COUNT(*) AS n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [configured]);
    if (Number(real.n)) throw new Error(`the test account "${tester.user}" can see "${configured}": restrict it to mentors_crm_test_% (scripts/qa-mysql-setup.sql)`);
  } finally {
    await conn.end().catch(() => {});
  }
}

let conn;
try {
  conn = await mysql.createConnection({ host: admin.host, port: admin.port, user: admin.user, password: admin.password }); // no default database
} catch (err) {
  console.error(`Cannot connect to MySQL at ${admin.host}:${admin.port} as the QA admin account: ${err.code ?? 'connection error'}`);
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
  try {
    before = await countRows();
  } catch (err) {
    throw new Error(`the read-only snapshot of "${configured}" failed (${err.code ?? err.message}) - stopping before creating anything`);
  }
  console.log(`read-only snapshot of "${configured}": ${Object.keys(before).length} tables`);

  assertTempName(name, { configured });
  const [[exists]] = await conn.query('SELECT COUNT(*) AS n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [name]);
  if (Number(exists.n)) throw new Error(`"${name}" already exists - not touching it; run again in a second`);
  await conn.query(`CREATE DATABASE ${q(name)} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  created = name; // from here on, and only now, cleanup may drop it
  const [[tables]] = await conn.query('SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [name]);
  if (Number(tables.n)) throw new Error(`"${name}" is not empty after creation`);
  console.log(`created temporary test database ${name} on ${admin.host}:${admin.port}`);

  await proveTesterIsolated();
  console.log(`test account "${tester.user}" reaches ${name} and cannot see "${configured}"`);

  if (!interrupted) {
    const env = childEnv(process.env, { tester, database: name });
    if (e2e) {
      const front = new URL('../../mentorsfront/', import.meta.url).pathname;
      if (!fs.existsSync(`${front}e2e/run.mjs`)) throw new Error(`frontend not found at ${front}`);
      console.log('running the browser tests + interaction audit against this database');
      child = spawn(process.execPath, ['e2e/run.mjs', '--audit'], { stdio: 'inherit', env, cwd: front });
    } else {
      const files = fs.readdirSync('test/integration').filter((f) => f.endsWith('.test.js')).sort().map((f) => `test/integration/${f}`);
      if (!files.length) throw new Error('no test files found in test/integration');
      console.log(`running ${files.length} integration suites: ${files.map((f) => f.split('/').pop()).join(', ')}`);
      child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...files], { stdio: 'inherit', env });
    }
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
      assertTempName(created, { configured, createdByThisRun: name });
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
      const after = await countRows();
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

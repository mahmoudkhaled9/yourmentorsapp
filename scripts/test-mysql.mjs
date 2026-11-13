// Runs the integration suites against a REAL MySQL server.
//  - Connection: TEST_DB_HOST/PORT/USER/PASSWORD (fall back to DB_HOST/PORT/USER/PASSWORD from .env).
//  - Creates a brand-new database `mentors_crm_test_<timestamp>` for this run, so no existing data is ever read or
//    changed, runs the suites in it, then drops ONLY that database (pass --keep to inspect it afterwards).
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import mysql from 'mysql2/promise';

const cfg = {
  host: process.env.TEST_DB_HOST ?? process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? process.env.DB_PORT ?? 3306),
  user: process.env.TEST_DB_USER ?? process.env.DB_USER,
  password: process.env.TEST_DB_PASSWORD ?? process.env.DB_PASSWORD,
};
const name = `mentors_crm_test_${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
let conn;
try {
  conn = await mysql.createConnection(cfg);
} catch (err) {
  console.error(`Cannot connect to MySQL at ${cfg.host}:${cfg.port} as "${cfg.user}": ${err.code ?? err.message}`);
  process.exit(2);
}
await conn.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
console.log(`created test database ${name}`);
const env = { ...process.env, TEST_DB: 'mysql', TEST_DB_NAME: name, TEST_DB_HOST: cfg.host, TEST_DB_PORT: String(cfg.port), TEST_DB_USER: cfg.user ?? '', TEST_DB_PASSWORD: cfg.password ?? '' };
const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', 'test/integration/'], { stdio: 'inherit', env });
if (process.argv.includes('--keep')) console.log(`kept ${name} (drop it yourself when done: DROP DATABASE \`${name}\`;)`);
else { await conn.query(`DROP DATABASE \`${name}\``); console.log(`dropped the temporary database ${name}`); }
await conn.end();
process.exit(r.status ?? 1);

/**
 * TEST / DEMO server: the real backend on the in-memory SQLite stand-in, pre-filled with a demo company.
 * Nothing is written to MySQL or to disk; everything disappears when the process stops.
 *
 *   node test/support/dev-server.js [--port 4011] [--demo]
 *
 * Used by the end-to-end tests in mentorsfront (they start it automatically) and to try the UI without MySQL.
 * Demo accounts (all use the password printed below) are created for every role.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createSqlitePool } from './mysql-sqlite.js';
import { loadConfig } from '../../src/config.js';
import { start } from '../../src/server.js';
import { DEMO_ACCOUNTS, seedDemoCompany } from '../../scripts/lib/dev-data.mjs';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const port = Number(arg('port', process.env.PORT ?? 4011));
export const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? 'Demo-Pass-2026';
export { DEMO_ACCOUNTS };

const config = loadConfig({
  NODE_ENV: 'test', PORT: String(port), JWT_SECRET: crypto.randomBytes(32).toString('hex'), LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
  INITIAL_ADMIN_EMAIL: DEMO_ACCOUNTS.admin, INITIAL_ADMIN_PASSWORD: DEMO_PASSWORD, INITIAL_ADMIN_NAME: 'Demo Admin', BCRYPT_ROUNDS: '6',
  CORS_ORIGIN: process.env.CORS_ORIGIN ?? 'http://localhost:4173,http://127.0.0.1:4173,http://localhost:5173,http://127.0.0.1:5173',
  LOGIN_MAX_FAILURES: '50', API_MAX_PER_USER_PER_MIN: '100000', LOGIN_MAX_PER_IP_PER_MIN: '10000', API_MAX_PER_IP_PER_15MIN: '1000000',
});
const pool = createSqlitePool({ schemaSql: fs.readFileSync(new URL('./schema.sqlite.sql', import.meta.url), 'utf8') });
const { port: actual } = await start({ config, pool });
const base = `http://127.0.0.1:${actual}/api`;

async function call(method, path, body, token) {
  const res = await fetch(`${base}/${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

if (process.argv.includes('--demo')) {
  // the same idempotent, API-driven demo company `npm run seed:dev` puts into a local MySQL database
  const admin = (await call('POST', 'auth/login', { email: DEMO_ACCOUNTS.admin, password: DEMO_PASSWORD })).token;
  await seedDemoCompany((method, path, body) => call(method, path, body, admin), { password: DEMO_PASSWORD });
}

console.log(`DEMO API ready on ${base}  (in-memory, test data only)`);
console.log(`accounts (password "${DEMO_PASSWORD}"): ${Object.entries(DEMO_ACCOUNTS).map(([k, v]) => `${k}=${v}`).join('  ')}`);

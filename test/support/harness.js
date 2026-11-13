import fs from 'node:fs';
import http from 'node:http';
import { createSqlitePool } from './mysql-sqlite.js';
import { loadConfig } from '../../src/config.js';
import { createLogger } from '../../src/logger.js';
import { createContext } from '../../src/server.js';
import { createApp } from '../../src/app.js';
import { createMysqlPool } from '../../src/db.js';

export const ADMIN = { email: 'admin@test.local', password: 'Adm1n-Test-Pass!' };

/**
 * Where the tests run:
 *  - default ("legacy"): SQLite stand-in loaded with the REAL production table layout (test/support/schema.sqlite.sql)
 *  - TEST_SCHEMA=canonical: SQLite stand-in starting EMPTY, so migrations build everything from schema.sql
 *  - TEST_DB=mysql: a real MySQL server (TEST_DB_HOST/PORT/USER/PASSWORD/NAME). Safety: the database name must end in
 *    "_test" and must be empty on the first boot. Run via `npm run test:mysql`, which creates a fresh database per run.
 */
export const isMysql = () => process.env.TEST_DB === 'mysql';
export const schemaName = () => (isMysql() ? 'mysql' : process.env.TEST_SCHEMA === 'canonical' ? 'canonical' : 'legacy');
const LEGACY_SQL = () => fs.readFileSync(new URL('./schema.sqlite.sql', import.meta.url), 'utf8');

export function testEnv(overrides = {}) {
  return {
    NODE_ENV: 'test',
    JWT_SECRET: 'f3b1c7a9d2e84f60a1b7c3d9e5f20a4b8c6d1e7f3a9b5c2d8e4f1a7b3c9d5e20',
    INITIAL_ADMIN_EMAIL: ADMIN.email,
    INITIAL_ADMIN_PASSWORD: ADMIN.password,
    BCRYPT_ROUNDS: '4',
    LOG_LEVEL: 'silent',
    DB_USER: 'x', DB_NAME: 'x',
    API_MAX_PER_USER_PER_MIN: '100000',
    API_MAX_PER_IP_PER_15MIN: '1000000',
    LOGIN_MAX_PER_IP_PER_MIN: '100000',
    ...overrides,
  };
}

function mysqlTestPool() {
  const database = process.env.TEST_DB_NAME ?? '';
  if (!/_test(_\w+)?$/.test(database)) throw new Error(`Refusing to run tests against "${database}": TEST_DB_NAME must end with "_test" (never point tests at a real database).`);
  return createMysqlPool({
    host: process.env.TEST_DB_HOST ?? '127.0.0.1', port: Number(process.env.TEST_DB_PORT ?? 3306),
    user: process.env.TEST_DB_USER, password: process.env.TEST_DB_PASSWORD, database, poolSize: 10, queueLimit: 0,
  });
}

/** Boots the real app on an ephemeral port. `prepare(pool)` runs raw SQL before the app starts (SQLite only). */
export async function startTestApp({ env = {}, latencyMs = 0, logger, prepare, adminLogin = true, schema = schemaName() } = {}) {
  const config = loadConfig(testEnv(env));
  const pool = schema === 'mysql' ? mysqlTestPool() : createSqlitePool({ schemaSql: schema === 'canonical' ? '' : LEGACY_SQL(), latencyMs });
  logger ??= createLogger({ level: 'silent' });
  if (prepare) await prepare(pool);
  const ctx = await createContext({ config, pool, logger, waitForDb: schema === 'mysql' });
  const app = createApp(ctx);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(method, path, { token, body, raw, headers = {} } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { ...(raw === undefined && body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, body: data, headers: res.headers, text };
  }
  const api = {
    get: (p, token) => call('GET', p, { token }),
    post: (p, body, token) => call('POST', p, { token, body }),
    put: (p, body, token) => call('PUT', p, { token, body }),
    del: (p, token) => call('DELETE', p, { token }),
    call,
  };
  const login = async (email, password) => {
    const r = await api.post('/api/auth/login', { email, password });
    if (r.status !== 200) throw new Error(`login failed for ${email}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.token;
  };
  async function stop() {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); });
    ctx.onClose.forEach((fn) => fn());
    await pool.end();
  }

  let adminToken = null;
  if (adminLogin) {
    try { adminToken = await login(ADMIN.email, ADMIN.password); } catch (err) { await stop(); throw err; }
  }
  let counter = 0;
  const runTag = Math.random().toString(36).slice(2, 7);
  /** Creates a user through the real API; returns { id, email, password, token, ... }. */
  async function createUser(fields = {}) {
    counter += 1;
    const user = { name: `User ${counter} ${runTag}`, email: `user${counter}-${runTag}@test.local`, phone: '01000000000', role: 'agent', password: 'Str0ng-Pass-9', ...fields };
    const r = await api.post('/api/users', user, adminToken);
    if (r.status !== 200) throw new Error(`createUser failed: ${r.status} ${JSON.stringify(r.body)}`);
    return { id: r.body.id, ...user, token: await login(user.email, user.password) };
  }
  /** A phone number unique to this test run (Egyptian mobile format). */
  let phoneCounter = Math.floor(Math.random() * 1e6);
  const uniquePhone = (prefix = '010') => `${prefix}${String((phoneCounter += 1) % 1e8).padStart(8, '0')}`;
  return { base, api, ctx, pool, adminToken, login, createUser, uniquePhone, stop, server, runTag };
}

// Safety rules for `npm run test:mysql` (scripts/test-mysql.mjs). Pure functions so they can be unit-tested.
//
// Three MySQL accounts, three jobs (see scripts/qa-mysql-setup.sql):
//   DB_USER            production app account. Used here ONLY for read-only row counts of DB_NAME (before / after).
//   TEST_DB_ADMIN_USER creates and drops the temporary `mentors_crm_test_<14 digits>` database. Never given to the tests.
//   TEST_DB_USER       the only account the test process receives; it has privileges on `mentors_crm_test_%` only.

export const TEMP_NAME = /^mentors_crm_test_\d{14}$/;
const SYSTEM = new Set(['mysql', 'information_schema', 'performance_schema', 'sys']);

/** `mentors_crm_test_<UTC yyyymmddhhmmss>` */
export const tempDatabaseName = (now = new Date()) => `mentors_crm_test_${now.toISOString().replace(/\D/g, '').slice(0, 14)}`;

/** Every statement that creates or drops a database goes through this check first. */
export function assertTempName(db, { configured, createdByThisRun } = {}) {
  if (typeof db !== 'string' || !TEMP_NAME.test(db)) throw new Error(`refusing: "${db}" is not a temporary test database name (mentors_crm_test_<14 digits>)`);
  if ((configured && db === configured) || SYSTEM.has(db.toLowerCase())) throw new Error(`refusing: "${db}" is a protected database`);
  if (createdByThisRun !== undefined && createdByThisRun !== db) throw new Error(`refusing: "${db}" was not created by this run`);
  return db;
}

/**
 * Reads the three accounts from the environment and refuses unsafe combinations. Returns { prod, admin, tester } or
 * throws an Error whose message explains what to configure (never containing a password).
 */
export function resolveAccounts(env) {
  const host = env.TEST_DB_HOST || env.DB_HOST || '127.0.0.1';
  const port = Number(env.TEST_DB_PORT || env.DB_PORT || 3306);
  const prod = { host: env.DB_HOST || '127.0.0.1', port: Number(env.DB_PORT || 3306), user: env.DB_USER, password: env.DB_PASSWORD ?? '', database: env.DB_NAME };
  const admin = { host, port, user: env.TEST_DB_ADMIN_USER, password: env.TEST_DB_ADMIN_PASSWORD ?? '' };
  const tester = { host, port, user: env.TEST_DB_USER, password: env.TEST_DB_PASSWORD ?? '' };
  const missing = [];
  if (!String(prod.database ?? '').trim()) missing.push('DB_NAME');
  if (!prod.user) missing.push('DB_USER');
  if (!admin.user) missing.push('TEST_DB_ADMIN_USER');
  if (!tester.user) missing.push('TEST_DB_USER');
  if (missing.length) {
    throw new Error(`not configured: ${missing.join(', ')}. Put the QA accounts in .env.test (see .env.test.example and scripts/qa-mysql-setup.sql). Nothing was done.`);
  }
  const sameServer = admin.host === prod.host && admin.port === prod.port;
  if (sameServer && (admin.user === prod.user || tester.user === prod.user)) {
    throw new Error(`refusing: the QA accounts must not be the production account "${prod.user}". Create dedicated QA accounts (scripts/qa-mysql-setup.sql). Nothing was done.`);
  }
  if (admin.user === tester.user) {
    throw new Error('refusing: TEST_DB_ADMIN_USER and TEST_DB_USER must be different accounts (the tests must not be able to create or drop databases at will). Nothing was done.');
  }
  return { prod, admin, tester };
}

/**
 * Environment for the test process: built from an allow-list, so no production or QA-admin credential (and no other
 * secret from .env) can reach it. DB_* point at the temporary database too, so even code that reads the normal
 * connection settings can only reach it.
 */
export function childEnv(baseEnv, { tester, database }) {
  assertTempName(database);
  const keep = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TZ', 'SystemRoot', 'NODE_OPTIONS', 'TERM', 'CI', 'PLAYWRIGHT_MODULE', 'PLAYWRIGHT_BROWSERS_PATH'];
  const env = {};
  for (const k of keep) if (baseEnv[k] !== undefined) env[k] = baseEnv[k];
  Object.assign(env, {
    TEST_DB: 'mysql', TEST_DB_NAME: database, TEST_DB_HOST: tester.host, TEST_DB_PORT: String(tester.port),
    TEST_DB_USER: tester.user, TEST_DB_PASSWORD: tester.password,
    DB_NAME: database, DB_HOST: tester.host, DB_PORT: String(tester.port), DB_USER: tester.user, DB_PASSWORD: tester.password,
  });
  return env;
}

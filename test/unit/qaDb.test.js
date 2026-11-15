import test from 'node:test';
import assert from 'node:assert/strict';
import { assertTempName, childEnv, resolveAccounts, tempDatabaseName, TEMP_NAME } from '../../scripts/lib/qa-db.mjs';

const ENV = {
  DB_HOST: '127.0.0.1', DB_PORT: '3306', DB_USER: 'mentors_user', DB_PASSWORD: 'prod-secret', DB_NAME: 'mentors_crm',
  JWT_SECRET: 'jwt-secret',
  TEST_DB_ADMIN_USER: 'mentors_qa_admin', TEST_DB_ADMIN_PASSWORD: 'admin-secret',
  TEST_DB_USER: 'mentors_qa', TEST_DB_PASSWORD: 'qa-secret',
  PATH: '/usr/bin', HOME: '/home/x',
};

test('MySQL QA: only mentors_crm_test_<14 digits> can be created or dropped, and only the one this run created', () => {
  const name = tempDatabaseName(new Date('2026-11-15T10:20:30Z'));
  assert.equal(name, 'mentors_crm_test_20261115102030');
  assert.match(name, TEMP_NAME);
  assert.equal(assertTempName(name, { configured: 'mentors_crm', createdByThisRun: name }), name);
  for (const bad of ['mentors_crm', 'mentors_crm_test', 'mentors_crm_test_1', 'mysql', 'mentors_crm_test_20261115102030; DROP DATABASE mentors_crm', '', undefined, 'MENTORS_CRM_TEST_20261115102030x']) {
    assert.throws(() => assertTempName(bad, { configured: 'mentors_crm' }), /refusing/, String(bad));
  }
  assert.throws(() => assertTempName(name, { createdByThisRun: 'mentors_crm_test_20261115102031' }), /not created by this run/);
  assert.throws(() => assertTempName('mentors_crm_test_20261115102030', { configured: 'mentors_crm_test_20261115102030' }), /protected/);
});

test('MySQL QA: three separate accounts are required; the production account is never used for test writes', () => {
  const { prod, admin, tester } = resolveAccounts(ENV);
  assert.equal(prod.user, 'mentors_user');
  assert.equal(admin.user, 'mentors_qa_admin');
  assert.equal(tester.user, 'mentors_qa');

  assert.throws(() => resolveAccounts({ ...ENV, TEST_DB_ADMIN_USER: undefined }), /not configured: TEST_DB_ADMIN_USER/);
  assert.throws(() => resolveAccounts({ ...ENV, TEST_DB_USER: '' }), /not configured: TEST_DB_USER/);
  assert.throws(() => resolveAccounts({ ...ENV, DB_NAME: ' ' }), /not configured: DB_NAME/);
  assert.throws(() => resolveAccounts({ ...ENV, TEST_DB_USER: 'mentors_user' }), /must not be the production account/);
  assert.throws(() => resolveAccounts({ ...ENV, TEST_DB_ADMIN_USER: 'mentors_user' }), /must not be the production account/);
  assert.throws(() => resolveAccounts({ ...ENV, TEST_DB_USER: 'mentors_qa_admin' }), /must be different accounts/);
  // error messages never contain a password
  for (const bad of [{ TEST_DB_USER: 'mentors_user' }, { TEST_DB_ADMIN_USER: '' }]) {
    try { resolveAccounts({ ...ENV, ...bad }); } catch (err) { assert.doesNotMatch(err.message, /secret/); }
  }
});

test('MySQL QA: the test process receives only the QA test account, pointed at the temporary database', () => {
  const { tester } = resolveAccounts(ENV);
  const env = childEnv(ENV, { tester, database: 'mentors_crm_test_20261115102030' });
  assert.equal(env.TEST_DB, 'mysql');
  assert.equal(env.TEST_DB_NAME, 'mentors_crm_test_20261115102030');
  assert.equal(env.DB_NAME, 'mentors_crm_test_20261115102030');
  assert.equal(env.DB_USER, 'mentors_qa');
  assert.equal(env.PATH, '/usr/bin');
  const values = Object.values(env).join('\n');
  for (const secret of ['prod-secret', 'admin-secret', 'jwt-secret', 'mentors_qa_admin', 'mentors_user']) assert.ok(!values.includes(secret), `${secret} leaked`);
  assert.throws(() => childEnv(ENV, { tester, database: 'mentors_crm' }), /refusing/);
});

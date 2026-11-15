import test from 'node:test';
import assert from 'node:assert/strict';
import { assertConnectedTo, assertLocalDevTarget } from '../../scripts/lib/local-db-guard.mjs';

const LOCAL = { host: '127.0.0.1', port: 3306, database: 'mentors_crm' };

test('demo-data / repair scripts only ever target the local development database', () => {
  assert.equal(assertLocalDevTarget(LOCAL, {}), LOCAL);
  assert.ok(assertLocalDevTarget({ ...LOCAL, host: 'localhost' }, {}));
  assert.ok(assertLocalDevTarget({ ...LOCAL, database: 'mentors_crm_test_20261115102030' }, {}));
  const refused = [
    [{ ...LOCAL, host: 'db.example.com' }, {}, /not this machine/],
    [{ ...LOCAL, host: '10.0.0.5' }, {}, /not this machine/],
    [{ ...LOCAL, port: 3307 }, {}, /3306/],
    [{ ...LOCAL, database: 'mentors_crm_prod' }, {}, /neither/],
    [{ ...LOCAL, database: 'mysql' }, {}, /neither/],
    [LOCAL, { NODE_ENV: 'production' }, /production/],
  ];
  for (const [db, env, re] of refused) assert.throws(() => assertLocalDevTarget(db, env), re, JSON.stringify(db));
});

test('the runtime check compares the live connection, not just the configuration', async () => {
  await assertConnectedTo(async () => ({ db: 'mentors_crm', port: 3306 }), 'mentors_crm');
  await assert.rejects(assertConnectedTo(async () => ({ db: 'other', port: 3306 }), 'mentors_crm'), /connected to "other"/);
  await assert.rejects(assertConnectedTo(async () => ({ db: 'mentors_crm', port: 3307 }), 'mentors_crm'), /port 3307/);
});

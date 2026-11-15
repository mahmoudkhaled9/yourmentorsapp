import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { isMysql, startTestApp } from '../support/harness.js';
import { up as safeForeignKeys } from '../../src/migrations/009_safe_foreign_keys.js';

// Foreign keys only exist on real MySQL; this runs in `npm run test:mysql` (temporary database) and is skipped in the
// in-memory runs, where there is no foreign-key metadata to repair.
const mysqlOnly = { skip: isMysql() ? false : 'needs a real MySQL server (npm run test:mysql)' };
let app;
before(async () => { if (isMysql()) app = await startTestApp(); });
after(async () => { await app?.stop(); });

const rules = async () => Object.fromEntries((await app.ctx.db.rows(
  `SELECT CONCAT(k.TABLE_NAME, '.', k.COLUMN_NAME) AS col, r.DELETE_RULE AS rule FROM information_schema.KEY_COLUMN_USAGE k
     JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
    WHERE k.TABLE_SCHEMA = DATABASE() AND k.TABLE_NAME IN ('comments', 'cold_calls')`,
)).map((r) => [r.col, r.rule]));

test('migration 009 turns the old history-deleting CASCADE keys into SET NULL / RESTRICT (real MySQL)', mysqlOnly, async () => {
  const db = app.ctx.db;
  // a fresh database is already safe
  assert.equal(Object.values(await rules()).includes('CASCADE'), false, 'schema.sql has no CASCADE any more');
  // re-create the OLD keys, as every installation built from the previous schema.sql has them
  const old = [['comments', 'lead_id', 'leads'], ['comments', 'cold_call_id', 'cold_calls'], ['comments', 'user_id', 'users'], ['cold_calls', 'status_id', 'statuses']];
  const keys = await db.rows(`SELECT TABLE_NAME AS t, COLUMN_NAME AS c, CONSTRAINT_NAME AS name FROM information_schema.KEY_COLUMN_USAGE
    WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL AND TABLE_NAME IN ('comments', 'cold_calls')`);
  for (const [t, c, parent] of old) {
    const key = keys.find((k) => k.t === t && k.c === c);
    assert.ok(key, `${t}.${c} has a foreign key`);
    await db.exec(`ALTER TABLE \`${t}\` DROP FOREIGN KEY \`${key.name}\``);
    await db.exec(`ALTER TABLE \`${t}\` ADD CONSTRAINT \`${key.name}\` FOREIGN KEY (\`${c}\`) REFERENCES \`${parent}\`(id) ON DELETE CASCADE`);
  }
  assert.equal((await rules())['comments.lead_id'], 'CASCADE');

  await safeForeignKeys({ db, logger: { info() {} } });
  const after1 = await rules();
  assert.equal(after1['comments.lead_id'], 'SET NULL');
  assert.equal(after1['comments.cold_call_id'], 'SET NULL');
  assert.equal(after1['comments.user_id'], 'SET NULL');
  assert.equal(after1['cold_calls.status_id'], 'RESTRICT');
  await safeForeignKeys({ db, logger: { info() {} } }); // idempotent
  assert.deepEqual(await rules(), after1);

  // and the behaviour: deleting a lead keeps its comment
  const lead = await app.api.post('/api/leads', { name: 'FK Check', phone: app.uniquePhone() }, app.adminToken);
  const note = await app.api.post('/api/comments', { entityType: 'lead', entityId: lead.body.id, content: 'history' }, app.adminToken);
  assert.equal((await app.api.del(`/api/leads/${lead.body.id}`, app.adminToken)).status, 200);
  assert.equal((await db.rows('SELECT id FROM comments WHERE id = ?', [note.body.id])).length, 1, 'the comment survives');
});

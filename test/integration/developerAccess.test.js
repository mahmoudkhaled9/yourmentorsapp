import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from '../support/harness.js';

/** Developers: agents get 403 on every developer endpoint; administrators keep full access; other roles are unchanged. */
let app; let agent; let leader; let manager;
before(async () => {
  app = await startTestApp();
  manager = await app.createUser({ role: 'sales_manager' });
  leader = await app.createUser({ role: 'team_leader', teamLeaderId: manager.id });
  agent = await app.createUser({ role: 'agent', teamLeaderId: leader.id });
});
after(async () => { await app?.stop(); });

test('agents: every Developers endpoint answers 403 (view, create, edit, delete)', async () => {
  const anyId = (await app.api.get('/api/developers', app.adminToken)).body[0]?.id ?? 1;
  const calls = [
    ['GET', '/api/developers'],
    ['POST', '/api/developers', { name: 'Agent Dev' }],
    ['PUT', `/api/developers/${anyId}`, { name: 'Renamed by agent' }],
    ['DELETE', `/api/developers/${anyId}`],
  ];
  for (const [method, path, body] of calls) {
    const r = await app.api.call(method, path, { token: agent.token, body });
    assert.equal(r.status, 403, `${method} ${path}`);
    assert.ok(!JSON.stringify(r.body).includes('"logo"'), 'no developer data in the refusal');
  }
});

test('administrators keep full access: view, add, edit, delete', async () => {
  const name = `Admin Dev ${app.runTag}`;
  const created = await app.api.post('/api/developers', { name, phone: '01000000001' }, app.adminToken);
  assert.equal(created.status, 200, created.text);
  const id = created.body.id ?? created.body.item?.id;
  assert.ok((await app.api.get('/api/developers', app.adminToken)).body.some((d) => d.id === id));
  assert.equal((await app.api.put(`/api/developers/${id}`, { name: `${name} 2` }, app.adminToken)).status, 200);
  assert.equal((await app.api.del(`/api/developers/${id}`, app.adminToken)).status, 200);
});

test('other roles are unchanged: they still read the list and still cannot write', async () => {
  for (const u of [leader, manager]) {
    assert.equal((await app.api.get('/api/developers', u.token)).status, 200);
    assert.equal((await app.api.post('/api/developers', { name: `X ${u.id}` }, u.token)).status, 403);
  }
});

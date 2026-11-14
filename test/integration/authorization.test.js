import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from '../support/harness.js';

/**
 * Hierarchy:   admin
 *              director D ── team leader T ── agents A1, A2
 *              team leader T2 ── agent B          (another team)
 */
let app; let D; let T; let A1; let A2; let T2; let B;
let phone;
const lead = (extra = {}) => ({ name: 'Client', phone: phone(), statusId: 1, ...extra });
const idsOf = (r) => r.body.map((x) => x.id);

before(async () => {
  app = await startTestApp();
  phone = () => app.uniquePhone('011');
  D = await app.createUser({ name: `Director ${app.runTag}`, role: 'director' });
  T = await app.createUser({ name: `Team Lead ${app.runTag}`, role: 'team_leader', teamLeaderId: D.id });
  A1 = await app.createUser({ name: `Agent One ${app.runTag}`, teamLeaderId: T.id });
  A2 = await app.createUser({ name: `Agent Two ${app.runTag}`, teamLeaderId: T.id });
  T2 = await app.createUser({ name: `Other Lead ${app.runTag}`, role: 'team_leader' });
  B = await app.createUser({ name: `Agent B ${app.runTag}`, teamLeaderId: T2.id });
});
after(async () => { await app.stop(); });

test('the old destructive /api/sync/* endpoints do not exist (they allowed self-promotion to admin)', async () => {
  for (const path of ['users', 'leads', 'cold-calls', 'comments', 'deals', 'statuses']) {
    assert.equal((await app.api.post(`/api/sync/${path}`, [{ id: A1.id, role: 'admin' }], A1.token)).status, 404, path);
  }
  assert.equal((await app.api.get('/api/auth/me', A1.token)).body.user.role, 'agent');
});

test('administrator-only endpoints reject every non-admin role with 403', async () => {
  for (const who of [D, T, A1]) {
    const checks = [
      ['POST', '/api/users', { name: 'x', email: 'x@y.zz', password: 'Str0ng-Pass-9' }],
      ['PUT', `/api/users/${who.id}`, { role: 'admin' }],
      ['DELETE', `/api/users/${A2.id}`],
      ['POST', '/api/statuses', { name: 'Nope', color: '#111111' }],
      ['POST', '/api/projects', { name: 'Nope' }],
      ['POST', '/api/developers', { name: 'Nope' }],
      ['POST', '/api/destinations', { name: 'Nope' }],
      ['POST', '/api/property-types', { name: 'Nope' }],
      ['POST', '/api/deals', { leadName: 'Nope' }],
      ['POST', '/api/leads/import', { rows: [] }],
      ['POST', '/api/cold-calls/import', { rows: [] }],
      ['POST', '/api/admin/rebuild-reports', {}],
      ['PUT', '/api/agent-care/1', { name: 'x' }],
    ];
    for (const [method, path, body] of checks) assert.equal((await app.api.call(method, path, { token: who.token, body })).status, 403, `${who.role} ${method} ${path}`);
  }
});

test('profile update ignores role / status / team fields and a foreign user id (no mass assignment)', async () => {
  const r = await app.api.put('/api/profile', { id: A1.id, name: 'Renamed A2', role: 'admin', isActive: false, status: 0, parent_id: null, teamLeaderId: null }, A2.token);
  assert.equal(r.status, 200);
  const me = (await app.api.get('/api/auth/me', A2.token)).body.user;
  assert.equal(me.id, A2.id);
  assert.equal(me.role, 'agent');
  assert.equal(me.email, A2.email);
  assert.equal(me.isActive, true);
  assert.equal(me.teamLeaderId, T.id);
  assert.equal(me.name, 'Renamed A2');
  assert.notEqual((await app.api.get('/api/auth/me', A1.token)).body.user.name, 'Renamed A2');
});

test('a user can change their own e-mail: validated, unique, and it becomes the sign-in name', async () => {
  const mine = await app.createUser({ teamLeaderId: T2.id });
  assert.equal((await app.api.put('/api/profile', { email: 'not-an-email' }, mine.token)).status, 400);
  assert.equal((await app.api.put('/api/profile', { email: '' }, mine.token)).status, 400);
  const taken = await app.api.put('/api/profile', { email: A1.email.toUpperCase() }, mine.token);
  assert.equal(taken.status, 409);
  assert.equal(taken.body.code, 'EMAIL_TAKEN');
  const fresh = `renamed.${mine.id}.${app.runTag}@test.local`;
  const ok = await app.api.put('/api/profile', { email: fresh, phone: '01012345678' }, mine.token);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.email, fresh);
  assert.equal((await app.api.get('/api/auth/me', mine.token)).status, 200, 'the same session keeps working');
  assert.equal((await app.api.post('/api/auth/login', { email: fresh, password: mine.password })).status, 200);
  assert.equal((await app.api.post('/api/auth/login', { email: mine.email, password: mine.password })).status, 401);
  assert.equal((await app.api.put('/api/profile', { email: fresh, name: 'Same Mail' }, mine.token)).status, 200, 'resending the unchanged address is fine');
  assert.equal((await app.api.del(`/api/users/${mine.id}`, app.adminToken)).status, 200);
});

test('avatar must be a small image data-URL or an http(s) URL', async () => {
  assert.equal((await app.api.put('/api/profile', { avatar: 'javascript:alert(1)' }, A1.token)).status, 400);
  assert.equal((await app.api.put('/api/profile', { avatar: 'data:text/html;base64,PHNjcmlwdD4=' }, A1.token)).status, 400);
  assert.equal((await app.api.put('/api/profile', { avatar: `data:image/png;base64,${'A'.repeat(500000)}` }, A1.token)).status, 400);
  assert.equal((await app.api.put('/api/profile', { avatar: 'data:image/png;base64,iVBORw0KGgo=' }, A1.token)).status, 200);
  // resetting the picture stores the legacy placeholder, which the API reports as "no picture" (no third-party hot-link)
  const reset = await app.api.put('/api/profile', { avatar: '' }, A1.token);
  assert.equal(reset.status, 200);
  assert.equal((await app.api.get('/api/auth/me', A1.token)).body.user.avatar, undefined);
});

test('record visibility follows the hierarchy; siblings and other teams see nothing', async () => {
  const id = (await app.api.post('/api/leads', lead({ name: 'Visible To Chain', assignedToId: A1.id }), app.adminToken)).body.id;
  const sees = async (who) => idsOf(await app.api.get('/api/leads', who.token)).includes(id);
  assert.equal(await sees(A1), true, 'owner');
  assert.equal(await sees(T), true, 'direct manager');
  assert.equal(await sees(D), true, 'manager of manager');
  assert.equal(await sees({ token: app.adminToken }), true, 'admin');
  assert.equal(await sees(A2), false, 'sibling agent');
  assert.equal(await sees(T2), false, 'other team lead');
  assert.equal(await sees(B), false, 'agent from another team');
  assert.equal((await app.api.get(`/api/leads/${id}`, A2.token)).status, 404, 'single-record read is scoped too');
  assert.equal((await app.api.get(`/api/leads/${id}`, T.token)).status, 200);
});

test('IDOR: an agent cannot read, edit, reassign, delete or comment on a lead owned by someone else', async () => {
  const id = (await app.api.post('/api/leads', lead({ name: 'Protected', assignedToId: A1.id }), app.adminToken)).body.id;
  for (const attacker of [A2, B, T2]) {
    assert.equal((await app.api.put(`/api/leads/${id}`, { name: 'Hacked' }, attacker.token)).status, 404, 'edit');
    assert.equal((await app.api.put(`/api/leads/${id}`, { assignedToId: attacker.id }, attacker.token)).status, 404, 'steal');
    assert.equal((await app.api.del(`/api/leads/${id}`, attacker.token)).status, 404, 'delete');
    assert.equal((await app.api.post('/api/leads/bulk-delete', { ids: [id] }, attacker.token)).status, 404, 'bulk delete');
    assert.equal((await app.api.post('/api/comments', { entityType: 'lead', entityId: id, content: 'hi' }, attacker.token)).status, 404, 'comment');
  }
  const still = (await app.api.get('/api/leads', app.adminToken)).body.find((l) => l.id === id);
  assert.equal(still.name, 'Protected');
  assert.equal(still.assignedToId, A1.id);
});

test("the owner and the owner's managers can edit; a manager can delete within the subtree", async () => {
  const { id } = (await app.api.post('/api/leads', lead({ name: 'Editable', assignedToId: A1.id }), app.adminToken)).body;
  assert.equal((await app.api.put(`/api/leads/${id}`, { name: 'By Owner' }, A1.token)).status, 200);
  assert.equal((await app.api.put(`/api/leads/${id}`, { name: 'By Manager' }, T.token)).status, 200);
  assert.equal((await app.api.put(`/api/leads/${id}`, { projectId: 2 }, D.token)).status, 200);
  const now = (await app.api.get('/api/leads', A1.token)).body.find((l) => l.id === id);
  assert.equal(now.name, 'By Manager', 'a project-only update keeps every other field');
  assert.equal(now.projectId, 2);
  assert.equal((await app.api.del(`/api/leads/${id}`, T.token)).status, 200);
});

test('assignment rules: agents cannot hand leads to others; managers only inside their subtree; targets must exist and be active', async () => {
  const mine = (await app.api.post('/api/leads', lead({ name: 'Assign Me' }), A1.token)).body.id;
  assert.equal((await app.api.put(`/api/leads/${mine}`, { assignedToId: A2.id }, A1.token)).status, 403, 'agent reassigning');
  assert.equal((await app.api.post('/api/leads', lead({ assignedToId: A2.id }), A1.token)).status, 403, 'agent creating for someone else');
  assert.equal((await app.api.post('/api/leads', lead({ assignedToId: A1.id }), A1.token)).status, 200, 'agent creating for themselves (what the UI sends)');
  assert.equal((await app.api.put(`/api/leads/${mine}`, { assignedToId: A2.id }, T.token)).status, 200, 'manager within subtree');
  assert.equal((await app.api.put(`/api/leads/${mine}`, { assignedToId: B.id }, T.token)).status, 403, 'manager outside subtree');
  assert.equal((await app.api.put(`/api/leads/${mine}`, { assignedToId: 999999 }, app.adminToken)).status, 400, 'unknown user');
  const inactive = await app.createUser();
  await app.api.put(`/api/users/${inactive.id}`, { isActive: false }, app.adminToken);
  assert.equal((await app.api.put(`/api/leads/${mine}`, { assignedToId: inactive.id }, app.adminToken)).status, 400, 'inactive user');
  assert.equal((await app.api.put(`/api/leads/${mine}`, { assignedToId: B.id }, app.adminToken)).status, 200, 'admin anywhere');
  assert.equal((await app.api.put(`/api/leads/${mine}`, { assignedToId: null }, T2.token)).status, 403, 'unassigning needs admin');
});

test('a lead created by an agent is owned by that agent and shows up in their list', async () => {
  const r = await app.api.post('/api/leads', lead({ name: 'Mine After Create' }), A1.token);
  assert.equal(r.status, 200);
  assert.equal(r.body.item.assignedToId, A1.id);
  assert.equal(r.body.item.teamLeaderId, T.id);
  assert.ok(idsOf(await app.api.get('/api/leads', A1.token)).includes(r.body.id));
});

test('an admin may create an unassigned lead; only admins see it', async () => {
  const r = await app.api.post('/api/leads', lead({ name: 'Pool Lead' }), app.adminToken);
  assert.equal(r.body.item.assignedToId, undefined);
  assert.ok(idsOf(await app.api.get('/api/leads', app.adminToken)).includes(r.body.id));
  assert.ok(!idsOf(await app.api.get('/api/leads', D.token)).includes(r.body.id));
});

test('bulk operations are all-or-nothing and scope-checked', async () => {
  const ok1 = (await app.api.post('/api/leads', lead({ assignedToId: A1.id }), app.adminToken)).body.id;
  const ok2 = (await app.api.post('/api/leads', lead({ assignedToId: A1.id }), app.adminToken)).body.id;
  const foreign = (await app.api.post('/api/leads', lead({ assignedToId: B.id }), app.adminToken)).body.id;
  assert.equal((await app.api.post('/api/leads/bulk-assign', { ids: [ok1, ok2, foreign], assignedToId: A2.id }, T.token)).status, 404);
  let list = (await app.api.get('/api/leads', app.adminToken)).body;
  assert.equal(list.find((l) => l.id === ok1).assignedToId, A1.id, 'nothing changed');
  assert.equal((await app.api.post('/api/leads/bulk-assign', { ids: [ok1, ok2], assignedToId: A2.id }, T.token)).status, 200);
  list = (await app.api.get('/api/leads', app.adminToken)).body;
  assert.equal(list.find((l) => l.id === ok1).assignedToId, A2.id);
  assert.equal(list.find((l) => l.id === ok2).assignedToId, A2.id);
  assert.equal((await app.api.post('/api/leads/bulk-assign', { ids: [ok1], assignedToId: A1.id }, A1.token)).status, 403);
  assert.equal((await app.api.post('/api/leads/bulk-delete', { ids: [ok1, foreign] }, T.token)).status, 404);
  assert.equal((await app.api.post('/api/leads/bulk-delete', { ids: [ok1, ok2] }, T.token)).status, 200);
  assert.equal((await app.api.post('/api/leads/bulk-delete', { ids: 'nope' }, T.token)).status, 400);
  assert.equal((await app.api.post('/api/leads/bulk-delete', { ids: Array.from({ length: 501 }, (_, i) => i + 1) }, T.token)).status, 400);
});

test('cold calls follow the same ownership rules', async () => {
  const mine = await app.api.post('/api/cold-calls', { name: 'Cold', phone: phone() }, A1.token);
  assert.equal(mine.status, 200);
  assert.equal(mine.body.item.assignedToId, A1.id);
  assert.equal((await app.api.put(`/api/cold-calls/${mine.body.id}`, { name: 'Hacked' }, A2.token)).status, 404);
  assert.equal((await app.api.del(`/api/cold-calls/${mine.body.id}`, B.token)).status, 404);
  assert.equal((await app.api.put(`/api/cold-calls/${mine.body.id}`, { name: 'By Lead' }, T.token)).status, 200);
  assert.equal((await app.api.post('/api/cold-calls/bulk-assign', { ids: [mine.body.id], assignedToId: A2.id }, T.token)).status, 200);
  assert.ok(idsOf(await app.api.get('/api/cold-calls', A2.token)).includes(mine.body.id));
});

test('comments: the author is always the signed-in user (forgery ignored); outsiders cannot edit or delete', async () => {
  const leadId = (await app.api.post('/api/leads', lead({ assignedToId: A1.id }), app.adminToken)).body.id;
  const forged = await app.api.post('/api/comments', { entityType: 'lead', entityId: leadId, leadId, content: 'I approve', createdBy: 'Agent B', createdById: B.id }, A1.token);
  assert.equal(forged.status, 200);
  assert.equal(forged.body.item.createdById, A1.id);
  assert.equal((await app.api.get('/api/comments', app.adminToken)).body.find((c) => c.id === forged.body.id).createdById, A1.id);
  assert.equal((await app.api.put(`/api/comments/${forged.body.id}`, { content: 'edited by sibling' }, A2.token)).status, 403);
  assert.equal((await app.api.del(`/api/comments/${forged.body.id}`, A2.token)).status, 403);
  assert.equal((await app.api.put(`/api/comments/${forged.body.id}`, { content: 'edited by author', createdById: B.id, entityId: 1 }, A1.token)).status, 200);
  const after1 = (await app.api.get('/api/comments', A1.token)).body.find((c) => c.id === forged.body.id);
  assert.equal(after1.content, 'edited by author');
  assert.equal(after1.createdById, A1.id);
  assert.equal(after1.entityId, leadId);
  assert.equal((await app.api.del(`/api/comments/${forged.body.id}`, app.adminToken)).status, 200);
});

test("comment visibility: managers see their team's comments; after a reassignment the new owner sees the history", async () => {
  const leadId = (await app.api.post('/api/leads', lead({ assignedToId: A1.id }), app.adminToken)).body.id;
  const c = (await app.api.post('/api/comments', { entityType: 'lead', entityId: leadId, content: 'first contact' }, A1.token)).body.id;
  const seen = async (who) => idsOf(await app.api.get('/api/comments', who.token)).includes(c);
  assert.equal(await seen(T), true);
  assert.equal(await seen(A2), false);
  assert.equal(await seen(B), false);
  assert.equal((await app.api.put(`/api/leads/${leadId}`, { assignedToId: A2.id }, T.token)).status, 200);
  assert.equal(await seen(A2), true);
  assert.equal(await seen(A1), true);
});

test('users list: agents see only themselves, managers their subtree, admins everyone; no password field anywhere', async () => {
  const ids = async (who) => (await app.api.get('/api/users', who.token)).body.map((u) => u.id).sort((a, b) => a - b);
  assert.deepEqual(await ids(A1), [A1.id]);
  assert.deepEqual(await ids(T), [T.id, A1.id, A2.id].sort((a, b) => a - b));
  assert.ok((await ids({ token: app.adminToken })).length >= 7);
  for (const u of (await app.api.get('/api/users', app.adminToken)).body) assert.equal('password' in u, false);
});

test('deals: only admins write; everyone reads only the deals in their scope', async () => {
  const dealA1 = await app.api.post('/api/deals', { leadName: 'Deal One', agentId: A1.id, projectId: 1, developerId: 1, amount: 1000000, commission: 20000, status: 'pending' }, app.adminToken);
  assert.equal(dealA1.status, 200, JSON.stringify(dealA1.body));
  const dealB = await app.api.post('/api/deals', { leadName: 'Deal B', agentId: B.id, amount: 5, commission: 1 }, app.adminToken);
  assert.equal(dealB.status, 200);
  assert.ok(idsOf(await app.api.get('/api/deals', A1.token)).includes(dealA1.body.id));
  assert.ok(idsOf(await app.api.get('/api/deals', T.token)).includes(dealA1.body.id));
  assert.ok(!idsOf(await app.api.get('/api/deals', A1.token)).includes(dealB.body.id));
  assert.equal((await app.api.put(`/api/deals/${dealA1.body.id}`, { amount: 1 }, A1.token)).status, 403);
  assert.equal((await app.api.del(`/api/deals/${dealA1.body.id}`, A1.token)).status, 403);
});

test('reports follow comments incrementally and respect scope', async () => {
  const leadId = (await app.api.post('/api/leads', lead({ name: 'Report Subject', assignedToId: A1.id }), app.adminToken)).body.id;
  const c = (await app.api.post('/api/comments', { entityType: 'lead', entityId: leadId, content: 'needs follow up' }, A1.token)).body.id;
  const find = async (who) => (await app.api.get('/api/reports', who.token)).body.find((r) => r.commentId === c);
  const row = await find(A1);
  assert.equal(row.clientName, 'Report Subject');
  assert.equal(row.agentName, A1.name);
  assert.equal(row.teamLeaderName, T.name);
  assert.ok(await find(T));
  assert.equal(await find(B), undefined);
  assert.equal(await find(A2), undefined);
  await app.api.put(`/api/leads/${leadId}`, { name: 'Renamed Subject', statusId: 3 }, A1.token);
  const refreshed = await find(A1);
  assert.equal(refreshed.clientName, 'Renamed Subject');
  assert.equal(refreshed.statusName, 'Potential');
  await app.api.put(`/api/comments/${c}`, { content: 'edited note' }, A1.token);
  assert.equal((await find(A1)).content, 'edited note');
  await app.api.del(`/api/comments/${c}`, A1.token);
  assert.equal(await find(A1), undefined);
});

test('secondary resources: tasks/notifications/knowledge base follow ownership rules', async () => {
  const task = await app.api.post('/api/tasks', { title: 'Call back', dueDate: '2026-05-01' }, A1.token);
  assert.equal(task.status, 200);
  assert.equal(task.body.item.assignedToId, A1.id);
  assert.equal((await app.api.put(`/api/tasks/${task.body.id}`, { status: 'Done' }, A2.token)).status, 404);
  assert.equal((await app.api.put(`/api/tasks/${task.body.id}`, { status: 'Done' }, T.token)).status, 200);
  assert.equal((await app.api.post('/api/tasks', { title: 'For someone else', assignedToId: B.id }, A1.token)).status, 403);
  assert.equal((await app.api.post('/api/tasks', {}, A1.token)).status, 400);
  const note = await app.api.post('/api/notifications', { title: 'Hello' }, A1.token);
  assert.equal((await app.api.get('/api/notifications', A2.token)).body.some((n) => n.id === note.body.id), false);
  assert.equal((await app.api.put(`/api/notifications/${note.body.id}`, { isRead: true }, T.token)).status, 404, 'private, even for managers');
  assert.equal((await app.api.put(`/api/notifications/${note.body.id}`, { isRead: true }, A1.token)).body.item.isRead, true);
  assert.equal((await app.api.post('/api/knowledge-base', { title: 'Guide' }, A1.token)).status, 403);
  assert.equal((await app.api.post('/api/knowledge-base', { title: 'Guide', content: 'x', projectId: 1 }, app.adminToken)).status, 200);
  assert.ok((await app.api.get('/api/knowledge-base', A1.token)).body.length >= 1);
  assert.equal((await app.api.post('/api/calendar-events', { title: 'Meeting', startAt: '2026-06-01T10:00:00Z', endAt: 'garbage' }, A1.token)).status, 400);
  assert.equal((await app.api.post('/api/calendar-events', { title: 'Meeting', startAt: '2026-06-01T10:00:00Z' }, A1.token)).status, 200);
});

test('activity log: scoped, paged, and secrets (also in OLD rows) are redacted', async () => {
  await app.pool.query("INSERT INTO activity_logs (user_id, entity_type, entity_id, action, summary, metadata, created_at) VALUES (?, 'users', 5, 'deleted', 'old row', ?, '2026-01-01 00:00:00')",
    [A1.id, JSON.stringify({ email: 'x@y.z', password: '$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ0123', image: 'data:image/png;base64,AAAA' })]);
  const mine = (await app.api.get('/api/activity-logs?limit=1000', A1.token)).body;
  assert.ok(mine.length > 0);
  assert.ok(mine.every((l) => l.userId === A1.id), 'agents only see their own activity');
  const old = mine.find((l) => l.summary === 'old row');
  assert.equal(old.metadata.password, '[redacted]');
  assert.equal(old.metadata.image, '[redacted]');
  assert.equal((await app.api.get('/api/activity-logs?limit=3&offset=1', app.adminToken)).body.length, 3);
  assert.equal((await app.api.get('/api/activity-logs?limit=-5&offset=abc;DROP', app.adminToken)).status, 200);
  assert.equal(/\$2[aby]\$\d\d\$/.test(JSON.stringify((await app.api.get('/api/activity-logs?limit=1000', app.adminToken)).body)), false);
});

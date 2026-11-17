import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from '../support/harness.js';

/**
 * Number Pool: ownership and the strict reporting-tree privacy rule (no role bypass).
 *
 *   CEO (ceo)
 *   ├── HoS1 (head_of_sales)
 *   │   └── Dir1 (director)
 *   │       └── Mgr1 (sales_manager)
 *   │           └── Sup1 (sales_supervisor)
 *   │               ├── TL1 (team_leader) ── A, B (agents)
 *   │               └── TL2 (team_leader) ── C (agent)          sibling team of TL1
 *   └── HoS2 (head_of_sales)
 *       └── Mgr2 (sales_manager) ── TL3 (team_leader) ── D      another branch
 *   Admin (the harness administrator) and FO (franchise_owner): outside the reporting tree.
 */
let app; let U = {}; let batches = {};
const get = (path, who) => app.api.get(`/api${path}`, U[who]?.token ?? who);
const post = (path, body, who) => app.api.post(`/api${path}`, body, U[who]?.token ?? who);
const ids = (list) => new Set(list.map((x) => x.id));
const owners = (list) => new Set(list.map((x) => x.userId));
const NUMBERS = 70;
let phones = [];

before(async () => {
  app = await startTestApp();
  U.admin = { id: null, token: app.adminToken };
  const mk = async (key, role, parent) => { U[key] = await app.createUser({ name: `${key} ${app.runTag}`, role, ...(parent ? { teamLeaderId: U[parent].id } : {}) }); };
  await mk('CEO', 'ceo');
  await mk('HoS1', 'head_of_sales', 'CEO');
  await mk('HoS2', 'head_of_sales', 'CEO');
  await mk('Dir1', 'director', 'HoS1');
  await mk('Mgr1', 'sales_manager', 'Dir1');
  await mk('Mgr2', 'sales_manager', 'HoS2');
  await mk('Sup1', 'sales_supervisor', 'Mgr1');
  await mk('TL1', 'team_leader', 'Sup1');
  await mk('TL2', 'team_leader', 'Sup1');
  await mk('TL3', 'team_leader', 'Mgr2');
  await mk('A', 'agent', 'TL1');
  await mk('B', 'agent', 'TL1');
  await mk('C', 'agent', 'TL2');
  await mk('D', 'agent', 'TL3');
  await mk('FO', 'franchise_owner');

  phones = Array.from({ length: NUMBERS }, () => app.uniquePhone('011'));
  const rows = phones.map((phone, i) => ({
    name: `Pool Client ${i}`,
    phone,
    fields: {
      Name: `Pool Client ${i}`, Mobile: phone, Destination: 'New Cairo', Budget: '3M - 5M', 'Property Type': 'Apartment',
      Delivery: 'RTM', Finishing: 'Semi finished', 'Purpose of Purchase': 'Investment', 'Down Payment': '500k',
      Installments: '120,000', 'Preferred floor': 'High', Notes: `uploaded note ${i}`,
    },
  }));
  const imported = await post('/pool/import', { rows, fileName: 'pool.xlsx' }, 'admin');
  assert.equal(imported.status, 200, imported.text);
  assert.equal(imported.body.count, NUMBERS);

  for (const [who, size] of [['A', 10], ['B', 10], ['C', 5], ['D', 5]]) {
    const r = await post('/pool/batches', { size }, who);
    assert.equal(r.status, 200, `${who}: ${r.text}`);
    batches[who] = r.body.item;
  }
});
after(async () => { await app?.stop(); });

// ---------------------------------------------------------------- ownership --------------------------------------
test('automatic ownership: every number of a requested batch belongs to the requesting agent, with batch id and timestamp', async () => {
  const b = batches.A;
  assert.equal(b.userId, U.A.id);
  assert.equal(b.requestedById, U.A.id);
  assert.equal(b.sizeAllocated, 10);
  assert.equal(b.items.length, 10);
  for (const item of b.items) {
    assert.equal(item.userId, U.A.id);
    assert.equal(item.batchId, b.id);
    assert.ok(item.allocatedAt, 'allocation timestamp');
    assert.equal(item.state, 'open');
  }
  const rows = (await app.pool.query('SELECT user_id, batch_id, status, allocated_at FROM pool_numbers WHERE batch_id = ?', [b.id]))[0];
  assert.equal(rows.length, 10);
  for (const r of rows) {
    assert.equal(Number(r.user_id), U.A.id, 'stored owner is the agent, not a team or manager');
    assert.equal(r.status, 'allocated');
    assert.ok(r.allocated_at);
  }
  const all = [...batches.A.items, ...batches.B.items, ...batches.C.items, ...batches.D.items].map((i) => i.numberId);
  assert.equal(new Set(all).size, all.length, 'no number is in two batches');
});

test('the owner id in a request body is ignored: the batch always belongs to the caller', async () => {
  const fresh = await app.createUser({ name: `E ${app.runTag}`, role: 'agent', teamLeaderId: U.TL1.id });
  const r = await app.api.post('/api/pool/batches', { size: 5, userId: U.D.id, user_id: U.D.id, assignedToId: U.D.id }, fresh.token);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.item.userId, fresh.id);
  assert.ok(r.body.item.items.every((i) => i.userId === fresh.id));
});

test('only agents request batches, only sizes 5 / 10 / 20, and one open batch at a time', async () => {
  assert.equal((await post('/pool/batches', { size: 5 }, 'TL1')).status, 403);
  assert.equal((await post('/pool/batches', { size: 5 }, 'admin')).status, 403);
  for (const size of [0, 3, 7, 15, 25, 'ten', null]) assert.equal((await post('/pool/batches', { size }, 'A')).status, 400, `size ${size}`);
  const again = await post('/pool/batches', { size: 5 }, 'A');
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'ACTIVE_BATCH');
});

test('full requirements: every uploaded field is preserved and shown to the owner', async () => {
  const item = batches.A.items[0];
  const r = await get(`/pool/items/${item.id}`, 'A');
  assert.equal(r.status, 200, r.text);
  const req = r.body.requirements;
  assert.equal(req.destination, 'New Cairo');
  assert.equal(req.propertyType, 'Apartment');
  assert.equal(req.budgetMin, 3000000);
  assert.equal(req.budgetMax, 5000000);
  assert.equal(req.delivery, 'ready_to_move');
  assert.equal(req.finishing, 'semi_finished');
  assert.equal(req.purpose, 'investment');
  assert.equal(req.downPayment, 500000);
  assert.equal(req.installment, 120000);
  assert.equal(req.original['Preferred floor'], 'High', 'additional columns are kept');
  assert.match(r.body.numberNotes, /uploaded note/);
});

// ---------------------------------------------------------------- 1-7: agent isolation -----------------------------
test('1-4. Agent A cannot see Agent B\'s batch, history, requirements or direct URLs (404, nothing revealed)', async () => {
  const bBatch = batches.B;
  const bItem = bBatch.items[0];
  const r1 = await get(`/pool/batches/${bBatch.id}`, 'A');
  assert.equal(r1.status, 404);
  assert.doesNotMatch(r1.text, new RegExp(bItem.phone));
  const r2 = await get(`/pool/items/${bItem.id}`, 'A');
  assert.equal(r2.status, 404);
  assert.doesNotMatch(r2.text, /New Cairo|Pool Client/);
  // a missing id and another agent's id look exactly the same
  const missing = await get('/pool/items/99999999', 'A');
  assert.deepEqual({ status: missing.status, code: missing.body.code }, { status: r2.status, code: r2.body.code });
  const list = await get('/pool/batches', 'A');
  assert.deepEqual(owners(list.body.items), new Set([U.A.id]));
  const items = await get('/pool/items', 'A');
  assert.deepEqual(owners(items.body.items), new Set([U.A.id]));
});

test('5. Agent A cannot obtain Agent B\'s data through filters, search, paging or manipulated ids', async () => {
  const bItem = batches.B.items[0];
  for (const qs of [`userId=${U.B.id}`, `batchId=${batches.B.id}`, `q=${bItem.phone}`, `q=${encodeURIComponent(bItem.name)}`, `userId=${U.B.id}&page=1&pageSize=5000`]) {
    const r = await get(`/pool/items?${qs}`, 'A');
    assert.equal(r.status, 200, qs);
    assert.ok(r.body.items.every((i) => i.userId === U.A.id), `${qs} leaked another agent's numbers`);
    assert.ok(!r.text.includes(bItem.phone), qs);
  }
  assert.equal((await get(`/pool/batches?userId=${U.B.id}`, 'A')).body.items.length, 0);
  assert.equal((await get(`/pool/report?userId=${U.B.id}`, 'A')).body.rows.length, 0);
});

test('6. exports: the largest page an agent can request (what Excel / PDF exports use) contains only their own numbers', async () => {
  const r = await get('/pool/items?pageSize=5000', 'A');
  assert.equal(r.status, 200);
  assert.ok(r.body.items.length >= 10);
  assert.deepEqual(owners(r.body.items), new Set([U.A.id]));
  assert.equal(r.body.total, r.body.items.length, 'the total does not count other people\'s numbers');
  for (const other of ['B', 'C', 'D']) for (const i of batches[other].items) assert.ok(!r.text.includes(i.phone), `${other}'s phone in A's export`);
});

test('7. reports: an agent\'s report holds only their own row; another team\'s report is not reachable', async () => {
  const r = await get('/pool/report', 'A');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.rows.map((x) => x.userId), [U.A.id]);
  assert.equal(r.body.totals.allocated, 10);
  assert.equal((await get('/pool/summary', 'A')).status, 403, 'company summary is for administrators only');
});

test('agents can only act on their own numbers; only managers above them can hand numbers back', async () => {
  const bItem = batches.B.items[1];
  assert.equal((await post(`/pool/items/${bItem.id}/process`, { outcome: 'no_answer' }, 'A')).status, 404, 'another agent\'s number');
  assert.equal((await post(`/pool/items/${bItem.id}/process`, { outcome: 'no_answer' }, 'TL1')).status, 403, 'a manager cannot record calls for the agent');
  assert.equal((await post(`/pool/batches/${batches.B.id}/release`, {}, 'A')).status, 404, 'agent cannot release a teammate\'s batch');
  assert.equal((await post(`/pool/batches/${batches.A.id}/release`, {}, 'A')).status, 403, 'agent cannot release their own batch');
  assert.equal((await post(`/pool/batches/${batches.A.id}/cancel`, {}, 'TL2')).status, 404, 'a sibling team leader cannot');
  assert.equal((await post(`/pool/batches/${batches.A.id}/cancel`, {}, 'admin')).status, 404, 'an admin outside the tree cannot');
  const rows = (await app.pool.query('SELECT COUNT(*) AS c FROM pool_batch_items WHERE batch_id = ? AND ended_at IS NULL', [batches.B.id]))[0];
  assert.equal(Number(rows[0].c), 10, 'nothing was changed by the refused requests');
});

// ---------------------------------------------------------------- 8-13: managers -----------------------------------
const visibleOwners = async (who) => owners((await get('/pool/items?pageSize=5000', who)).body.items);
const visibleBatches = async (who) => owners((await get('/pool/batches?pageSize=5000', who)).body.items);

test('8-9. a team leader sees their own team (A, B) and never the sibling team (C) or another branch (D)', async () => {
  const tl1 = await visibleOwners('TL1');
  assert.ok(tl1.has(U.A.id) && tl1.has(U.B.id));
  assert.ok(!tl1.has(U.C.id) && !tl1.has(U.D.id));
  assert.equal((await get(`/pool/batches/${batches.A.id}`, 'TL1')).status, 200);
  assert.equal((await get(`/pool/items/${batches.B.items[0].id}`, 'TL1')).body.requirements.destination, 'New Cairo', 'full requirements for the team');
  assert.equal((await get(`/pool/batches/${batches.C.id}`, 'TL1')).status, 404);
  assert.equal((await get(`/pool/items/${batches.C.items[0].id}`, 'TL1')).status, 404);
  const tl2 = await visibleOwners('TL2');
  assert.deepEqual(tl2, new Set([U.C.id]), 'two team leaders never see each other\'s teams');
});

test('10. a manager sees every descendant (A, B, C); two managers never see each other\'s teams', async () => {
  for (const who of ['Mgr1', 'Sup1']) {
    const seen = await visibleOwners(who);
    for (const a of ['A', 'B', 'C']) assert.ok(seen.has(U[a].id), `${who} sees ${a}`);
    assert.ok(!seen.has(U.D.id), `${who} must not see D`);
  }
  assert.deepEqual(await visibleOwners('Mgr2'), new Set([U.D.id]));
  assert.equal((await get(`/pool/batches/${batches.A.id}`, 'Mgr2')).status, 404);
});

test('11-12. director and head of sales see their own subtree only', async () => {
  for (const who of ['Dir1', 'HoS1']) {
    const seen = await visibleOwners(who);
    assert.ok(['A', 'B', 'C'].every((a) => seen.has(U[a].id)), who);
    assert.ok(!seen.has(U.D.id), `${who} must not see the other head of sales' branch`);
  }
  const hos2 = await visibleOwners('HoS2');
  assert.ok(hos2.has(U.D.id) && !hos2.has(U.A.id));
});

test('13. the CEO, at the top of the tree, sees the complete company tree', async () => {
  const seen = await visibleOwners('CEO');
  for (const a of ['A', 'B', 'C', 'D']) assert.ok(seen.has(U[a].id), a);
  const report = await get('/pool/report', 'CEO');
  assert.ok(['A', 'B', 'C', 'D'].every((a) => report.body.rows.some((r) => r.userId === U[a].id)));
  assert.equal((await get(`/pool/items/${batches.D.items[0].id}`, 'CEO')).status, 200);
});

test('14. an admin or franchise owner outside the reporting chain sees no detailed records, only anonymous totals', async () => {
  for (const who of ['admin', 'FO']) {
    assert.equal((await get('/pool/items?pageSize=5000', who)).body.items.length, 0, `${who} items`);
    assert.equal((await get('/pool/batches', who)).body.items.length, 0, `${who} batches`);
    assert.equal((await get('/pool/report', who)).body.rows.length, 0, `${who} report`);
    assert.equal((await get(`/pool/batches/${batches.A.id}`, who)).status, 404, `${who} batch by id`);
    assert.equal((await get(`/pool/items/${batches.A.items[0].id}`, who)).status, 404, `${who} number by id`);
    assert.equal((await get(`/pool/items?userId=${U.A.id}`, who)).body.items.length, 0, `${who} filter by user`);
    const summary = await get('/pool/summary', who);
    assert.equal(summary.status, 200);
    assert.ok(summary.body.numbers.allocated >= 30);
    for (const p of phones) assert.ok(!summary.text.includes(p), 'the summary contains no phone numbers');
    assert.ok(!summary.text.includes(U.A.name), 'nor agent names');
  }
});

test('15. changing user ids or batch ids in requests never bypasses authorization', async () => {
  const cases = [
    ['GET', `/pool/batches/${batches.D.id}`, 'Mgr1'],
    ['GET', `/pool/items/${batches.D.items[0].id}`, 'HoS1'],
    ['GET', `/pool/batches/${batches.A.id}`, 'C'],
    ['POST', `/pool/batches/${batches.D.id}/release`, 'TL1'],
    ['POST', `/pool/batches/${batches.D.id}/cancel`, 'Dir1'],
    ['POST', `/pool/items/${batches.D.items[0].id}/process`, 'A'],
  ];
  for (const [method, path, who] of cases) {
    const r = await app.api.call(method, `/api${path}`, { token: U[who].token, body: method === 'POST' ? { outcome: 'no_answer', userId: U[who].id } : undefined });
    assert.equal(r.status, 404, `${who} ${method} ${path}`);
  }
  for (const qs of [`userId=${U.D.id}`, `batchId=${batches.D.id}`, `userId=${U.A.id}&userId=${U.D.id}`, 'userId=0', "userId=1 OR 1=1"]) {
    const r = await get(`/pool/items?${qs}`, 'TL1');
    assert.ok(r.status === 200 || r.status === 400, qs);
    if (r.status === 200) assert.ok(r.body.items.every((i) => [U.A.id, U.B.id].includes(i.userId)), qs);
  }
});

test('16. visibility is the same after logout / login and refresh', async () => {
  const before = await visibleOwners('TL1');
  await app.api.post('/api/auth/logout', {}, U.TL1.token);
  const token = await app.login(U.TL1.email, U.TL1.password);
  const after = owners((await app.api.get('/api/pool/items?pageSize=5000', token)).body.items);
  assert.deepEqual(after, before);
  assert.equal((await app.api.get(`/api/pool/batches/${batches.C.id}`, token)).status, 404);
  const tokenA = await app.login(U.A.email, U.A.password);
  assert.deepEqual(owners((await app.api.get('/api/pool/items', tokenA)).body.items), new Set([U.A.id]));
});

// ---------------------------------------------------------------- workflow & history --------------------------------
test('processing: the owner records results; "lead" creates a lead owned by the agent with the uploaded requirements', async () => {
  const [first, second, third] = batches.A.items;
  const lead = await post(`/pool/items/${first.id}/process`, { outcome: 'lead', notes: 'wants a call on Sunday' }, 'A');
  assert.equal(lead.status, 200, lead.text);
  assert.ok(lead.body.leadId);
  const created = await get(`/leads/${lead.body.leadId}`, 'A');
  assert.equal(created.status, 200);
  assert.equal(created.body.assignedToId, U.A.id);
  assert.equal(created.body.requirements.delivery, 'ready_to_move');
  assert.equal(created.body.requirements.finishing, 'semi_finished');
  assert.equal(created.body.requirements.purpose, 'investment');
  assert.equal(Number(created.body.requirements.budgetMax), 5000000);
  const history = await get(`/comments?entityType=lead&entityId=${lead.body.leadId}`, 'A');
  const text = JSON.stringify(history.body);
  assert.match(text, /wants a call on Sunday/);
  assert.match(text, /Destination: New Cairo/);
  assert.match(text, /Preferred floor: High/, 'additional uploaded columns travel with the lead');

  const cold = await post(`/pool/items/${second.id}/process`, { outcome: 'cold_call' }, 'A');
  assert.equal(cold.status, 200, cold.text);
  assert.ok(cold.body.coldCallId);
  assert.equal((await post(`/pool/items/${third.id}/process`, { outcome: 'not_interested' }, 'A')).status, 200);
  const twice = await post(`/pool/items/${third.id}/process`, { outcome: 'no_answer' }, 'A');
  assert.equal(twice.status, 409, 'a result is recorded once');
  assert.equal((await post(`/pool/items/${third.id}/process`, { outcome: 'sold' }, 'A')).status, 400);

  const report = (await get('/pool/report', 'TL1')).body;
  const rowA = report.rows.find((r) => r.userId === U.A.id);
  assert.equal(rowA.processed, 3);
  assert.equal(rowA.outcomes.lead, 1);
  assert.equal(rowA.open, 7);
});

test('release: a manager above the agent hands open numbers back; history keeps who had them; completed calls stay', async () => {
  const items = batches.A.items;
  const release = await post(`/pool/batches/${batches.A.id}/release`, { itemIds: [items[3].id, items[4].id] }, 'TL1');
  assert.equal(release.status, 200, release.text);
  assert.equal(release.body.count, 2);
  const numbers = (await app.pool.query('SELECT status, user_id FROM pool_numbers WHERE id IN (?, ?)', [items[3].numberId, items[4].numberId]))[0];
  assert.ok(numbers.every((n) => n.status === 'available' && n.user_id === null), 'back in the pool');
  const hist = await get(`/pool/items/${items[3].id}`, 'A');
  assert.equal(hist.status, 200, 'the agent still sees their past allocation');
  assert.equal(hist.body.userId, U.A.id, 'previous ownership kept');
  assert.equal(hist.body.state, 'released');
  assert.equal(hist.body.endedById, U.TL1.id);
  assert.equal((await get(`/pool/items/${items[0].id}`, 'A')).body.outcome, 'lead', 'completed call results are untouched');

  const cancel = await post(`/pool/batches/${batches.A.id}/cancel`, {}, 'Mgr1');
  assert.equal(cancel.status, 200, cancel.text);
  assert.equal(cancel.body.item.status, 'cancelled');
  assert.equal(cancel.body.item.counts.processed, 3);
  assert.equal(cancel.body.item.counts.open, 0);
  const rows = (await app.pool.query('SELECT COUNT(*) AS c FROM pool_batch_items WHERE batch_id = ?', [batches.A.id]))[0];
  assert.equal(Number(rows[0].c), 10, 'allocation history rows are never deleted');
  assert.equal((await post(`/pool/batches/${batches.A.id}/cancel`, {}, 'Mgr1')).status, 409);

  // A can request again; a released number may go to someone else, and A's old allocation stays A's history only
  const next = await post('/pool/batches', { size: 20 }, 'A');
  assert.equal(next.status, 200, next.text);
});

test('a user with pool history cannot be deleted (deactivate instead), so the history stays complete', async () => {
  const r = await app.api.del(`/api/users/${U.D.id}`, app.adminToken);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'HAS_POOL_HISTORY');
});

test('concurrent batch requests never hand the same number to two agents', async () => {
  const agents = await Promise.all(Array.from({ length: 6 }, (_, i) => app.createUser({ name: `Rush ${i} ${app.runTag}`, role: 'agent', teamLeaderId: U.TL2.id })));
  const results = await Promise.all(agents.map((a) => app.api.post('/api/pool/batches', { size: 5 }, a.token)));
  const got = results.filter((r) => r.status === 200).flatMap((r) => r.body.item.items.map((i) => i.numberId));
  assert.equal(new Set(got).size, got.length);
  assert.ok(results.every((r) => r.status === 200 || r.body.code === 'POOL_EMPTY'), results.map((r) => r.status).join(','));
  const same = await Promise.all([1, 2, 3].map(() => app.api.post('/api/pool/batches', { size: 5 }, agents[0].token)));
  assert.ok(same.every((r) => r.status === 409), 'a double click cannot create a second open batch');
});

test('import: administrators only; duplicates against the pool, Leads and Cold Calls are skipped; bad phones are counted', async () => {
  const leadPhone = app.uniquePhone('012');
  await app.api.post('/api/leads', { name: 'Existing', phone: leadPhone, statusId: 1 }, app.adminToken);
  const fresh = app.uniquePhone('015');
  const r = await post('/pool/import', { rows: [{ phone: phones[0] }, { phone: leadPhone }, { phone: 'abc' }, { phone: fresh, fields: { Budget: '7M' } }, { phone: fresh }] }, 'admin');
  assert.equal(r.status, 200, r.text);
  assert.deepEqual({ count: r.body.count, duplicates: r.body.duplicates, invalid: r.body.invalid }, { count: 1, duplicates: 3, invalid: 1 });
  for (const who of ['CEO', 'TL1', 'A']) assert.equal((await post('/pool/import', { rows: [{ phone: app.uniquePhone('015') }] }, who)).status, 403, who);
});

test('daily view: since / until (the browser\'s local midnight) start History, Batches and Report from 0 each day; older days stay available', async () => {
  // move batch C to "yesterday" (the data is kept; only today's window excludes it)
  const yesterday = new Date(Date.now() - 24 * 3600 * 1000);
  const sql = yesterday.toISOString().slice(0, 19).replace('T', ' ');
  await app.pool.query('UPDATE pool_batches SET created_at = ? WHERE id = ?', [sql, batches.C.id]);
  await app.pool.query('UPDATE pool_batch_items SET allocated_at = ? WHERE batch_id = ?', [sql, batches.C.id]);

  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + 1);
  const today = `since=${encodeURIComponent(start.toISOString())}&until=${encodeURIComponent(end.toISOString())}`;
  const dayBefore = new Date(start); dayBefore.setDate(dayBefore.getDate() - 1);
  const yWindow = `since=${encodeURIComponent(dayBefore.toISOString())}&until=${encodeURIComponent(start.toISOString())}`;

  // C's own views: today is empty (starts again from 0), yesterday still has everything
  assert.equal((await get(`/pool/items?${today}`, 'C')).body.total, 0);
  assert.equal((await get(`/pool/batches?${today}`, 'C')).body.items.length, 0);
  const reportToday = (await get(`/pool/report?${today}`, 'C')).body;
  assert.deepEqual([reportToday.rows.length, reportToday.totals.allocated], [0, 0]);
  assert.equal((await get(`/pool/items?${yWindow}`, 'C')).body.total, 5);
  assert.equal((await get(`/pool/batches?${yWindow}`, 'C')).body.items[0].id, batches.C.id);
  assert.equal((await get(`/pool/report?${yWindow}`, 'C')).body.totals.allocated, 5);

  // the window never widens the scope
  const tl1 = await get(`/pool/items?${yWindow}&pageSize=5000`, 'TL1');
  assert.ok(tl1.body.items.every((i) => [U.A.id, U.B.id].includes(i.userId)));
  for (const bad of ['since=yesterday', 'until=2026-13-45T00:00:00Z']) assert.equal((await get(`/pool/items?${bad}`, 'C')).status, 400, bad);
});

test('call result with the full request written by the agent: saved on the number for the managers, used for the lead', async () => {
  const opts = (await app.api.get('/api/lead-options', app.adminToken)).body;
  const dest = opts.destinations.filter((d) => d.isActive !== false).slice(0, 2);
  const type = opts.propertyTypes.find((t) => t.isActive !== false);
  assert.ok(dest.length && type, 'option lists are seeded');
  const request = {
    destinationIds: dest.map((d) => d.id), propertyTypeIds: [type.id], budgetMin: 4000000, budgetMax: 8000000,
    delivery: 'within_2_years', finishing: 'fully_finished', purpose: 'end_user', downPayment: 800000, installmentPerQuarter: 150000,
  };
  const [one, two, three] = batches.B.items;

  // invalid requests are refused and change nothing
  for (const bad of [{ ...request, budgetMin: 9000000 }, { ...request, delivery: 'tomorrow' }, { ...request, destinationIds: [99999] }, { ...request, purpose: 'upgrading' }]) {
    const r = await post(`/pool/items/${one.id}/process`, { outcome: 'lead', requirements: bad }, 'B');
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal((await get(`/pool/items/${one.id}`, 'B')).body.state, 'open', 'a refused request records nothing');
  assert.equal((await post(`/pool/items/${one.id}/process`, { outcome: 'lead', requirements: request }, 'A')).status, 404, 'only the holder');

  const lead = await post(`/pool/items/${one.id}/process`, { outcome: 'lead', notes: 'wants 3 bedrooms', requirements: request }, 'B');
  assert.equal(lead.status, 200, lead.text);
  const created = (await get(`/leads/${lead.body.leadId}`, 'B')).body;
  assert.deepEqual([...created.requirements.destinationIds].sort(), [...request.destinationIds].sort());
  assert.deepEqual(created.requirements.propertyTypeIds, [type.id]);
  assert.equal(Number(created.requirements.budgetMax), 8000000);
  assert.equal(created.requirements.delivery, 'within_2_years');
  assert.equal(created.requirements.finishing, 'fully_finished');
  assert.equal(created.requirements.purpose, 'end_user');
  assert.equal(Number(created.requirements.installmentPerQuarter), 150000);

  // the team leader sees what the client asked for; the upload itself is kept
  const seen = (await get(`/pool/items/${one.id}`, 'TL1')).body.requirements;
  assert.equal(seen.destination, dest.map((d) => d.name).join(', '));
  assert.equal(seen.propertyType, type.name);
  assert.deepEqual([seen.budgetMin, seen.budgetMax, seen.downPayment, seen.installment], [4000000, 8000000, 800000, 150000]);
  assert.equal(seen.delivery, 'within_2_years');
  assert.equal(seen.original.Destination, 'New Cairo', 'original upload untouched');
  assert.equal((await get(`/pool/items/${one.id}`, 'C')).status, 404, 'still private to the tree');

  // any result can carry the request (e.g. a call-back); without one the uploaded values stay
  assert.equal((await post(`/pool/items/${two.id}/process`, { outcome: 'cold_call', requirements: { ...request, destinationIds: [] } }, 'B')).status, 200);
  assert.equal((await get(`/pool/items/${two.id}`, 'B')).body.requirements.destination, null);
  assert.equal((await post(`/pool/items/${three.id}/process`, { outcome: 'no_answer' }, 'B')).status, 200);
  assert.equal((await get(`/pool/items/${three.id}`, 'B')).body.requirements.destination, 'New Cairo');
});

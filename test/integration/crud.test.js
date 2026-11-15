import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isMysql, schemaName, startTestApp } from '../support/harness.js';

let app; let T; let A1; let A2; let phone;
const q = async (sql, params) => (await app.pool.query(sql, params))[0];
const lead = (extra = {}) => ({ name: 'Client', phone: phone(), statusId: 1, ...extra });

before(async () => {
  app = await startTestApp();
  phone = () => app.uniquePhone('012');
  T = await app.createUser({ name: `TL ${app.runTag}`, role: 'team_leader' });
  A1 = await app.createUser({ name: `A1 ${app.runTag}`, teamLeaderId: T.id });
  A2 = await app.createUser({ name: `A2 ${app.runTag}`, teamLeaderId: T.id });
});
after(async () => { await app.stop(); });

// ---------------------------------------------------------------- leads --------------------------------------------
test('lead create: the response has the shape the frontend consumes', async () => {
  const r = await app.api.post('/api/leads', lead({ name: 'Shape', whatsapp: '+20 101 111 2222', source: 'Meta', projectId: 1, assignedToId: A1.id, date: '2026-03-04' }), app.adminToken);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const item = r.body.item;
  for (const key of ['id', 'type', 'name', 'phone', 'status', 'statusId', 'project', 'projectId', 'assignedTo', 'assignedToId', 'teamLeader', 'teamLeaderId', 'date', 'isPotential', 'requirements']) assert.ok(key in item, key);
  assert.equal(item.type, 'Lead');
  assert.equal(item.status, 'New Lead');
  assert.equal(item.source, 'Meta');
  assert.equal(item.project, 'SilverSands');
  assert.equal(item.assignedTo, A1.name);
  assert.equal(item.teamLeader, T.name);
  assert.equal(item.date, '2026-03-04');
  assert.equal(item.whatsapp, '01011112222', 'Egyptian numbers are stored in one canonical form');
  assert.equal(item.isPotential, false);
});

test('lead validation: every bad input is a 400 with field details, never a 500', async () => {
  const bad = [
    [{ phone: '01011112222' }, 'name'],
    [{ name: 'x' }, 'phone'],
    [{ name: 'x', phone: 'abc' }, 'phone'],
    [{ name: 'x', phone: '0101111222' }, 'phone'], // 10 digits
    [{ name: 'x', phone: '01311112222' }, 'phone'], // 013 is not a mobile prefix
    [{ name: 'x'.repeat(256), phone: '01011112222' }, 'name'],
    [{ name: 'x', phone: '01011112222', email: 'not-an-email' }, 'email'],
    [{ name: 'x', phone: '01011112222', date: 'not-a-date' }, 'date'],
    [{ name: 'x', phone: '01011112222', date: '2026-02-30' }, 'date'],
    [{ name: 'x', phone: '01011112222', statusId: 9999 }, 'statusId'],
    [{ name: 'x', phone: '01011112222', projectId: 9999 }, 'projectId'],
    [{ name: 'x', phone: '01011112222', sourceId: 'abc' }, 'sourceId'],
    [{ name: 'x', phone: '01011112222', comment: 'c'.repeat(5001) }, 'comment'],
    [{ name: { a: 1 }, phone: '01011112222' }, 'name'],
  ];
  for (const [body, field] of bad) {
    const r = await app.api.post('/api/leads', body, app.adminToken);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 60));
    assert.ok(r.body.details?.some((d) => d.field === field), `${field} in ${JSON.stringify(r.body)}`);
  }
  assert.equal((await app.api.call('POST', '/api/leads', { token: app.adminToken, raw: '"just a string"' })).status, 400);
  assert.equal((await app.api.post('/api/leads', lead({ phone: '+44 7700 900123' }), app.adminToken)).body.item.phone, '+447700900123', 'international clients are allowed');
});

test('lead: "potential" is derived from the status name, and "Non potential" is not potential', async () => {
  assert.equal((await app.api.post('/api/leads', lead({ statusId: 3 }), app.adminToken)).body.item.isPotential, true);
  assert.equal((await app.api.post('/api/leads', lead({ statusId: 4 }), app.adminToken)).body.item.isPotential, false);
});

test('lead: legacy duplicate columns stay consistent with the canonical ones', async () => {
  const { id } = (await app.api.post('/api/leads', lead({ statusId: 3, projectId: 2, source: 'Website', assignedToId: A1.id }), app.adminToken)).body;
  let row = (await q('SELECT * FROM leads WHERE id = ?', [id]))[0];
  assert.equal(row.status_id, 3); assert.equal(row.project_id, 2); assert.equal(row.user_id, A1.id);
  if ('statusId' in row) {
    assert.equal(row.statusId, 3); assert.equal(row.status, 'Potential'); assert.equal(row.projectId, 2); assert.equal(row.project, 'La Vista NorthCoast');
    assert.equal(row.assignedToId, A1.id); assert.equal(row.assignedTo, A1.name); assert.equal(row.type, 'Lead'); assert.equal(Number(row.isPotential), 1);
  }
  await app.api.put(`/api/leads/${id}`, { statusId: 4, assignedToId: A2.id }, app.adminToken);
  row = (await q('SELECT * FROM leads WHERE id = ?', [id]))[0];
  assert.equal(row.status_id, 4); assert.equal(row.user_id, A2.id);
  if ('statusId' in row) { assert.equal(row.statusId, 4); assert.equal(row.status, 'Non potential'); assert.equal(Number(row.isPotential), 0); assert.equal(row.assignedTo, A2.name); }
});

test('lead update is partial: a project-only or status-only update never wipes name/phone/owner (old server bug)', async () => {
  const { id } = (await app.api.post('/api/leads', lead({ name: 'Keep Me', whatsapp: '01000000009', assignedToId: A1.id }), app.adminToken)).body;
  for (const body of [{ projectId: 3 }, { statusId: 5 }, { assignedToId: A1.id }]) {
    const r = await app.api.put(`/api/leads/${id}`, body, app.adminToken);
    assert.equal(r.status, 200);
    assert.equal(r.body.item.name, 'Keep Me');
    assert.equal(r.body.item.whatsapp, '01000000009');
    assert.equal(r.body.item.assignedToId, A1.id);
  }
  const r = await app.api.put(`/api/leads/${id}`, { totallyUnknown: 'x', id: 99999, user_id: 3 }, app.adminToken);
  assert.equal(r.body.item.id, id, 'id cannot be changed');
  assert.equal(r.body.item.assignedToId, A1.id, 'owner cannot be changed through a stray user_id field');
  assert.equal(r.body.item.statusId, 5);
  assert.equal(r.body.item.projectId, 3);
  assert.equal((await app.api.put(`/api/leads/${id}`, { projectId: null }, app.adminToken)).body.item.projectId, undefined, 'explicitly clearing the project works');
});

test('bad ids are 400/404, not 500', async () => {
  assert.equal((await app.api.put('/api/leads/abc', { name: 'x' }, app.adminToken)).status, 400);
  assert.equal((await app.api.put('/api/leads/1%20OR%201=1', { name: 'x' }, app.adminToken)).status, 400);
  assert.equal((await app.api.put('/api/leads/987654', { name: 'x' }, app.adminToken)).status, 404);
  assert.equal((await app.api.del('/api/leads/987654', app.adminToken)).status, 404);
  assert.equal((await app.api.get('/api/leads/99999999999', app.adminToken)).status, 400);
  assert.equal((await app.api.get('/api/does-not-exist', app.adminToken)).status, 404);
});

test("lead delete removes the row; its comments are kept (no silent data loss) and a new lead never reuses its id", async () => {
  const { id } = (await app.api.post('/api/leads', lead({ assignedToId: A1.id }), app.adminToken)).body;
  await app.api.post('/api/comments', { entityType: 'lead', entityId: id, content: 'keep me' }, A1.token);
  assert.equal((await app.api.del(`/api/leads/${id}`, app.adminToken)).status, 200);
  assert.equal((await q('SELECT id FROM leads WHERE id = ?', [id])).length, 0);
  // Production has no foreign keys, so the history is kept. A database created from schema.sql has comments.lead_id
  // ... ON DELETE CASCADE, so there the database itself removes them (documented behaviour of schema.sql).
  const kept = (await q('SELECT id FROM comments WHERE entity_id = ? AND entity_type = ?', [id, 'lead'])).length;
  assert.equal(kept, schemaName() === 'canonical' ? 0 : 1);
  const next = (await app.api.post('/api/leads', lead(), app.adminToken)).body.id;
  assert.ok(next > id, 'the deleted id is not handed out again (old comments must not attach to a new client)');
});

test('cold call: create / update / delete with validation', async () => {
  assert.equal((await app.api.post('/api/cold-calls', { name: 'x' }, A1.token)).status, 400);
  const r = await app.api.post('/api/cold-calls', { name: 'Cold One', phone: phone(), statusId: 2, notes: 'n' }, A1.token);
  assert.equal(r.status, 200);
  assert.equal(r.body.item.type, 'Coldcall');
  assert.equal(r.body.item.status, 'No answer');
  assert.equal((await app.api.put(`/api/cold-calls/${r.body.id}`, { projectId: 3, statusId: 3 }, A1.token)).status, 200, 'unknown fields are ignored');
  const row = (await q('SELECT * FROM cold_calls WHERE id = ?', [r.body.id]))[0];
  assert.equal(row.status_id, 3); assert.equal(row.user_id, A1.id); assert.equal(row.notes, 'n');
  assert.equal((await app.api.del(`/api/cold-calls/${r.body.id}`, A1.token)).status, 200);
});

// ------------------------------------------------------- reference data -------------------------------------------
test('statuses: validation, uniqueness, rename propagates, and an in-use status cannot be deleted (no cascade)', async () => {
  assert.equal((await app.api.post('/api/statuses', { color: '#123456' }, app.adminToken)).status, 400);
  assert.equal((await app.api.post('/api/statuses', { name: 'X', color: 'red' }, app.adminToken)).status, 400);
  const name = `Brand New ${app.runTag}`;
  const created = await app.api.post('/api/statuses', { name, color: '#abcdef' }, app.adminToken);
  assert.equal(created.status, 200);
  assert.equal((await app.api.post('/api/statuses', { name: name.toUpperCase(), color: '#abcdef' }, app.adminToken)).status, 409, 'case-insensitive duplicate');
  const sid = created.body.id;
  const cc = await app.api.post('/api/cold-calls', { name: 'Guarded', phone: phone(), statusId: sid }, A1.token);
  const ld = await app.api.post('/api/leads', lead({ statusId: sid, assignedToId: A1.id }), app.adminToken);
  await app.api.post('/api/comments', { entityType: 'lead', entityId: ld.body.id, content: 'report me' }, A1.token);
  assert.equal((await app.api.put(`/api/statuses/${sid}`, { name: `Renamed ${app.runTag}` }, app.adminToken)).status, 200);
  assert.equal((await app.api.get('/api/leads', app.adminToken)).body.find((l) => l.id === ld.body.id).status, `Renamed ${app.runTag}`);
  assert.equal((await app.api.get('/api/reports', app.adminToken)).body.find((r) => r.entityId === ld.body.id).statusName, `Renamed ${app.runTag}`);
  const del = await app.api.del(`/api/statuses/${sid}`, app.adminToken);
  assert.equal(del.status, 409);
  assert.equal(del.body.code, 'IN_USE');
  assert.match(del.body.error, /1 leads/);
  assert.match(del.body.error, /1 cold calls/);
  assert.equal((await q('SELECT id FROM cold_calls WHERE id = ?', [cc.body.id])).length, 1, 'the cold call survives');
  await app.api.del(`/api/leads/${ld.body.id}`, app.adminToken);
  await app.api.del(`/api/cold-calls/${cc.body.id}`, app.adminToken);
  assert.equal((await app.api.del(`/api/statuses/${sid}`, app.adminToken)).status, 200);
  assert.equal((await app.api.del(`/api/statuses/${sid}`, app.adminToken)).status, 404);
});

test('sources, developers, projects: CRUD, referential checks and in-use guards', async () => {
  const src = await app.api.post('/api/lead-sources', { name: `Billboard ${app.runTag}`, color: '#112233' }, app.adminToken);
  assert.equal(src.status, 200);
  const dev = await app.api.post('/api/developers', { name: `Acme Dev ${app.runTag}`, phone: '01000000001', email: 'info@acme.test', website: 'https://acme.test' }, app.adminToken);
  assert.equal(dev.status, 200, JSON.stringify(dev.body));
  assert.equal((await app.api.post('/api/developers', { name: 'Bad Mail', email: 'nope' }, app.adminToken)).status, 400);
  assert.equal((await app.api.post('/api/developers', { name: 'Bad Site', website: 'javascript:alert(1)' }, app.adminToken)).status, 400);
  assert.equal((await app.api.post('/api/projects', { name: 'Ghost', developerId: 99999 }, app.adminToken)).status, 400);
  const proj = await app.api.post('/api/projects', { name: `Acme Tower ${app.runTag}`, developerId: dev.body.id, destinationId: 1 }, app.adminToken);
  assert.equal(proj.status, 200, JSON.stringify(proj.body));
  const listed = (await app.api.get('/api/projects', A1.token)).body.find((p) => p.id === proj.body.id);
  assert.equal(listed.developerName, `Acme Dev ${app.runTag}`);
  assert.equal(listed.destinationName, 'New Cairo');
  // project details are stored and returned; a partial update keeps the other fields
  const detailed = await app.api.put(`/api/projects/${proj.body.id}`, { location: 'Fifth Settlement', startingPrice: '4,500,000', downPayment: '10% over 8 years', description: 'Phase 1' }, app.adminToken);
  assert.equal(detailed.status, 200, JSON.stringify(detailed.body));
  assert.deepEqual(
    { location: detailed.body.item.location, startingPrice: detailed.body.item.startingPrice, downPayment: detailed.body.item.downPayment, description: detailed.body.item.description, destinationName: detailed.body.item.destinationName },
    { location: 'Fifth Settlement', startingPrice: 4500000, downPayment: '10% over 8 years', description: 'Phase 1', destinationName: 'New Cairo' },
  );
  const renamed = await app.api.put(`/api/projects/${proj.body.id}`, { name: `Acme Tower II ${app.runTag}` }, app.adminToken);
  assert.equal(renamed.body.item.location, 'Fifth Settlement');
  assert.equal(renamed.body.item.startingPrice, 4500000);
  assert.equal((await app.api.put(`/api/projects/${proj.body.id}`, { startingPrice: 'lots' }, app.adminToken)).status, 400);
  const cleared = await app.api.put(`/api/projects/${proj.body.id}`, { startingPrice: '', location: '' }, app.adminToken);
  assert.equal(cleared.body.item.startingPrice, undefined);
  assert.equal(cleared.body.item.location, undefined);
  assert.equal((await app.api.del(`/api/developers/${dev.body.id}`, app.adminToken)).status, 409, 'developer still has a project');
  const l = await app.api.post('/api/leads', lead({ projectId: proj.body.id, source: `Billboard ${app.runTag}`, assignedToId: A1.id }), app.adminToken);
  assert.equal((await app.api.del(`/api/projects/${proj.body.id}`, app.adminToken)).status, 409);
  assert.equal((await app.api.del(`/api/lead-sources/${src.body.id}`, app.adminToken)).status, 409);
  await app.api.del(`/api/leads/${l.body.id}`, app.adminToken);
  assert.equal((await app.api.del(`/api/projects/${proj.body.id}`, app.adminToken)).status, 200);
  assert.equal((await app.api.del(`/api/developers/${dev.body.id}`, app.adminToken)).status, 200);
  assert.equal((await app.api.del(`/api/lead-sources/${src.body.id}`, app.adminToken)).status, 200);
});

test('brokers: create works (brokers.id has no AUTO_INCREMENT in production)', async () => {
  const r = await app.api.post('/api/brokers', { name: `Broker ${app.runTag}`, phone: '01000000002', developerId: 1 }, app.adminToken);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = (await app.api.get('/api/brokers', A1.token)).body.find((b) => b.id === r.body.id);
  assert.equal(row.name, `Broker ${app.runTag}`);
  assert.ok(row.developerName);
  assert.equal((await app.api.put(`/api/brokers/${r.body.id}`, { phone: '01000000003' }, app.adminToken)).status, 200);
  assert.equal((await app.api.del(`/api/brokers/${r.body.id}`, app.adminToken)).status, 200);
});

test('titles / job titles / departments', async () => {
  const deptName = `Telesales ${app.runTag}`;
  const t = await app.api.post('/api/titles', { name: 'Senior Closer', department: deptName }, app.adminToken);
  assert.equal(t.status, 200);
  const listed = (await app.api.get('/api/titles', A1.token)).body.find((x) => x.id === t.body.id);
  assert.deepEqual({ name: listed.name, department: listed.department }, { name: 'Senior Closer', department: deptName });
  const dept = (await app.api.get('/api/departments', A1.token)).body.find((d) => d.name === deptName);
  assert.ok(dept, 'department auto-created');
  assert.equal((await app.api.del(`/api/departments/${dept.id}`, app.adminToken)).status, 409, 'still has a job title');
  assert.equal((await app.api.del(`/api/titles/${t.body.id}`, app.adminToken)).status, 200);
  assert.equal((await app.api.del(`/api/departments/${dept.id}`, app.adminToken)).status, 200);
  const jt = await app.api.post('/api/jobtitles', { name: 'Closer', departmentId: 99999 }, app.adminToken);
  assert.equal(jt.status, 400);
});

// ---------------------------------------------------------------- users --------------------------------------------
test('user creation validation', async () => {
  const base = { name: 'New Person', email: `new.person.${app.runTag}@test.local`, phone: '01000000000', role: 'agent', password: 'Str0ng-Pass-9' };
  assert.equal((await app.api.post('/api/users', { ...base, password: undefined }, app.adminToken)).status, 400, 'password is mandatory (no default password any more)');
  assert.equal((await app.api.post('/api/users', { ...base, password: 'short' }, app.adminToken)).status, 400);
  assert.equal((await app.api.post('/api/users', { ...base, password: 'password' }, app.adminToken)).status, 400);
  assert.equal((await app.api.post('/api/users', { ...base, role: 'superuser' }, app.adminToken)).status, 400);
  assert.equal((await app.api.post('/api/users', { ...base, email: 'bad' }, app.adminToken)).status, 400);
  assert.equal((await app.api.post('/api/users', { ...base, phone: '0123' }, app.adminToken)).status, 400, 'employees need an Egyptian mobile');
  assert.equal((await app.api.post('/api/users', { ...base, phone: '+447700900123' }, app.adminToken)).status, 400, 'no international numbers for employees');
  assert.equal((await app.api.post('/api/users', { ...base, teamLeaderId: 99999 }, app.adminToken)).status, 400);
  const ok = await app.api.post('/api/users', { ...base, phone: '+20 155 123 4567' }, app.adminToken);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.item.phone, '01551234567');
  assert.equal((await app.api.post('/api/users', { ...base, email: base.email.toUpperCase() }, app.adminToken)).status, 409, 'duplicate email (case-insensitive)');
  assert.equal(JSON.stringify(ok.body).includes('$2'), false);
});

test('user rules: last admin, self-lockout, reporting loops, email changes', async () => {
  const admin = (await app.api.get('/api/auth/me', app.adminToken)).body.user;
  assert.equal((await app.api.put(`/api/users/${admin.id}`, { role: 'agent' }, app.adminToken)).status, 409, 'cannot demote yourself');
  assert.equal((await app.api.put(`/api/users/${admin.id}`, { isActive: false }, app.adminToken)).status, 409, 'cannot disable yourself');
  assert.equal((await app.api.del(`/api/users/${admin.id}`, app.adminToken)).status, 409, 'cannot delete yourself');
  const second = await app.createUser({ name: `Second Admin ${app.runTag}`, role: 'admin' });
  assert.equal((await app.api.put(`/api/users/${admin.id}`, { role: 'agent' }, second.token)).status, 200, 'another admin may demote the first');
  if (!isMysql()) assert.equal((await app.api.put(`/api/users/${second.id}`, { role: 'agent' }, second.token)).status, 409, 'last admin protected');
  assert.equal((await app.api.put(`/api/users/${admin.id}`, { role: 'admin' }, second.token)).status, 200, 'restore');
  assert.equal((await app.api.put(`/api/users/${A1.id}`, { teamLeaderId: A1.id }, app.adminToken)).status, 400, 'self parent');
  assert.equal((await app.api.put(`/api/users/${T.id}`, { teamLeaderId: A1.id }, app.adminToken)).status, 400, 'loop: A1 reports to T');
  assert.equal((await app.api.put(`/api/users/${A1.id}`, { email: A2.email }, app.adminToken)).status, 409);
  assert.equal((await app.api.put(`/api/users/${A1.id}`, { email: `renamed.a1.${app.runTag}@test.local` }, app.adminToken)).status, 200);
  assert.equal((await app.api.del(`/api/users/${second.id}`, app.adminToken)).status, 200);
});

test('deleting a user keeps their records (unassigned), detaches reports-to links and blocks their login', async () => {
  const boss = await app.createUser({ role: 'team_leader' });
  const sub = await app.createUser({ teamLeaderId: boss.id });
  const l = await app.api.post('/api/leads', lead({ assignedToId: boss.id }), app.adminToken);
  assert.equal((await app.api.del(`/api/users/${boss.id}`, app.adminToken)).status, 200);
  assert.equal((await q('SELECT user_id FROM leads WHERE id = ?', [l.body.id]))[0].user_id, null);
  assert.equal((await q('SELECT parent_id FROM users WHERE id = ?', [sub.id]))[0].parent_id, null);
  assert.equal((await app.api.post('/api/auth/login', { email: boss.email, password: boss.password })).status, 401);
  assert.equal((await app.api.get('/api/auth/me', boss.token)).status, 401);
  assert.ok((await app.api.get('/api/leads', app.adminToken)).body.some((x) => x.id === l.body.id));
});

// ------------------------------------------------------------- imports ---------------------------------------------
test('lead import: duplicates and junk are skipped, nothing is overwritten, projects resolve by name', async () => {
  const p = () => phone();
  const [p1, p2, p3, p4] = [p(), p(), p(), p()];
  const existing = (await app.api.post('/api/leads', lead({ name: 'Existing', phone: p1 }), app.adminToken)).body;
  const before = Number((await q('SELECT COUNT(*) AS c FROM leads'))[0].c);
  const rows = [
    { name: 'Imp One', phone: p2, project: 'Salt', status: 'Potential', assignedToId: A1.id },
    { name: 'Imp Two', phone: p3.slice(1), statusId: 8, source: 'Meta', projectId: 777, project: 'La Vista New Cairo' }, // leading zero lost by Excel
    { name: 'Dup Of Existing', phone: `+2${p1}` },
    { name: 'Dup In File', phone: p2 },
    { name: 'Too Short', phone: '12' },
    'garbage',
    { phone: p4 },
  ];
  const r = await app.api.post('/api/leads/import', { rows }, app.adminToken);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual({ count: r.body.count, duplicates: r.body.duplicates, invalid: r.body.invalid }, { count: 3, duplicates: 2, invalid: 2 });
  assert.equal(Number((await q('SELECT COUNT(*) AS c FROM leads'))[0].c), before + 3);
  assert.equal((await q('SELECT name FROM leads WHERE id = ?', [existing.id]))[0].name, 'Existing', 'existing lead untouched');
  const list = (await app.api.get('/api/leads', app.adminToken)).body;
  const one = list.find((x) => x.phone === p2);
  assert.equal(one.project, 'Salt'); assert.equal(one.status, 'Potential'); assert.equal(one.assignedToId, A1.id);
  const two = list.find((x) => x.phone === p3);
  assert.ok(two, 'the 10-digit spreadsheet number was repaired to 11 digits');
  assert.equal(two.project, 'La Vista New Cairo', 'name wins over a stale client-side project id');
  assert.equal(two.status, 'Hot case');
  assert.equal(list.find((x) => x.phone === p4).name, 'Unknown');
  assert.equal((await app.api.post('/api/leads/import', { rows }, app.adminToken)).body.count, 0, 're-importing the same file adds nothing');
});

test('import limits (10 000 rows per request) and cold-call import', async () => {
  assert.equal((await app.api.post('/api/leads/import', { rows: 'x' }, app.adminToken)).status, 400);
  assert.equal((await app.api.post('/api/leads/import', { rows: Array.from({ length: 10001 }, (_, i) => ({ name: 'n', phone: `0100${String(i).padStart(7, '0')}` })) }, app.adminToken)).status, 400);
  assert.equal((await app.api.post('/api/leads/import', { rows: [] }, app.adminToken)).body.count, 0);
  const [c1, c2] = [phone(), phone()];
  const r = await app.api.post('/api/cold-calls/import', { rows: [{ name: 'CC1', phone: c1, statusId: 2 }, { name: 'CC2', phone: c2 }] }, app.adminToken);
  assert.equal(r.body.count, 2);
  assert.equal((await app.api.get('/api/cold-calls', app.adminToken)).body.find((c) => c.phone === c1).status, 'No answer');
});

test('an import reserves its whole id block: a deleted imported id is never handed out again', async () => {
  const phones = [phone(), phone(), phone()];
  const r = await app.api.post('/api/leads/import', { rows: phones.map((ph, n) => ({ name: `Block ${n}`, phone: ph })) }, app.adminToken);
  assert.equal(r.body.count, 3);
  const ids = (await app.api.get('/api/leads', app.adminToken)).body.filter((x) => phones.includes(x.phone)).map((x) => x.id).sort((a, b) => a - b);
  const highest = ids[2];
  assert.equal((await app.api.del(`/api/leads/${highest}`, app.adminToken)).status, 200);
  const created = await app.api.post('/api/leads', lead(), app.adminToken);
  assert.ok(created.body.id > highest, `new id ${created.body.id} must be above the deleted imported id ${highest}`);
});

test('a 5 000-row import works in one request and stays fast', async () => {
  const rows = Array.from({ length: 5000 }, (_, i) => ({ name: `Bulk ${i}`, phone: `015${String(i + Number(app.runTag.charCodeAt(0)) * 10000).padStart(8, '0')}`, status: 'New Lead' }));
  const t0 = Date.now();
  const r = await app.api.post('/api/leads/import', { rows }, app.adminToken);
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
  assert.equal(r.body.count + r.body.duplicates, 5000);
  assert.ok(Date.now() - t0 < 20000, `took ${Date.now() - t0} ms`);
});

// ---------------------------------------------------------------- deals --------------------------------------------
test('deals: create / partial update / validate / delete, legacy columns filled', async () => {
  const bad = [
    { leadName: 'x', amount: -5 }, { leadName: 'x', amount: 'abc' }, { leadName: 'x', amount: 1e12 }, { leadName: 'x', contractDate: 'nope' }, {},
    { leadName: 'x', agentId: 99999 }, { leadName: 'x', attachments: 'nope' }, { leadName: 'x', status: 'stolen' },
    { leadName: 'x', attachments: [{ name: 'x.html', url: 'data:text/html;base64,PHNjcmlwdD4=' }] },
    // every link field is checked: a harmless dataUrl must not smuggle a javascript: / html url (the UI opens `url`)
    { leadName: 'x', attachments: [{ name: 'a.png', dataUrl: 'data:image/png;base64,AAAA', url: 'javascript:alert(1)' }] },
    { leadName: 'x', attachments: [{ name: 'a.png', url: 'https://ok.example/a.png', data: 'data:text/html;base64,PHNjcmlwdD4=' }] },
    { leadName: 'x', attachments: [{ name: 'a.png' }] },
  ];
  for (const b of bad) assert.equal((await app.api.post('/api/deals', b, app.adminToken)).status, 400, JSON.stringify(b));
  const r = await app.api.post('/api/deals', {
    leadName: 'Big Deal', clientPhone: '01011112222', agentId: A1.id, projectId: 1, developerId: 1, contractPrice: 3500000, reservationPrice: 50000,
    commission: 70000, status: 'approved', stage: 'Contracted', reservationDate: '2026-02-01', contractDate: '2026-03-01', unitNumber: 'B-12',
    attachments: [{ name: 'contract.pdf', type: 'application/pdf', url: 'data:application/pdf;base64,AAAA' }],
  }, app.adminToken);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = r.body.item;
  assert.equal(d.leadName, 'Big Deal'); assert.equal(d.amount, 3500000); assert.equal(d.agentName, A1.name); assert.equal(d.projectName, 'SilverSands');
  assert.equal(d.reservationDate, '2026-02-01'); assert.equal(d.contractDate, '2026-03-01'); assert.equal(d.attachments.length, 1);
  assert.equal(d.leadId, r.body.id);
  // commission = 5,000 EGP per million of the deal value; the 70,000 the client sent is ignored
  assert.equal(d.commission, 17500);
  const upd = await app.api.put(`/api/deals/${r.body.id}`, { commission: 99000, status: 'rejected' }, app.adminToken);
  assert.equal(upd.status, 200, JSON.stringify(upd.body));
  assert.equal(upd.body.item.commission, 17500, 'a commission sent by a client cannot override the rule');
  assert.equal(upd.body.item.status, 'rejected');
  assert.equal(upd.body.item.leadName, 'Big Deal');
  assert.equal(upd.body.item.agentId, A1.id);
  assert.equal(upd.body.item.attachments.length, 1);
  // changing the deal value recalculates the commission
  const repriced = await app.api.put(`/api/deals/${r.body.id}`, { contractPrice: 10000000 }, app.adminToken);
  assert.equal(repriced.body.item.amount, 10000000);
  assert.equal(repriced.body.item.commission, 50000);
  assert.equal((await app.api.del(`/api/deals/${r.body.id}`, app.adminToken)).status, 200);
  assert.equal((await app.api.del(`/api/deals/${r.body.id}`, app.adminToken)).status, 404);
});

test('commission rule: 5,000 EGP per million of the deal value, for agents only; totals add up the same way', async () => {
  const make = (body) => app.api.post('/api/deals', { leadName: 'Commission Check', clientPhone: app.uniquePhone(), commission: 999999, ...body }, app.adminToken);
  const ids = [];
  const users = [];
  try {
    // agents: the rule (a commission sent by the client is ignored)
    const agentCases = [[{ amount: 5000000 }, 25000], [{ amount: 10000000 }, 50000], [{ amount: 1000000 }, 5000], [{ amount: 5200000 }, 26000],
      [{ amount: 3100000 }, 15500], [{ amount: 1234567 }, 6172.84], [{ amount: 2000000, contractPrice: 6000000 }, 30000]];
    for (const [body, expected] of agentCases) {
      const r = await make({ ...body, agentId: A1.id });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      ids.push(r.body.id);
      assert.equal(r.body.item.commission, expected, `agent ${JSON.stringify(body)} -> ${expected}`);
    }
    // every other role: no commission
    const others = [T];
    for (const role of ['sales_supervisor', 'sales_manager', 'director', 'franchise_owner']) {
      const u = await app.createUser({ role });
      users.push(u);
      others.push(u);
    }
    for (const seller of others) {
      const r = await make({ amount: 5000000, agentId: seller.id });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      ids.push(r.body.id);
      assert.equal(r.body.item.commission, 0, `a deal sold by a ${seller.role ?? 'team_leader'} carries no commission`);
    }
    const byAdmin = await make({ amount: 5000000 }); // no seller given: the administrator who created it
    ids.push(byAdmin.body.id);
    assert.equal(byAdmin.body.item.commission, 0, 'administrators earn no commission');

    const listed = (await app.api.get('/api/deals', app.adminToken)).body.filter((d) => ids.includes(d.id));
    const total = Math.round(listed.reduce((sum, d) => sum + d.commission, 0) * 100) / 100;
    assert.equal(total, Math.round(agentCases.reduce((sum, [, c]) => sum + c, 0) * 100) / 100, 'Total Commission = agents\' deals only');
  } finally {
    for (const id of ids) await app.api.del(`/api/deals/${id}`, app.adminToken);
    for (const u of users) await app.api.del(`/api/users/${u.id}`, app.adminToken);
  }
});

test('commission is earned when the deal is made: recalculated only when the value or the seller changes', async () => {
  const seller = await app.createUser({ teamLeaderId: T.id }); // an agent
  const r = await app.api.post('/api/deals', { leadName: 'Promotion Check', clientPhone: app.uniquePhone(), amount: 4000000, agentId: seller.id }, app.adminToken);
  const id = r.body.id;
  try {
    assert.equal(r.body.item.commission, 20000);
    // the agent is promoted later; editing something else on the deal keeps the commission they earned
    assert.equal((await app.api.put(`/api/users/${seller.id}`, { role: 'team_leader' }, app.adminToken)).status, 200);
    const noted = await app.api.put(`/api/deals/${id}`, { notes: 'contract signed', status: 'approved' }, app.adminToken);
    assert.equal(noted.body.item.commission, 20000);
    // a new value is a new calculation, with the seller's role at that time
    const repriced = await app.api.put(`/api/deals/${id}`, { amount: 6000000 }, app.adminToken);
    assert.equal(repriced.body.item.amount, 6000000, 'a new amount is really stored (it used to be ignored)');
    assert.equal(repriced.body.item.commission, 0, 'the seller is no longer an agent');
    // handing the deal to an agent recalculates for that agent
    const reassigned = await app.api.put(`/api/deals/${id}`, { agentId: A1.id }, app.adminToken);
    assert.equal(reassigned.body.item.commission, 30000);
  } finally {
    await app.api.del(`/api/deals/${id}`, app.adminToken);
    await app.api.del(`/api/users/${seller.id}`, app.adminToken);
  }
});

test('concurrency: 40 parallel lead creates and comments get unique ids, no 500s', async () => {
  const many = await Promise.all(Array.from({ length: 40 }, () => app.api.post('/api/leads', lead({ assignedToId: A1.id }), A1.token)));
  assert.deepEqual([...new Set(many.map((r) => r.status))], [200]);
  const ids = many.map((r) => r.body.id);
  assert.equal(new Set(ids).size, 40);
  const comments = await Promise.all(ids.map((id) => app.api.post('/api/comments', { entityType: 'lead', entityId: id, content: 'parallel' }, A1.token)));
  assert.deepEqual([...new Set(comments.map((r) => r.status))], [200]);
  assert.equal(new Set(comments.map((r) => r.body.id)).size, 40);
});

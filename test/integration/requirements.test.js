import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from '../support/harness.js';

let app; let A1; let B; let phone; let opts;
before(async () => {
  app = await startTestApp();
  phone = () => app.uniquePhone('015');
  const T = await app.createUser({ role: 'team_leader' });
  A1 = await app.createUser({ teamLeaderId: T.id });
  B = await app.createUser();
  opts = (await app.api.get('/api/lead-options', A1.token)).body;
});
after(async () => { await app.stop(); });

const dest = (name) => opts.destinations.find((d) => d.name === name).id;
const type = (name) => opts.propertyTypes.find((d) => d.name === name).id;

test('the default destinations and property types from the requirements are available to everybody', async () => {
  // every default is there, in this order (on the real-MySQL run all suites share one database, so options added by
  // other tests may appear around them: they are filtered out before comparing)
  const inOrder = (list, expected) => assert.deepEqual(list.map((d) => d.name).filter((n) => expected.includes(n)), expected);
  inOrder(opts.destinations, ['New Cairo', 'New Capital', 'West Cairo', 'El Gouna', 'North Coast', 'Ain Sokhna']);
  inOrder(opts.propertyTypes, ['Studio', '1 Bedroom', '2 Bedrooms', '3 Bedrooms', 'Duplex', 'Townhouse', 'Twin House', 'Standalone', 'One-story property']);
  // exactly the business lists, in this order, and nothing like "Not specified"
  assert.deepEqual(opts.delivery.map((d) => d.label), ['RTM', '1 Year', '2 Years', '3 Years', '4 Years']);
  assert.deepEqual(opts.finishing.map((d) => d.label), ['Core & Shell', 'Semi-Finished', 'Fully Finished']);
  assert.deepEqual(opts.purpose.map((d) => d.label), ['End User', 'Investment']);
});

test('requirements are saved with the lead, returned, partially kept on unrelated edits, replaced and cleared', async () => {
  const requirements = {
    destinationIds: [dest('New Cairo'), dest('North Coast')], propertyTypeIds: [type('3 Bedrooms'), type('Duplex')],
    budgetMin: 4000000, budgetMax: 7500000, delivery: 'within_2_years', finishing: 'semi_finished',
    downPayment: 500000, installmentPerQuarter: 150000, purpose: 'end_user',
  };
  const r = await app.api.post('/api/leads', { name: 'Req Client', phone: phone(), requirements }, A1.token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.item.requirements, { ...requirements, destinationIds: [...requirements.destinationIds].sort((a, b) => a - b), propertyTypeIds: [...requirements.propertyTypeIds].sort((a, b) => a - b) });
  const id = r.body.id;
  const fromList = (await app.api.get('/api/leads', A1.token)).body.find((l) => l.id === id);
  assert.equal(fromList.requirements.budgetMax, 7500000);
  assert.equal((await app.api.put(`/api/leads/${id}`, { statusId: 3 }, A1.token)).body.item.requirements.purpose, 'end_user', 'unrelated edit keeps them');
  const replaced = await app.api.put(`/api/leads/${id}`, { requirements: { destinationIds: [dest('El Gouna')], purpose: 'investment' } }, A1.token);
  assert.deepEqual(replaced.body.item.requirements.destinationIds, [dest('El Gouna')]);
  assert.equal(replaced.body.item.requirements.budgetMax, null, 'a requirements object replaces the whole set');
  const cleared = await app.api.put(`/api/leads/${id}`, { requirements: null }, A1.token);
  assert.deepEqual(cleared.body.item.requirements.destinationIds, []);
  assert.equal(cleared.body.item.requirements.purpose, null);
});

test('requirement validation', async () => {
  const bad = [
    [{ budgetMin: 5000000, budgetMax: 1000000 }, 'requirements.budgetMax'],
    [{ budgetMin: -1 }, 'requirements.budgetMin'],
    [{ budgetMax: 'lots' }, 'requirements.budgetMax'],
    [{ delivery: 'someday' }, 'requirements.delivery'],
    [{ finishing: 'painted' }, 'requirements.finishing'],
    [{ purpose: 'flipping' }, 'requirements.purpose'],
    [{ destinationIds: [99999] }, 'requirements.destinations'],
    [{ propertyTypeIds: ['x'] }, 'requirements.propertyTypeIds'],
    [{ downPayment: 9000000, budgetMax: 1000000 }, 'requirements.downPayment'],
  ];
  for (const [requirements, field] of bad) {
    const r = await app.api.post('/api/leads', { name: 'Bad Req', phone: phone(), requirements }, A1.token);
    assert.equal(r.status, 400, JSON.stringify(requirements));
    assert.ok(r.body.details?.some((d) => d.field === field), `${field} in ${JSON.stringify(r.body)}`);
  }
  assert.equal((await app.api.post('/api/leads', { name: 'Bad Req', phone: phone(), requirements: 'cheap' }, A1.token)).status, 400);
});

test('server-side filters by destination, unit type, purpose, finishing, delivery, budget and text; scope still applies', async () => {
  const make = (name, requirements, token = A1.token) => app.api.post('/api/leads', { name, phone: phone(), requirements }, token).then((r) => r.body.id);
  const capital = await make('Filter Capital', { destinationIds: [dest('New Capital')], propertyTypeIds: [type('Studio')], budgetMin: 1000000, budgetMax: 2000000, purpose: 'investment', finishing: 'core_and_shell', delivery: 'ready_to_move' });
  const sokhna = await make('Filter Sokhna', { destinationIds: [dest('Ain Sokhna')], propertyTypeIds: [type('Twin House')], budgetMin: 8000000, purpose: 'end_user' });
  const foreign = await make('Filter Capital Foreign', { destinationIds: [dest('New Capital')] }, B.token);
  const ids = async (qs) => (await app.api.get(`/api/leads?${qs}`, A1.token)).body.map((l) => l.id);
  assert.ok((await ids(`destinationId=${dest('New Capital')}`)).includes(capital));
  assert.ok(!(await ids(`destinationId=${dest('New Capital')}`)).includes(sokhna));
  assert.ok(!(await ids(`destinationId=${dest('New Capital')}`)).includes(foreign), 'filters never widen the scope');
  assert.deepEqual((await ids(`propertyTypeId=${type('Twin House')}`)).filter((x) => [capital, sokhna].includes(x)), [sokhna]);
  assert.ok((await ids('purpose=investment&finishing=core_and_shell&delivery=ready_to_move')).includes(capital));
  assert.ok((await ids('budget=1500000')).includes(capital));
  assert.ok(!(await ids('budget=1500000')).includes(sokhna));
  assert.ok((await ids('budget=9000000')).includes(sokhna), 'open-ended maximum');
  assert.ok((await ids('q=filter%20sok')).includes(sokhna));
  assert.equal((await app.api.get('/api/leads?purpose=flipping', A1.token)).status, 400);
  assert.equal((await app.api.get("/api/leads?q=%27%20OR%201%3D1%20--", A1.token)).status, 200, 'SQL in the search box is just text');
});

test('destinations & property types: admin CRUD, uniqueness, deactivate instead of delete when in use', async () => {
  const created = await app.api.post('/api/destinations', { name: 'Ras El Hekma', sortOrder: 70 }, app.adminToken);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal((await app.api.post('/api/destinations', { name: 'ras el hekma' }, app.adminToken)).status, 409);
  assert.equal((await app.api.post('/api/destinations', { name: '' }, app.adminToken)).status, 400);
  const id = created.body.id;
  const leadId = (await app.api.post('/api/leads', { name: 'Hekma Client', phone: phone(), requirements: { destinationIds: [id] } }, A1.token)).body.id;
  const del = await app.api.del(`/api/destinations/${id}`, app.adminToken);
  assert.equal(del.status, 409);
  assert.match(del.body.error, /deactivate/);
  assert.equal((await app.api.put(`/api/destinations/${id}`, { isActive: false }, app.adminToken)).body.item.isActive, false);
  assert.ok(!(await app.api.get('/api/destinations?active=1', A1.token)).body.some((d) => d.id === id), 'hidden from new choices');
  assert.equal((await app.api.post('/api/leads', { name: 'New Hekma', phone: phone(), requirements: { destinationIds: [id] } }, A1.token)).status, 400, 'cannot newly pick a deactivated destination');
  assert.equal((await app.api.put(`/api/leads/${leadId}`, { requirements: { destinationIds: [id], purpose: 'investment' } }, A1.token)).status, 200, 'an existing link survives edits');
  const pt = await app.api.post('/api/property-types', { name: 'Penthouse' }, app.adminToken);
  assert.equal(pt.status, 200);
  assert.equal((await app.api.put(`/api/property-types/${pt.body.id}`, { name: 'Sky Penthouse' }, app.adminToken)).body.item.name, 'Sky Penthouse');
  assert.equal((await app.api.del(`/api/property-types/${pt.body.id}`, app.adminToken)).status, 200, 'unused -> really deleted');
});

test('deleting a lead removes its requirement rows too', async () => {
  const id = (await app.api.post('/api/leads', { name: 'Gone', phone: phone(), requirements: { destinationIds: [dest('West Cairo')], purpose: 'investment' } }, A1.token)).body.id;
  assert.equal((await app.api.del(`/api/leads/${id}`, A1.token)).status, 200);
  const [rows] = await app.pool.query('SELECT COUNT(*) AS c FROM lead_requirement_destinations WHERE lead_id = ?', [id]);
  assert.equal(Number(rows[0].c), 0);
});

test('old purposes (Personal Living / Upgrading) stay on existing leads but cannot be chosen any more', async () => {
  assert.equal((await app.api.post('/api/leads', { name: 'Old Purpose New', phone: phone(), requirements: { purpose: 'upgrading' } }, A1.token)).status, 400);
  const id = (await app.api.post('/api/leads', { name: 'Old Purpose Kept', phone: phone(), requirements: { purpose: 'investment' } }, A1.token)).body.id;
  await app.ctx.db.exec("UPDATE lead_requirements SET purpose = 'upgrading' WHERE lead_id = ?", [id]); // a record saved before the change
  const kept = await app.api.put(`/api/leads/${id}`, { name: 'Old Purpose Kept 2', requirements: { purpose: 'upgrading' } }, A1.token);
  assert.equal(kept.status, 200, 'saving the lead unchanged must still work');
  assert.equal(kept.body.item.requirements.purpose, 'upgrading');
  const changed = await app.api.put(`/api/leads/${id}`, { requirements: { purpose: 'personal_living' } }, A1.token);
  assert.equal(changed.status, 400, 'switching to another old purpose is refused');
});

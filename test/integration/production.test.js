import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, startTestApp } from '../support/harness.js';

// A brand-new PRODUCTION installation: empty database, NODE_ENV=production. Always on a fresh in-memory database built
// by the migrations (the real-MySQL run shares one database between suites, which would not be empty).
let app;
before(async () => {
  app = await startTestApp({ schema: 'canonical', env: { NODE_ENV: 'production', CORS_ORIGIN: 'https://crm.example.test' } });
});
after(async () => { await app?.stop(); });

const count = async (table) => Number((await app.ctx.db.one(`SELECT COUNT(*) AS n FROM \`${table}\``)).n);

test('production bootstrap: only the first administrator and the configuration lists, no demo or sample records', async () => {
  const users = await app.ctx.db.rows('SELECT email, role FROM users');
  assert.deepEqual(users.map((u) => [u.email, u.role]), [[ADMIN.email, 'admin']], 'exactly one user: the INITIAL_ADMIN account');
  for (const table of ['leads', 'cold_calls', 'deals', 'comments', 'call_history', 'developers', 'projects', 'brokers']) {
    assert.equal(await count(table), 0, `${table} starts empty`);
  }
  // configuration the screens need to work on day one
  for (const table of ['statuses', 'sources', 'destinations', 'property_types']) assert.ok((await count(table)) > 0, `${table} configured`);
});

test('production bootstrap: the company can start working right away through the application', async () => {
  const dev = await app.api.post('/api/developers', { name: 'First Real Developer' }, app.adminToken);
  assert.equal(dev.status, 200, JSON.stringify(dev.body));
  const project = await app.api.post('/api/projects', { name: 'First Real Project', developerId: dev.body.item?.id ?? dev.body.id }, app.adminToken);
  assert.equal(project.status, 200, JSON.stringify(project.body));
  const agent = await app.createUser({ role: 'agent' });
  const lead = await app.api.post('/api/leads', { name: 'First Client', phone: app.uniquePhone(), projectId: project.body.item?.id ?? project.body.id }, agent.token);
  assert.equal(lead.status, 200, JSON.stringify(lead.body));
  // security headers that only production turns on
  const res = await app.api.get('/api/health');
  assert.match(String(res.headers.get('strict-transport-security')), /max-age=\d+/);
});

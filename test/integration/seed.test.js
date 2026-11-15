import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from '../support/harness.js';
import { DEMO_ACCOUNTS, seedDemoCompany } from '../../scripts/lib/dev-data.mjs';
import { findOrphans } from '../../src/domain/integrity.js';
import { seedBaseData } from '../../src/seed.js';

let app;
before(async () => { app = await startTestApp(); });
after(async () => { await app?.stop(); });

const PASSWORD = 'Seed-Test-Pass-9';
const asAdmin = (method, path, body) => app.api.call(method, `/api/${path}`, { token: app.adminToken, body }).then((r) => {
  if (r.status >= 400) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
});

test('seed: a fresh database + base seed + demo company has no orphan relationship; a second run creates nothing', async () => {
  const first = await seedDemoCompany(asAdmin, { password: PASSWORD });
  assert.ok(first.users >= 9 && first.leads === 12 && first.coldCalls === 6 && first.deals === 2 && first.calls === 1, JSON.stringify(first));

  const again = await seedDemoCompany(asAdmin, { password: PASSWORD });
  assert.deepEqual(again, { users: 0, leads: 0, coldCalls: 0, deals: 0, brokers: 0, calls: 0 }, 'idempotent: nothing duplicated');
  await seedBaseData(app.ctx); // the startup seed is idempotent too (it runs on every server start)

  const { problems } = await findOrphans(app.ctx.db, app.ctx.schema);
  assert.deepEqual(problems, [], 'no orphan references');
  const phones = await app.ctx.db.rows('SELECT phone, COUNT(*) AS n FROM leads GROUP BY phone HAVING COUNT(*) > 1');
  assert.equal(phones.length, 0, 'no duplicate leads');
});

test('seed: all seven roles exist in one reporting line and the hierarchy scopes what each one sees', async () => {
  const users = await asAdmin('GET', 'users');
  const byEmail = new Map(users.map((u) => [u.email, u]));
  for (const role of ['franchise_owner', 'director', 'sales_manager', 'sales_supervisor', 'team_leader', 'agent']) {
    assert.ok(users.some((u) => u.role === role), `${role} seeded`);
  }
  assert.ok(users.some((u) => u.role === 'admin'));
  const chain = ['agent', 'team_leader', 'sales_supervisor', 'sales_manager', 'director'].map((k) => byEmail.get(DEMO_ACCOUNTS[k]));
  for (let i = 0; i < chain.length - 1; i += 1) assert.equal(Number(chain[i].teamLeaderId), Number(chain[i + 1].id), `${chain[i].role} reports to ${chain[i + 1].role}`);

  const leadsOf = async (key) => (await app.api.get('/api/leads', await app.login(DEMO_ACCOUNTS[key], PASSWORD))).body.map((l) => l.name).sort();
  const supervisor = await leadsOf('sales_supervisor');
  const agent = await leadsOf('agent');
  const otherAgent = await leadsOf('other_agent');
  assert.ok(agent.length > 0 && agent.every((n) => supervisor.includes(n)), 'the supervisor sees the agent\'s leads');
  assert.ok(otherAgent.length > 0 && otherAgent.every((n) => !supervisor.includes(n)), 'but not another team\'s');
  assert.ok(otherAgent.every((n) => !agent.includes(n)), 'agents do not see each other\'s leads');
});

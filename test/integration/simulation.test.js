import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from '../support/harness.js';

/**
 * A working day of a small company, through the real API over HTTP, with all seven roles and people working AT THE
 * SAME TIME. Runs in-memory and, via `npm run test:mysql`, on a real temporary MySQL database (true concurrency).
 */
let app;
before(async () => { app = await startTestApp(); });
after(async () => { await app?.stop(); });

const ok = (r, label) => { assert.ok(r.status < 300, `${label}: ${r.status} ${JSON.stringify(r.body)}`); return r.body; };

test('real-world simulation: hierarchy, parallel work by every role, no duplicates, no leaks, no lost updates', async () => {
  const { api, adminToken: admin, runTag: tag } = app;

  // 1. the administrator sets up the lists and the reporting tree
  const dest = ok(await api.post('/api/destinations', { name: `Sim Coast ${tag}` }, admin), 'destination');
  const type = ok(await api.post('/api/property-types', { name: `Sim Villa ${tag}` }, admin), 'property type');
  const destId = dest.item?.id ?? dest.id;
  const typeId = type.item?.id ?? type.id;
  const owner = await app.createUser({ role: 'franchise_owner' });
  const director = await app.createUser({ role: 'director' });
  const manager = await app.createUser({ role: 'sales_manager', teamLeaderId: director.id });
  const supervisor = await app.createUser({ role: 'sales_supervisor', teamLeaderId: manager.id });
  const leader = await app.createUser({ role: 'team_leader', teamLeaderId: supervisor.id });
  const agents = [];
  for (let i = 0; i < 4; i += 1) agents.push(await app.createUser({ teamLeaderId: leader.id }));
  const otherLeader = await app.createUser({ role: 'team_leader' });
  const outsider = await app.createUser({ teamLeaderId: otherLeader.id });
  const statuses = ok(await api.get('/api/statuses', admin), 'statuses');

  // 2. every agent (and the outsider) creates 8 leads, all in parallel
  const PER = 8;
  const creators = [...agents, outsider];
  const created = await Promise.all(creators.flatMap((u) => Array.from({ length: PER }, (_, i) => api.post('/api/leads', {
    name: `Sim ${u.id}-${i}`, phone: app.uniquePhone('011'), statusId: statuses[0].id,
    requirements: { destinationIds: [destId], propertyTypeIds: [typeId], budgetMin: 3000000, budgetMax: 6000000, purpose: 'investment' },
  }, u.token))));
  created.forEach((r, i) => ok(r, `lead ${i}`));
  const ids = created.map((r) => r.body.id);
  assert.equal(new Set(ids).size, ids.length, 'every lead got its own id');

  // 3. agents log calls in parallel; each Save is also double-sent with the same request id
  const calls = [];
  for (const [n, agent] of agents.entries()) {
    const mine = created.slice(n * PER, n * PER + 3).map((r) => r.body.id);
    for (const leadId of mine) {
      const body = { statusId: statuses[1].id, notes: `called ${leadId}`, followUpAt: '2027-01-10T09:00:00Z', requestId: `sim-${tag}-${leadId}` };
      calls.push(api.post(`/api/leads/${leadId}/call-actions`, body, agent.token), api.post(`/api/leads/${leadId}/call-actions`, body, agent.token));
    }
  }
  (await Promise.all(calls)).forEach((r, i) => ok(r, `call ${i}`));

  // 4. at the same time: the team leader re-assigns, an agent edits the status while the leader edits the name
  const firstAgentLeads = created.slice(0, PER).map((r) => r.body.id);
  const toMove = firstAgentLeads.slice(4, 6);
  const contested = firstAgentLeads[6];
  const [assign, statusEdit, nameEdit] = await Promise.all([
    api.post('/api/leads/bulk-assign', { ids: toMove, assignedToId: agents[1].id }, leader.token),
    api.put(`/api/leads/${contested}`, { statusId: statuses[2].id }, agents[0].token),
    api.put(`/api/leads/${contested}`, { name: `Renamed ${tag}` }, leader.token),
  ]);
  ok(assign, 'bulk assign'); ok(statusEdit, 'status edit'); ok(nameEdit, 'name edit');
  const after = ok(await api.get(`/api/leads/${contested}`, admin), 'reload');
  assert.equal(after.statusId ?? after.item?.statusId, statuses[2].id, 'the status edit survived the parallel name edit');
  assert.equal(after.name ?? after.item?.name, `Renamed ${tag}`, 'the name edit survived the parallel status edit');

  // 5. visibility after a fresh sign-in for every role
  const visible = async (u) => (await api.get('/api/leads', await app.login(u.email, u.password))).body.map((l) => l.id);
  const teamIds = ids.slice(0, agents.length * PER);
  const outsiderIds = ids.slice(agents.length * PER);
  for (const boss of [leader, supervisor, manager, director]) {
    const seen = new Set(await visible(boss));
    assert.ok(teamIds.every((id) => seen.has(id)), `${boss.role} sees the whole team`);
    assert.ok(outsiderIds.every((id) => !seen.has(id)), `${boss.role} sees nothing of another team`);
  }
  const ownerSees = new Set(await visible(owner));
  assert.ok(ids.every((id) => ownerSees.has(id)), 'the franchise owner sees everything');
  const a0 = new Set(await visible(agents[0]));
  const a1 = new Set(await visible(agents[1]));
  assert.ok(toMove.every((id) => !a0.has(id) && a1.has(id)), 'moved leads changed owner');
  assert.ok(outsiderIds.every((id) => !a0.has(id)), 'agents never see another team');
  assert.equal(firstAgentLeads.filter((id) => a0.has(id)).length, PER - toMove.length);

  // 6. history: exactly one call per Save (double sends collapsed), follow-ups stored, nothing duplicated
  for (const [n, agent] of agents.entries()) {
    const leadId = created[n * PER].body.id;
    const history = ok(await api.get(`/api/call-actions?leadId=${leadId}`, agent.token), 'history');
    assert.equal(history.length, 1, `lead ${leadId}: one call although Save was sent twice`);
  }
  const events = ok(await api.get('/api/calendar-events', agents[0].token), 'calendar');
  assert.ok(events.filter((e) => String(e.title ?? '').startsWith('Follow up')).length >= 3, 'follow-ups are in the calendar');
  const phones = await app.ctx.db.rows(`SELECT phone FROM leads WHERE id IN (${ids.map(() => '?').join(',')}) GROUP BY phone HAVING COUNT(*) > 1`, ids);
  assert.equal(phones.length, 0, 'no duplicate leads');

  // 7. deals and commission as the admin reviews them; agents only see their own team's deals
  const deal = ok(await api.post('/api/deals', { leadName: 'Sim Deal', clientPhone: app.uniquePhone(), agentId: agents[2].id, amount: 8000000 }, admin), 'deal');
  assert.equal(deal.item.commission, 40000);
  const theirs = ok(await api.get('/api/deals', agents[2].token), 'agent deals');
  assert.ok(theirs.some((d) => d.id === deal.id));
  const outsiderDeals = ok(await api.get('/api/deals', outsider.token), 'outsider deals');
  assert.ok(!outsiderDeals.some((d) => d.id === deal.id), 'another team does not see the deal');
});

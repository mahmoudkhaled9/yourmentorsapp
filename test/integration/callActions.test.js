import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from '../support/harness.js';

let app; let T; let A1; let A2; let B; let phone; let statuses; let opts;
before(async () => {
  app = await startTestApp();
  phone = () => app.uniquePhone('012');
  T = await app.createUser({ role: 'team_leader' });
  A1 = await app.createUser({ teamLeaderId: T.id });
  A2 = await app.createUser({ teamLeaderId: T.id });
  B = await app.createUser();
  statuses = (await app.api.get('/api/statuses', A1.token)).body;
  opts = (await app.api.get('/api/lead-options', A1.token)).body;
});
after(async () => { await app.stop(); });

const dest = (name) => opts.destinations.find((d) => d.name === name).id;
const newLead = async (token = A1.token, requirements) => (await app.api.post('/api/leads', { name: `Call Lead ${Math.random().toString(36).slice(2, 7)}`, phone: phone(), requirements }, token)).body.id;
const countCalls = async (leadId) => Number((await app.ctx.db.one('SELECT COUNT(*) AS n FROM call_history WHERE lead_id = ?', [leadId])).n);

test('logging a call: outcome = lead status, call_history row, history comment + report, follow-up; requirements untouched', async () => {
  const requirements = { destinationIds: [dest('North Coast')], delivery: 'ready_to_move', finishing: 'core_and_shell', purpose: 'investment' };
  const leadId = await newLead(A1.token, requirements);
  const outcome = statuses[4];
  const r = await app.api.post(`/api/leads/${leadId}/call-actions`, { statusId: outcome.id, notes: 'Wants 3BR', followUpAt: '2026-12-01T10:30:00Z', requestId: 'req-aaaaaaaa-1' }, A1.token);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const item = r.body.item;
  assert.deepEqual(
    { leadId: item.leadId, outcome: item.outcomeLabel, statusId: item.statusId, notes: item.notes, by: item.userId },
    { leadId, outcome: outcome.name, statusId: outcome.id, notes: 'Wants 3BR', by: A1.id },
  );
  // the server stored a read-only snapshot of the lead's requirements at call time
  assert.deepEqual([item.deliveryLabel, item.finishingLabel, item.purposeLabel], ['RTM', 'Core & Shell', 'Investment']);

  const row = await app.ctx.db.one('SELECT * FROM call_history WHERE id = ?', [r.body.id]);
  assert.deepEqual([row.lead_id, row.user_id, row.status_id, row.status_name, row.notes], [leadId, A1.id, outcome.id, outcome.name, 'Wants 3BR']);
  const lead = (await app.api.get(`/api/leads/${leadId}`, A1.token)).body;
  assert.equal(lead.statusId, outcome.id, 'the outcome is the lead status');
  assert.deepEqual([lead.requirements.delivery, lead.requirements.finishing, lead.requirements.purpose], ['ready_to_move', 'core_and_shell', 'investment'], 'a call never edits the requirements');
  const comment = await app.ctx.db.one('SELECT * FROM comments WHERE id = ?', [row.comment_id]);
  assert.match(comment.content ?? comment.body, new RegExp(`Call logged - outcome: ${outcome.name}`));
  assert.equal((await app.api.get('/api/reports', A1.token)).body.filter((x) => x.commentId === row.comment_id).length, 1, 'the call is in Reports');
  assert.equal((await app.ctx.db.one('SELECT * FROM calendar_events WHERE id = ?', [row.follow_up_event_id])).lead_id, leadId);

  const activity = (await app.api.get(`/api/leads/${leadId}/activity`, A1.token)).body;
  assert.deepEqual(activity.timeline.map((e) => e.kind).sort(), ['call', 'follow_up'], 'the summary comment is not shown twice');
  assert.ok((await app.api.get(`/api/call-history?leadId=${leadId}`, A1.token)).body.some((c) => c.id === r.body.id));
  assert.ok((await app.api.get(`/api/call-actions?statusId=${outcome.id}`, T.token)).body.some((c) => c.id === r.body.id), 'team leader sees it, filter by outcome');

  // the lead's requirements change later through Edit Lead; the old call keeps its snapshot
  await app.api.put(`/api/leads/${leadId}`, { requirements: { ...requirements, delivery: 'within_4_years' } }, A1.token);
  assert.equal((await app.api.get(`/api/call-actions/${r.body.id}`, A1.token)).body.deliveryLabel, 'RTM');
});

test('a call cannot set Delivery / Finishing / Purpose (one source of truth: Edit Lead)', async () => {
  const leadId = await newLead();
  for (const field of ['delivery', 'finishing', 'purpose']) {
    const r = await app.api.post(`/api/leads/${leadId}/call-actions`, { statusId: statuses[0].id, [field]: 'ready_to_move' }, A1.token);
    assert.equal(r.status, 400);
    assert.match(JSON.stringify(r.body), /edited on the lead/);
  }
  assert.equal(await countCalls(leadId), 0);
});

test('validation: an outcome is required and must exist; bad follow-up refused; nothing saved', async () => {
  const leadId = await newLead();
  assert.equal((await app.api.post(`/api/leads/${leadId}/call-actions`, { notes: 'x' }, A1.token)).status, 400);
  assert.equal((await app.api.post(`/api/leads/${leadId}/call-actions`, { statusId: 999999 }, A1.token)).status, 400);
  assert.equal((await app.api.post(`/api/leads/${leadId}/call-actions`, { statusId: statuses[0].id, followUpAt: 'tomorrow-ish' }, A1.token)).status, 400);
  assert.equal(await countCalls(leadId), 0);
});

test('Save sent twice with the same request id creates ONE call; a request id cannot be reused on another lead', async () => {
  const leadId = await newLead();
  const body = { statusId: statuses[1].id, requestId: 'req-dupe-0001' };
  const [a, b] = await Promise.all([app.api.post(`/api/leads/${leadId}/call-actions`, body, A1.token), app.api.post(`/api/leads/${leadId}/call-actions`, body, A1.token)]);
  assert.equal(a.body.id, b.body.id);
  assert.ok(a.body.duplicate || b.body.duplicate);
  assert.equal(await countCalls(leadId), 1);
  const other = await newLead();
  assert.equal((await app.api.post(`/api/leads/${other}/call-actions`, body, A1.token)).status, 409);
});

test('permissions: other teams cannot log/read; only the author or an admin corrects notes; outcome is history', async () => {
  const leadId = await newLead();
  assert.equal((await app.api.post(`/api/leads/${leadId}/call-actions`, { statusId: statuses[0].id }, B.token)).status, 404);
  const id = (await app.api.post(`/api/leads/${leadId}/call-actions`, { statusId: statuses[0].id, notes: 'first' }, A1.token)).body.id;
  assert.equal((await app.api.get(`/api/call-actions/${id}`, B.token)).status, 404);
  assert.equal((await app.api.get(`/api/leads/${leadId}/activity`, B.token)).status, 404);
  assert.ok(!(await app.api.get('/api/call-actions', B.token)).body.some((c) => c.id === id));
  assert.equal((await app.api.put(`/api/call-actions/${id}`, { notes: 'x' }, A2.token)).status, 404, 'a fellow agent cannot see it');
  assert.equal((await app.api.put(`/api/call-actions/${id}`, { notes: 'x' }, T.token)).status, 403, 'the team leader did not log it');
  const fixed = await app.api.put(`/api/call-actions/${id}`, { notes: 'Corrected' }, A1.token);
  assert.equal(fixed.body.item.notes, 'Corrected');
  const row = await app.ctx.db.one('SELECT comment_id FROM call_history WHERE id = ?', [id]);
  assert.match((await app.ctx.db.one('SELECT * FROM comments WHERE id = ?', [row.comment_id])).content, /Notes: Corrected/);
  assert.equal((await app.api.put(`/api/call-actions/${id}`, { statusId: statuses[2].id }, A1.token)).status, 400, 'outcome is history');
  assert.equal((await app.api.put(`/api/call-actions/${id}`, { delivery: 'within_1_year' }, A1.token)).status, 400, 'snapshot is not editable');
  assert.equal((await app.api.put(`/api/call-actions/${id}`, { notes: 'admin note' }, app.adminToken)).status, 200);
});

test('cold calls use the same call action (status of the cold call is the outcome)', async () => {
  const cc = (await app.api.post('/api/cold-calls', { name: 'Cold Caller', phone: phone() }, A1.token)).body.id;
  const r = await app.api.post(`/api/cold-calls/${cc}/call-actions`, { statusId: statuses[1].id }, A1.token);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual([r.body.item.entityType, r.body.item.coldCallId, r.body.item.outcomeLabel, r.body.item.deliveryLabel], ['cold_call', cc, statuses[1].name, null]);
  assert.equal((await app.api.get('/api/cold-calls', A1.token)).body.find((c) => c.id === cc).statusId, statuses[1].id);
  assert.equal((await app.api.get(`/api/cold-calls/${cc}/activity`, A1.token)).body.calls.length, 1);
});

test('old call history rows (before call actions existed) are still listed', async () => {
  const leadId = await newLead();
  await app.ctx.db.exec('INSERT INTO call_history (id, lead_id, user_id, result, notes, call_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [990001, leadId, A1.id, 'Interested', 'old row', '2026-01-01 10:00:00', '2026-01-01 10:00:00']);
  const old = (await app.api.get(`/api/leads/${leadId}/activity`, A1.token)).body.calls[0];
  assert.deepEqual([old.outcomeLabel, old.deliveryLabel, old.notes], ['Interested', null, 'old row']);
});

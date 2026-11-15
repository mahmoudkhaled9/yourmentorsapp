import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { startTestApp, testEnv } from '../support/harness.js';

/**
 * API sweep: instead of a hand-written list, the routes are read from the running Express app, so a NEW endpoint is
 * covered automatically. For every route: authentication (5 kinds of bad token), malformed bodies, hostile ids and
 * query strings, error shape (no internals), role checks on administrator data and cross-team access.
 *
 * Hierarchy:   admin ── director D ── team leader T ── agent A1
 *                       team leader T2 ── agent B            (another team)
 */
let app; let D; let T; let A1; let T2; let B;
let routes;
const PUBLIC = new Set(['GET /health', 'GET /api/health', 'GET /live', 'POST /api/auth/login']);
const LEAKS = /\bER_[A-Z_]+|SQLITE|sql syntax|at [\w$.<>]+ \(.*\.js:\d+|node_modules|stack/i;

function listRoutes(server) {
  const out = [];
  const mountOf = (layer) => {
    if (layer.regexp?.fast_slash) return '';
    const m = String(layer.regexp).match(/^\/\^\\(\/[^?]*?)\\\/\?\(\?=\\\/\|\$\)\/i$/);
    return m ? m[1].replace(/\\\//g, '/') : '';
  };
  const walk = (stack, prefix) => {
    for (const layer of stack) {
      if (layer.route) {
        const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
        for (const p of paths) for (const method of Object.keys(layer.route.methods)) out.push({ method: method.toUpperCase(), path: prefix + p });
      } else if (layer.handle?.stack) walk(layer.handle.stack, prefix + mountOf(layer));
    }
  };
  walk(server.listeners('request')[0]._router.stack, '');
  const seen = new Set();
  return out.filter((r) => { const k = `${r.method} ${r.path}`; if (seen.has(k)) return false; seen.add(k); return true; });
}
const fill = (path, id) => path.replace(/:\w+/g, String(id));
const noLeak = (r, label) => {
  if (r.status >= 400) assert.ok(!LEAKS.test(r.text), `${label}: error response leaks internals: ${r.text.slice(0, 200)}`);
};

before(async () => {
  app = await startTestApp();
  D = await app.createUser({ name: `Sweep Director ${app.runTag}`, role: 'director' });
  T = await app.createUser({ name: `Sweep Lead ${app.runTag}`, role: 'team_leader', teamLeaderId: D.id });
  A1 = await app.createUser({ name: `Sweep Agent ${app.runTag}`, teamLeaderId: T.id });
  T2 = await app.createUser({ name: `Sweep Other Lead ${app.runTag}`, role: 'team_leader' });
  B = await app.createUser({ name: `Sweep Agent B ${app.runTag}`, teamLeaderId: T2.id });
  routes = listRoutes(app.server);
});
after(async () => { await app.stop(); });

test('the sweep sees the whole API (sanity: the route table is read from the app, not typed by hand)', () => {
  assert.ok(routes.length >= 100, `found only ${routes.length} routes`);
  for (const must of ['POST /api/leads/:id/call-actions', 'GET /api/call-history', 'PUT /api/property-types/:id', 'DELETE /api/destinations/:id', 'POST /api/users']) {
    assert.ok(routes.some((r) => `${r.method} ${r.path}` === must), `missing ${must}`);
  }
});

test('every protected route rejects a missing, garbage, wrong-secret, alg=none and expired token with 401 JSON', async () => {
  const secret = testEnv().JWT_SECRET;
  const bad = {
    missing: null,
    garbage: 'not-a-token',
    wrongSecret: jwt.sign({ sub: String(A1.id) }, 'another-secret-another-secret-another-secret-123', { expiresIn: '1h' }),
    algNone: `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: String(A1.id), role: 'admin' })).toString('base64url')}.`,
    expired: jwt.sign({ sub: String(A1.id) }, secret, { expiresIn: -30 }),
  };
  let checked = 0;
  for (const r of routes) {
    if (PUBLIC.has(`${r.method} ${r.path}`)) continue;
    for (const [kind, token] of Object.entries(bad)) {
      const res = await app.api.call(r.method, fill(r.path, 1), { token: token ?? undefined, body: ['GET', 'DELETE'].includes(r.method) ? undefined : {} });
      assert.equal(res.status, 401, `${kind} token: ${r.method} ${r.path} -> ${res.status}`);
      assert.equal(typeof res.body?.error, 'string', `${r.method} ${r.path}: 401 must be JSON with an error message`);
      noLeak(res, `${r.method} ${r.path}`);
      checked += 1;
    }
  }
  assert.ok(checked >= 500, `only ${checked} checks ran`);
});

test('unknown endpoints: 401 without a token, 404 JSON with one (no HTML, no stack)', async () => {
  assert.equal((await app.api.get('/api/no-such-endpoint')).status, 401);
  const r = await app.api.get('/api/no-such-endpoint', A1.token);
  assert.equal(r.status, 404);
  assert.equal(typeof r.body?.error, 'string');
  noLeak(r, 'unknown endpoint');
});

test('every write route: malformed JSON, a JSON array or a bare string as body -> 4xx JSON, never 500', async () => {
  const writes = routes.filter((r) => ['POST', 'PUT', 'PATCH'].includes(r.method) && !PUBLIC.has(`${r.method} ${r.path}`));
  assert.ok(writes.length >= 40);
  const TAKES_NO_INPUT = new Set(['POST /api/admin/rebuild-reports']); // never reads a body; a valid-JSON one is irrelevant
  for (const r of writes) {
    for (const raw of ['{"name": ', '[1,2,3]', '"just a string"']) {
      const res = await app.api.call(r.method, fill(r.path, 999999), { token: app.adminToken, raw });
      if (TAKES_NO_INPUT.has(`${r.method} ${r.path}`) && raw === '[1,2,3]') { assert.ok(res.status < 500); continue; }
      assert.ok(res.status >= 400 && res.status < 500, `${r.method} ${r.path} with body ${raw} -> ${res.status} ${res.text.slice(0, 120)}`);
      noLeak(res, `${r.method} ${r.path}`);
    }
  }
});

test('every route with an :id: non-numeric, negative, zero, huge and SQL-looking ids -> 400/404, never 500, nothing changes', async () => {
  const counts = async () => ({
    users: (await app.api.get('/api/users', app.adminToken)).body.length,
    leads: (await app.api.get('/api/leads', app.adminToken)).body.length,
    statuses: (await app.api.get('/api/statuses', app.adminToken)).body.length,
  });
  const before = await counts();
  const ids = ['abc', '-1', '0', '99999999999999999999', encodeURIComponent('1 OR 1=1'), encodeURIComponent("1'; DROP TABLE users; --"), '1.5', '0x10'];
  const withId = routes.filter((r) => r.path.includes(':'));
  assert.ok(withId.length >= 40);
  for (const r of withId) {
    for (const id of ids) {
      const res = await app.api.call(r.method, fill(r.path, id), { token: app.adminToken, body: ['GET', 'DELETE'].includes(r.method) ? undefined : { name: 'Sweep', notes: 'x', statusId: 1 } });
      assert.ok([400, 404].includes(res.status), `${r.method} ${r.path} id=${decodeURIComponent(id)} -> ${res.status} ${res.text.slice(0, 120)}`);
      noLeak(res, `${r.method} ${r.path}`);
    }
  }
  assert.deepEqual(await counts(), before, 'hostile ids must not create, change or delete anything');
});

test('every list endpoint: SQL injection / nonsense in the query string never causes 500 and never widens the caller\'s scope', async () => {
  const lists = routes.filter((r) => r.method === 'GET' && !r.path.includes(':') && r.path.startsWith('/api/') && !PUBLIC.has(`GET ${r.path}`));
  const evil = new URLSearchParams({
    search: "' OR '1'='1", q: "%'; DROP TABLE leads; --", status: '1 OR 1=1', statusId: 'abc', userId: '1 UNION SELECT password FROM users',
    leadId: "1' --", coldCallId: '-1', limit: '-5', offset: 'x', page: '9999999999', sort: 'name; DROP TABLE users', order: 'asc;--',
    from: 'not-a-date', to: '2026-13-45', budgetMin: '1e309', destination: '<script>alert(1)</script>',
  }).toString();
  for (const r of lists) {
    const plain = await app.api.get(r.path, B.token);
    const res = await app.api.get(`${r.path}?${evil}`, B.token);
    assert.ok(res.status < 500, `${r.path}?<injection> -> ${res.status} ${res.text.slice(0, 160)}`);
    noLeak(res, r.path);
    if (res.status === 200 && Array.isArray(res.body) && Array.isArray(plain.body) && res.body.every((x) => x && x.id !== undefined)) {
      const allowed = new Set(plain.body.map((x) => x.id));
      for (const row of res.body) assert.ok(allowed.has(row.id), `${r.path}: injected query returned row ${row.id} that agent B cannot normally see`);
    }
  }
  assert.ok((await app.api.get('/api/users', app.adminToken)).body.length >= 6, 'users table intact');
  assert.equal((await app.api.get('/api/leads', app.adminToken)).status, 200, 'leads table intact');
});

test('text fields: quotes, Arabic, emoji, HTML and SQL characters are stored and returned verbatim; over-long values are refused', async () => {
  const tricky = `O'Brien "قمر" <script>alert(1)</script> 🏠 \\ %_; DROP TABLE leads; --`;
  const created = await app.api.post('/api/leads', { name: tricky, phone: app.uniquePhone('012'), statusId: 1, comment: tricky }, A1.token);
  assert.equal(created.status, 200, created.text);
  const id = created.body.id ?? created.body.item?.id;
  const read = await app.api.get(`/api/leads/${id}`, A1.token);
  assert.equal((read.body.item ?? read.body).name, tricky, 'stored exactly, not escaped, not stripped');

  const at = (n) => 'x'.repeat(n);
  assert.equal((await app.api.post('/api/leads', { name: at(255), phone: app.uniquePhone('012'), statusId: 1 }, A1.token)).status, 200, '255 characters is the limit and is accepted');
  const tooLong = await app.api.post('/api/leads', { name: at(256), phone: app.uniquePhone('012'), statusId: 1 }, A1.token);
  assert.equal(tooLong.status, 400, 'name over 255 characters');
  assert.equal(tooLong.body.code, 'VALIDATION_ERROR');
  assert.equal((await app.api.post('/api/property-types', { name: at(101) }, app.adminToken)).status, 400, 'option names over 100 characters');
  assert.equal((await app.api.post(`/api/leads/${id}/call-actions`, { statusId: 1, notes: at(5001) }, A1.token)).status, 400, 'call notes over 5000 characters');
  const empty = await app.api.post('/api/leads', { name: '   ', phone: '   ', statusId: 1 }, A1.token);
  assert.equal(empty.status, 400, 'blank name / phone');
  const nulls = await app.api.post('/api/leads', { name: null, phone: null, statusId: null }, A1.token);
  assert.equal(nulls.status, 400, 'null name / phone');
  for (const phone of ['abc', '123', '+20 10 1234', '0'.repeat(30)]) {
    assert.equal((await app.api.post('/api/leads', { name: 'Bad Phone', phone, statusId: 1 }, A1.token)).status, 400, `phone "${phone}"`);
  }
  for (const statusId of ['abc', -1, 1.5, 99999999]) {
    const r = await app.api.post('/api/leads', { name: 'Bad Status', phone: app.uniquePhone('012'), statusId }, A1.token);
    assert.equal(r.status, 400, `statusId ${statusId} -> ${r.status}`);
  }
  for (const delivery of ['soon', 'not_specified', '', 5]) {
    const r = await app.api.post('/api/leads', { name: 'Bad Req', phone: app.uniquePhone('012'), statusId: 1, requirements: { delivery } }, A1.token);
    assert.ok(r.status === 400 || (delivery === '' && r.status === 200), `delivery ${JSON.stringify(delivery)} -> ${r.status}`);
  }
});

test('administrator data: every write route on settings / reference data refuses director, team leader and agent (403)', async () => {
  const adminOnly = /^\/api\/(users|statuses|lead-sources|projects|developers|destinations|property-types|departments|jobtitles|titles|brokers|agent-care|deals|admin\/|leads\/import|cold-calls\/import)/;
  const writes = routes.filter((r) => r.method !== 'GET' && adminOnly.test(r.path));
  assert.ok(writes.length >= 35, `only ${writes.length} admin-only write routes found`);
  const SM = await app.createUser({ name: `Sweep Sales Manager ${app.runTag}`, role: 'sales_manager', teamLeaderId: D.id });
  const SS = await app.createUser({ name: `Sweep Supervisor ${app.runTag}`, role: 'sales_supervisor', teamLeaderId: SM.id });
  for (const who of [D, SM, SS, T, A1]) {
    for (const r of writes) {
      const res = await app.api.call(r.method, fill(r.path, 1), { token: who.token, body: r.method === 'DELETE' ? undefined : { name: `Escalation ${who.role}`, role: 'admin', rows: [] } });
      assert.equal(res.status, 403, `${who.role}: ${r.method} ${r.path} -> ${res.status}`);
    }
  }
  assert.equal((await app.api.get('/api/auth/me', A1.token)).body.user.role, 'agent', 'nobody was promoted');
  // the franchise owner is an administrator role: allowed
  const FO = await app.createUser({ name: `Sweep Owner ${app.runTag}`, role: 'franchise_owner' });
  const made = await app.api.post('/api/property-types', { name: `Owner Type ${app.runTag}` }, FO.token);
  assert.equal(made.status, 200, `franchise owner creates a property type -> ${made.status}`);
});

test('another team: every lead / cold call / call route answers 404 for records outside the caller\'s scope', async () => {
  const lead = (await app.api.post('/api/leads', { name: 'A1 private lead', phone: app.uniquePhone('015'), statusId: 1 }, A1.token)).body;
  const leadId = lead.id ?? lead.item?.id;
  const cold = (await app.api.post('/api/cold-calls', { name: 'A1 private cold call', phone: app.uniquePhone('015') }, A1.token)).body;
  const coldId = cold.id ?? cold.item?.id;
  const call = (await app.api.post(`/api/leads/${leadId}/call-actions`, { statusId: 1, notes: 'private' }, A1.token)).body;
  const scoped = routes.filter((r) => /^\/api\/(leads|cold-calls|call-actions)\/:id/.test(r.path));
  assert.ok(scoped.length >= 10);
  for (const r of scoped) {
    const id = r.path.startsWith('/api/leads') ? leadId : r.path.startsWith('/api/cold-calls') ? coldId : call.id;
    // a body that would be VALID for the owner, so only scope can refuse it (call corrections accept notes only)
    const body = ['GET', 'DELETE'].includes(r.method) ? undefined : r.path.startsWith('/api/call-actions') ? { notes: 'hijack' } : { statusId: 1, notes: 'x', name: 'hijack' };
    const res = await app.api.call(r.method, fill(r.path, id), { token: B.token, body });
    assert.equal(res.status, 404, `agent B: ${r.method} ${r.path} -> ${res.status}`);
  }
  for (const q of [`leadId=${leadId}`, `coldCallId=${coldId}`]) {
    assert.equal((await app.api.get(`/api/call-actions?${q}`, B.token)).body.length, 0, `call list ${q}`);
  }
  const still = await app.api.get(`/api/leads/${leadId}`, A1.token);
  assert.equal(still.status, 200, 'the owner still has the lead');
  assert.equal((still.body.item ?? still.body).name, 'A1 private lead', 'and it was not changed');
});

test('a deactivated user is locked out at once: existing token stops working, login refused', async () => {
  const u = await app.createUser({ name: `Leaver ${app.runTag}`, teamLeaderId: T.id });
  assert.equal((await app.api.get('/api/leads', u.token)).status, 200);
  const off = await app.api.put(`/api/users/${u.id}`, { isActive: false }, app.adminToken);
  assert.equal(off.status, 200, off.text);
  const after = await app.api.get('/api/leads', u.token);
  assert.ok([401, 403].includes(after.status), `old token after deactivation -> ${after.status}`);
  assert.ok([401, 403].includes((await app.api.post('/api/auth/login', { email: u.email, password: u.password })).status));
});

test('reporting lines: self, unknown, inactive and circular managers are refused; nothing changes', async () => {
  const self = await app.api.put(`/api/users/${T.id}`, { teamLeaderId: T.id }, app.adminToken);
  assert.equal(self.status, 400, `self as manager -> ${self.status}`);
  const ghost = await app.api.put(`/api/users/${A1.id}`, { teamLeaderId: 99999999 }, app.adminToken);
  assert.equal(ghost.status, 400, `unknown manager -> ${ghost.status}`);
  const loop = await app.api.put(`/api/users/${D.id}`, { teamLeaderId: A1.id }, app.adminToken);
  assert.equal(loop.status, 400, `circular (director under own agent) -> ${loop.status}`);
  const gone = await app.createUser({ name: `Inactive Mgr ${app.runTag}`, role: 'team_leader' });
  await app.api.put(`/api/users/${gone.id}`, { isActive: false }, app.adminToken);
  const inactive = await app.api.put(`/api/users/${A1.id}`, { teamLeaderId: gone.id }, app.adminToken);
  assert.equal(inactive.status, 400, `inactive manager -> ${inactive.status}`);
  // someone whose CURRENT manager is deactivated later can still be edited without choosing a new manager first
  const mgr = await app.createUser({ name: `Leaving Mgr ${app.runTag}`, role: 'team_leader' });
  const member = await app.createUser({ name: `Member ${app.runTag}`, teamLeaderId: mgr.id });
  await app.api.put(`/api/users/${mgr.id}`, { isActive: false }, app.adminToken);
  const edit = await app.api.put(`/api/users/${member.id}`, { name: `Member Renamed ${app.runTag}`, teamLeaderId: mgr.id }, app.adminToken);
  assert.equal(edit.status, 200, `keeping the current (now inactive) manager -> ${edit.status} ${edit.text.slice(0, 120)}`);
  const me = (await app.api.get('/api/users', app.adminToken)).body;
  const byId = Object.fromEntries(me.map((u) => [u.id, u]));
  assert.equal(Number(byId[A1.id].teamLeaderId ?? byId[A1.id].parentId), T.id, 'A1 still reports to T');
  assert.equal(Number(byId[D.id].teamLeaderId ?? byId[D.id].parentId ?? 0) || null, null, 'D unchanged');
});

test('double submission: the same lead posted twice in parallel', async () => {
  const body = { name: 'Double Click Lead', phone: app.uniquePhone('010'), statusId: 1 };
  const [a, b] = await Promise.all([app.api.post('/api/leads', body, A1.token), app.api.post('/api/leads', body, A1.token)]);
  assert.ok(a.status < 500 && b.status < 500);
  const same = (await app.api.get('/api/leads', A1.token)).body.filter((l) => l.phone === body.phone);
  // Documented behaviour (no rule exists): a second lead with the same phone is allowed; the UI disables Save while saving.
  assert.equal(same.length, [a, b].filter((r) => r.status === 200).length, 'every 200 is exactly one stored lead');
});

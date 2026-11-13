import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { schemaName, startTestApp, testEnv } from '../support/harness.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// These tests insert rows into the LEGACY production layout before the app boots, so they only run on that fixture.
const freshDbOnly = schemaName() === 'legacy' ? false : 'needs the legacy production table layout (default test run)';
let app;
before(async () => { app = await startTestApp({ env: { LOGIN_MAX_FAILURES: '3' } }); });
after(async () => { await app.stop(); });

test('login succeeds and never returns the password hash', async () => {
  const u = await app.createUser();
  const r = await app.api.post('/api/auth/login', { email: u.email, password: u.password });
  assert.equal(r.status, 200);
  assert.ok(r.body.token);
  assert.equal(r.body.user.email, u.email);
  assert.equal(JSON.stringify(r.body).includes('$2'), false, 'response must not contain a bcrypt hash');
  assert.equal('password' in r.body.user, false);
});

test('login is case-insensitive on the email and ignores surrounding spaces', async () => {
  const u = await app.createUser();
  assert.equal((await app.api.post('/api/auth/login', { email: `  ${u.email.toUpperCase()} `, password: u.password })).status, 200);
});

test('wrong password and unknown email give the same 401 message (no user enumeration)', async () => {
  const u = await app.createUser();
  const a = await app.api.post('/api/auth/login', { email: u.email, password: 'definitely-wrong' });
  const b = await app.api.post('/api/auth/login', { email: 'nobody@nowhere.test', password: 'definitely-wrong' });
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  assert.equal(a.body.error, b.body.error);
  assert.equal(a.body.code, 'INVALID_CREDENTIALS');
});

test('login validates its input and never leaks internals for malformed JSON', async () => {
  assert.equal((await app.api.post('/api/auth/login', {})).status, 400);
  assert.equal((await app.api.post('/api/auth/login', { email: 'a@b.c' })).status, 400);
  assert.equal((await app.api.post('/api/auth/login', { email: ['x'], password: { $gt: '' } })).status, 400);
  const bad = await app.api.call('POST', '/api/auth/login', { raw: '{"email": ' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'INVALID_JSON');
  assert.equal(/node_modules|at \w+ \(/.test(bad.text), false, 'no stack trace in the response');
});

test('oversized anonymous bodies are rejected with 413 before any work is done', async () => {
  const r = await app.api.call('POST', '/api/auth/login', { raw: JSON.stringify({ email: 'x@y.zz', password: 'p'.repeat(64 * 1024) }) });
  assert.equal(r.status, 413);
});

test('brute force: 3 failures lock that email+IP (429 + Retry-After), other accounts unaffected', async () => {
  const victim = await app.createUser();
  const other = await app.createUser();
  for (let i = 0; i < 3; i += 1) assert.equal((await app.api.post('/api/auth/login', { email: victim.email, password: `bad${i}` })).status, 401);
  const blocked = await app.api.post('/api/auth/login', { email: victim.email, password: victim.password });
  assert.equal(blocked.status, 429, 'even the right password is refused while locked');
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  assert.equal((await app.api.post('/api/auth/login', { email: other.email, password: other.password })).status, 200);
});

test('disabled account: correct password -> 403 ACCOUNT_DISABLED, wrong password -> 401', async () => {
  const u = await app.createUser();
  assert.equal((await app.api.put(`/api/users/${u.id}`, { isActive: false }, app.adminToken)).status, 200);
  const right = await app.api.post('/api/auth/login', { email: u.email, password: u.password });
  assert.equal(right.status, 403);
  assert.equal(right.body.code, 'ACCOUNT_DISABLED');
  assert.equal((await app.api.post('/api/auth/login', { email: u.email, password: 'wrong' })).status, 401);
});

test("a deactivated user's existing token stops working immediately", async () => {
  const u = await app.createUser();
  assert.equal((await app.api.get('/api/auth/me', u.token)).status, 200);
  await app.api.put(`/api/users/${u.id}`, { isActive: false }, app.adminToken);
  const r = await app.api.get('/api/auth/me', u.token);
  assert.equal(r.status, 401);
  assert.equal(r.body.code, 'ACCOUNT_DISABLED');
});

test('tokens: missing, garbage, wrong secret, alg=none and expired are all rejected with 401', async () => {
  assert.equal((await app.api.get('/api/leads')).status, 401);
  assert.equal((await app.api.get('/api/leads', 'garbage')).status, 401);
  assert.equal((await app.api.get('/api/leads', jwt.sign({ sub: '1', role: 'admin' }, 'attacker-secret'))).status, 401);
  const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from('{"sub":"1","role":"admin"}').toString('base64url')}.`;
  assert.equal((await app.api.get('/api/leads', none)).status, 401);
  assert.equal((await app.api.get('/api/leads', jwt.sign({ sub: '1', role: 'admin' }, testEnv().JWT_SECRET, { expiresIn: -30 }))).status, 401);
  assert.equal((await app.api.call('GET', '/api/leads', { headers: { authorization: 'Basic abc' } })).status, 401);
});

test('a token for a user that no longer exists is rejected', async () => {
  assert.equal((await app.api.get('/api/leads', jwt.sign({ sub: '99999', role: 'admin' }, testEnv().JWT_SECRET, { expiresIn: '1h' }))).status, 401);
});

test('the role inside a token is not trusted: privileges come from the database', async () => {
  const u = await app.createUser();
  const forged = jwt.sign({ sub: String(u.id), role: 'admin' }, testEnv().JWT_SECRET, { expiresIn: '1h' });
  assert.equal((await app.api.post('/api/statuses', { name: 'X', color: '#111111' }, forged)).status, 403);
});

test('change password: wrong current -> 400 (not 401), weak -> 400, success rotates the session', async () => {
  const u = await app.createUser({ password: 'Original-Pass-1' });
  const wrong = await app.api.post('/api/auth/change-password', { currentPassword: 'nope', newPassword: 'Another-Pass-22' }, u.token);
  assert.equal(wrong.status, 400, '401 would make the frontend sign the user out');
  assert.equal(wrong.body.code, 'INVALID_CURRENT_PASSWORD');
  assert.equal((await app.api.post('/api/auth/change-password', { currentPassword: 'Original-Pass-1', newPassword: 'short' }, u.token)).status, 400);
  assert.equal((await app.api.post('/api/auth/change-password', { currentPassword: 'Original-Pass-1', newPassword: 'password123' }, u.token)).status, 400);
  assert.equal((await app.api.post('/api/auth/change-password', { currentPassword: 'Original-Pass-1', newPassword: 'Original-Pass-1' }, u.token)).status, 400);
  await sleep(1100); // JWT iat has one-second resolution
  const ok = await app.api.post('/api/auth/change-password', { currentPassword: 'Original-Pass-1', newPassword: 'Brand-New-Pass-7' }, u.token);
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token);
  const old = await app.api.get('/api/auth/me', u.token);
  assert.equal(old.status, 401);
  assert.equal(old.body.code, 'SESSION_REVOKED');
  assert.equal((await app.api.get('/api/auth/me', ok.body.token)).status, 200);
  assert.equal((await app.api.post('/api/auth/login', { email: u.email, password: 'Original-Pass-1' })).status, 401);
  assert.equal((await app.api.post('/api/auth/login', { email: u.email, password: 'Brand-New-Pass-7' })).status, 200);
});

test("admin resetting a password revokes the user's old sessions too", async () => {
  const u = await app.createUser();
  await sleep(1100);
  assert.equal((await app.api.put(`/api/users/${u.id}`, { password: 'Reset-By-Admin-5' }, app.adminToken)).status, 200);
  assert.equal((await app.api.get('/api/auth/me', u.token)).status, 401);
  assert.equal((await app.api.post('/api/auth/login', { email: u.email, password: 'Reset-By-Admin-5' })).status, 200);
});

test('passwords are stored as bcrypt hashes, never in clear text', async () => {
  const u = await app.createUser({ password: 'Plain-Text-Check-3' });
  const [rows] = await app.pool.query('SELECT password FROM users WHERE id = ?', [u.id]);
  assert.match(rows[0].password, /^\$2[aby]\$\d\d\$/);
});

test('plain-text passwords found at startup are hashed and keep working; plain text is never accepted later', { skip: freshDbOnly }, async () => {
  const boot = await startTestApp({
    adminLogin: false,
    prepare: async (pool) => {
      await pool.query("INSERT INTO users (id, name, email, phone, role, password, status, isActive, is_active, createdAt) VALUES (7, 'Legacy', 'legacy@test.local', '01000000000', 'agent', 'LegacyPass-1', 1, 1, 1, '2026-01-01')");
    },
  });
  try {
    const [rows] = await boot.pool.query('SELECT password FROM users WHERE id = 7');
    assert.match(rows[0].password, /^\$2[aby]\$/, 'migration 004 must hash it');
    assert.equal((await boot.api.post('/api/auth/login', { email: 'legacy@test.local', password: 'LegacyPass-1' })).status, 200);
    await boot.pool.query("UPDATE users SET password = 'ClearText-9' WHERE id = 7");
    assert.equal((await boot.api.post('/api/auth/login', { email: 'legacy@test.local', password: 'ClearText-9' })).status, 401);
  } finally { await boot.stop(); }
});

test('hashes made by the old server keep working (bcrypt compatible)', { skip: freshDbOnly }, async () => {
  const legacyHash = bcrypt.hashSync('OldServerHash-1', 10);
  const boot = await startTestApp({
    adminLogin: false,
    prepare: async (pool) => {
      await pool.query("INSERT INTO users (id, name, email, phone, role, password, status, createdAt) VALUES (8, 'Old', 'Old.User@Test.Local', '0100', 'agent', ?, 1, '2026-01-01')", [legacyHash]);
    },
  });
  try {
    assert.equal((await boot.api.post('/api/auth/login', { email: 'old.user@test.local', password: 'OldServerHash-1' })).status, 200, 'mixed-case legacy email');
  } finally { await boot.stop(); }
});

test('a fresh database never gets a default "password" admin; the generated one is random', { skip: freshDbOnly }, async () => {
  const boot = await startTestApp({ adminLogin: false, env: { INITIAL_ADMIN_PASSWORD: '' } });
  try {
    assert.equal((await boot.api.post('/api/auth/login', { email: 'admin@test.local', password: 'password' })).status, 401);
    const [rows] = await boot.pool.query('SELECT COUNT(*) AS c FROM users');
    assert.equal(Number(rows[0].c), 1);
  } finally { await boot.stop(); }
});

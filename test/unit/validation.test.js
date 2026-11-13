import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEgyptianMobile, normalizeInternational, normalizeClientPhone } from '../../src/lib/phone.js';
import { Validator, parseId } from '../../src/lib/validate.js';
import { toSqlDate, toSqlDateTime, toIso, isRealDate } from '../../src/lib/dates.js';
import { checkPasswordStrength, isBcryptHash } from '../../src/auth/passwords.js';
import { Scope, normalizeRole, isSuper, canAssign } from '../../src/auth/policy.js';
import { redact } from '../../src/domain/audit.js';
import { describeError, AppError } from '../../src/http/errors.js';
import { pickStatus } from '../../src/domain/lookups.js';

test('Egyptian mobile numbers: 11 digits with 010 / 011 / 012 / 015, many spellings, one stored form', () => {
  for (const ok of ['01012345678', '01112345678', '01212345678', '01512345678', '010 1234 5678', '010-1234-5678', '+201012345678', '00201012345678', '201012345678', '(010) 1234 5678']) {
    assert.match(normalizeEgyptianMobile(ok) ?? '', /^01[0125]\d{8}$/, ok);
  }
  for (const bad of ['', '0101234567', '010123456789', '01312345678', '01412345678', '02123456789', '+441012345678', 'abc', '01O12345678', '1012345678', null, undefined]) {
    assert.equal(normalizeEgyptianMobile(bad), null, String(bad));
  }
  assert.equal(normalizeEgyptianMobile('1012345678', { allowMissingZero: true }), '01012345678');
});

test('international client numbers need a + (or 00) and 8-15 digits, never +20', () => {
  assert.equal(normalizeInternational('+44 7700 900123'), '+447700900123');
  assert.equal(normalizeInternational('00971501234567'), '+971501234567');
  assert.equal(normalizeInternational('+2010123456789'), null);
  assert.equal(normalizeInternational('447700900123'), null);
  assert.equal(normalizeInternational('+12345'), null);
  assert.equal(normalizeClientPhone('+20 10 1234 5678'), '01012345678');
});

test('Validator collects all problems and returns canonical values', () => {
  const v = new Validator();
  assert.equal(v.string('  hi  ', 'a'), 'hi');
  assert.equal(v.email(' A@B.CO ', 'e'), 'a@b.co');
  assert.equal(v.int('42', 'n'), 42);
  assert.equal(v.money('1,500,000.555', 'm'), 1500000.56);
  assert.equal(v.date('2026-02-28', 'd'), '2026-02-28');
  assert.equal(v.bool('true'), true);
  assert.deepEqual(v.intList([3, '3', 4], 'ids'), [3, 4]);
  assert.equal(v.errors.length, 0);
  v.int('4.5', 'n'); v.money(-1, 'm'); v.date('2026-02-30', 'd'); v.email('x@', 'e'); v.oneOf('z', 'o', ['a']); v.intList([0], 'ids'); v.egyptianMobile('123', 'p');
  assert.equal(v.errors.length, 7);
  assert.throws(() => v.assert(), (err) => err.status === 400 && err.details.length === 7);
});

test('parseId only accepts positive 32-bit integers', () => {
  assert.equal(parseId('17'), 17);
  for (const bad of ['0', '-1', 'abc', '1.5', '1 OR 1=1', '99999999999', '']) assert.throws(() => parseId(bad), (e) => e.status === 400, bad);
});

test('dates are handled in UTC and invalid calendar dates are rejected', () => {
  assert.equal(isRealDate('2024-02-29'), true);
  assert.equal(isRealDate('2026-02-29'), false);
  assert.equal(toSqlDate('2026-03-01T23:30:00+02:00'), '2026-03-01');
  assert.equal(toSqlDateTime('2026-03-01T10:00:00Z'), '2026-03-01 10:00:00');
  assert.equal(toSqlDateTime('garbage', null), null);
  assert.equal(toIso('2026-03-01 10:00:00'), '2026-03-01T10:00:00.000Z');
});

test('password rules', () => {
  assert.equal(checkPasswordStrength('Str0ng-Pass-9'), null);
  for (const weak of ['short', 'password', 'Mentors123!', 'aaaaaaaaaa', 'p'.repeat(80)]) assert.ok(checkPasswordStrength(weak), weak);
  assert.ok(checkPasswordStrength('me@x.com', { email: 'me@x.com' }));
  assert.equal(isBcryptHash('$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234'), true);
  assert.equal(isBcryptHash('password'), false);
});

test('roles and scopes', () => {
  assert.equal(normalizeRole(' Team Leader '), 'team_leader');
  assert.equal(isSuper({ role: 'franchise_owner' }), true);
  assert.equal(isSuper({ role: 'director' }), false);
  assert.equal(canAssign({ role: 'agent' }), false);
  assert.equal(canAssign({ role: 'sales_supervisor' }), true);
  const s = new Scope({ all: false, ids: new Set([1, 2]) });
  assert.equal(s.has(2), true);
  assert.equal(s.has(3), false);
  assert.equal(s.has(null), false);
  assert.deepEqual(s.sqlIn('x'), { sql: 'x IN (?, ?)', params: [1, 2] });
  assert.deepEqual(new Scope({ all: true }).sqlIn('x'), { sql: '1 = 1', params: [] });
});

test('audit redaction removes secrets and blobs at any depth', () => {
  const out = redact({ a: { password: 'x', nested: { token: 'y', ok: 1 } }, hash: '$2b$10$zzzz', list: [{ image: 'data:...' }], note: '$2a$10$abc' });
  assert.deepEqual(out, { a: { password: '[redacted]', nested: { token: '[redacted]', ok: 1 } }, hash: '[redacted]', list: [{ image: '[redacted]' }], note: '[redacted]' });
});

test('error responses never contain internal messages', () => {
  assert.deepEqual(describeError(new Error("Table 'x' doesn't exist")).body, { error: 'Internal server error', code: 'INTERNAL' });
  assert.equal(describeError(Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' })).status, 409);
  assert.equal(describeError(Object.assign(new Error('gone'), { code: 'ECONNREFUSED' })).status, 503);
  assert.equal(describeError({ type: 'entity.too.large' }).status, 413);
  assert.equal(describeError(new AppError(418, 'TEAPOT', 'short and stout')).body.error, 'short and stout');
});

test('pickStatus: 0 / missing -> first status, unknown id rejected, name match is case-insensitive', () => {
  const cat = [{ id: 1, name: 'New Lead' }, { id: 3, name: 'Potential' }];
  assert.equal(pickStatus(cat, {}).id, 1);
  assert.equal(pickStatus(cat, { statusId: 0 }).id, 1);
  assert.equal(pickStatus(cat, { statusName: 'potential' }).id, 3);
  assert.throws(() => pickStatus(cat, { statusId: 9 }), (e) => e.status === 400);
  assert.throws(() => pickStatus([], {}), (e) => e.status === 400);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, INSECURE_JWT_SECRETS } from '../../src/config.js';

const STRONG = '9d1c6f0b7e3a4c58b2f1a6d4e8c07b35f4a9d2c1e6b8037a5c4d9e1f2b3a6c70';
const base = { DB_USER: 'u', DB_NAME: 'd' };

test('a missing or blank JWT secret stops the server in every environment', () => {
  for (const NODE_ENV of ['development', 'test', 'production', undefined]) {
    for (const JWT_SECRET of [undefined, '', '   ']) {
      const config = loadConfig({ ...base, NODE_ENV, JWT_SECRET });
      assert.equal(config.errors.length, 1);
      assert.match(config.errors[0], /JWT_SECRET is not set/);
    }
  }
});

test('well-known placeholder secrets (incl. the one in the current .env template) are refused everywhere', () => {
  for (const known of INSECURE_JWT_SECRETS) {
    for (const value of [known, known.toUpperCase(), `  ${known}  `]) {
      const config = loadConfig({ ...base, NODE_ENV: 'development', JWT_SECRET: value });
      assert.equal(config.errors.length, 1, value);
      assert.match(config.errors[0], /placeholder/);
    }
  }
});

test('a short secret only warns in development, is fatal in production; a strong one is clean', () => {
  const weak = loadConfig({ ...base, NODE_ENV: 'development', JWT_SECRET: 'my-company-key-2026' });
  assert.deepEqual(weak.errors, []);
  assert.ok(weak.warnings.some((w) => /JWT_SECRET/.test(w)));
  assert.equal(weak.jwt.secret, 'my-company-key-2026', 'never silently replaced');
  assert.match(loadConfig({ ...base, NODE_ENV: 'production', JWT_SECRET: 'my-company-key-2026' }).errors[0], /weak/);
  const strong = loadConfig({ ...base, NODE_ENV: 'production', JWT_SECRET: STRONG, CORS_ORIGIN: 'https://crm.example.com' });
  assert.deepEqual(strong.errors, []);
  assert.deepEqual(strong.warnings, []);
});

test('CORS origins: both variable names work, "*" is explicit, development has localhost defaults', () => {
  const both = loadConfig({ ...base, JWT_SECRET: STRONG, CORS_ORIGIN: 'https://a.example.com, https://b.example.com', CORS_ORIGINS: 'https://c.example.com' });
  assert.deepEqual(both.cors.origins, ['https://a.example.com', 'https://b.example.com', 'https://c.example.com']);
  assert.equal(loadConfig({ ...base, JWT_SECRET: STRONG, CORS_ORIGIN: '*' }).cors.allowAll, true);
  assert.ok(loadConfig({ ...base, JWT_SECRET: STRONG }).cors.origins.includes('http://localhost:5173'));
  assert.ok(loadConfig({ ...base, JWT_SECRET: STRONG, NODE_ENV: 'production' }).warnings.some((w) => /CORS_ORIGIN/.test(w)));
});

const toInt = (value, fallback, { min = -Infinity, max = Infinity } = {}) => {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback;
};
const toList = (value) => String(value ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/** DB settings only – shared by the app and by the maintenance scripts (scripts/*.mjs). */
export function readDbConfig(env = process.env) {
  return {
    host: env.DB_HOST || '127.0.0.1',
    port: toInt(env.DB_PORT, 3306, { min: 1, max: 65535 }),
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    poolSize: toInt(env.DB_POOL_SIZE, 15, { min: 1, max: 100 }),
    queueLimit: toInt(env.DB_QUEUE_LIMIT, 300, { min: 0, max: 10000 }),
    connectRetries: toInt(env.DB_CONNECT_RETRIES, 15, { min: 0, max: 120 }),
  };
}

const LOOKS_PLACEHOLDER = /replace|change|secret|password|example|mentors-dev|your_|test/i;

/**
 * Values that are never acceptable as a signing secret, in ANY environment: anyone who has read the project's .env
 * examples or its old source code knows them and could mint a valid administrator token.
 */
export const INSECURE_JWT_SECRETS = new Set([
  'replace_me_in_production', 'dev-local-secret-change-me', 'changeme', 'change_me', 'secret', 'default-secret',
  'mentors-dev-secret', 'password', 'jwt_secret', 'your_jwt_secret', 'your-secret-key',
]);

/**
 * Reads and validates configuration.  Never throws: returns `errors` (fatal) and `warnings` so the caller decides how
 * to report them.  A missing or well-known JWT secret is fatal everywhere; a merely short one only in production.
 */
export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  const isProd = nodeEnv === 'production';
  const errors = [];
  const warnings = [];

  const secret = String(env.JWT_SECRET ?? '').trim();
  if (!secret) {
    errors.push('JWT_SECRET is not set. Generate one with `npm run gen-secret` (it can write it into .env for you).');
  } else if (INSECURE_JWT_SECRETS.has(secret.toLowerCase())) {
    errors.push('JWT_SECRET is set to a well-known placeholder value. Replace it with a random one: `npm run gen-secret -- --write`.');
  } else if (secret.length < 32 || LOOKS_PLACEHOLDER.test(secret)) {
    if (isProd) errors.push('JWT_SECRET is weak. Set a random value of 32+ characters (`npm run gen-secret`).');
    else warnings.push('JWT_SECRET is short or looks like a placeholder; anyone who guesses it can forge logins. Run `npm run gen-secret -- --write`.');
  }

  // CORS_ORIGIN is the name the project already used; CORS_ORIGINS is accepted too. Both take a comma-separated list.
  const corsRaw = [...toList(env.CORS_ORIGIN), ...toList(env.CORS_ORIGINS)];
  const corsAll = corsRaw.includes('*');
  let corsOrigins = corsRaw.filter((o) => o !== '*');
  if (!corsRaw.length && !isProd) {
    corsOrigins = ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:4173', 'http://127.0.0.1:4173', 'http://localhost:3000'];
  }
  if (!corsRaw.length && isProd) {
    warnings.push('CORS_ORIGIN is not set: browsers on other origins (your frontend domain) will be blocked. Example: CORS_ORIGIN=https://crm.example.com');
  }
  if (corsAll && isProd) warnings.push('CORS_ORIGIN=* lets any website call this API from a browser. List your real frontend origin instead.');

  let trustProxy = false;
  const tp = env.TRUST_PROXY;
  if (tp !== undefined && tp !== '') trustProxy = /^\d+$/.test(tp) ? Number(tp) : tp === 'true' ? true : tp;

  return {
    nodeEnv,
    isProd,
    port: toInt(env.PORT, 4001, { min: 0, max: 65535 }),
    db: readDbConfig(env),
    jwt: { secret, expiresIn: env.JWT_EXPIRES_IN || '7d' },
    cors: { origins: corsOrigins, allowAll: corsAll },
    trustProxy,
    bcryptRounds: toInt(env.BCRYPT_ROUNDS, 10, { min: 4, max: 14 }),
    logLevel: env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
    logJson: isProd || env.LOG_FORMAT === 'json',
    shutdownTimeoutMs: toInt(env.SHUTDOWN_TIMEOUT_MS, 10000, { min: 1000, max: 120000 }),
    limits: {
      loginPerIpPerMin: toInt(env.LOGIN_MAX_PER_IP_PER_MIN, 60, { min: 1 }),
      loginFailuresPer15Min: toInt(env.LOGIN_MAX_FAILURES, 8, { min: 1 }),
      apiPerIpPer15Min: toInt(env.API_MAX_PER_IP_PER_15MIN, 6000, { min: 10 }),
      apiPerUserPerMin: toInt(env.API_MAX_PER_USER_PER_MIN, 1200, { min: 10 }),
    },
    initialAdmin: {
      email: env.INITIAL_ADMIN_EMAIL || 'admin@mentors.com',
      password: env.INITIAL_ADMIN_PASSWORD || '',
      name: env.INITIAL_ADMIN_NAME || 'System Admin',
    },
    errors,
    warnings,
  };
}

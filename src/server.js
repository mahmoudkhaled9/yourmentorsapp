import http from 'node:http';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createDb, createMysqlPool, waitForDatabase } from './db.js';
import { createPasswordService } from './auth/passwords.js';
import { createTokenService } from './auth/tokens.js';
import { loadScope } from './auth/policy.js';
import { createAuditor } from './domain/audit.js';
import { loadSchema } from './schema.js';
import { runMigrations } from './migrations/index.js';
import { seedBaseData } from './seed.js';
import { createApp } from './app.js';

const USER_AUTH_COLUMNS = ['id', 'name', 'email', 'phone', 'role', 'title', 'department', 'department_id', 'jobtitle_id', 'parent_id', 'status', 'image', 'created_at', 'updated_at', 'password_changed_at'];

/** Builds what the app needs (db, schema cache, services) AFTER migrations ran. Exported so tests can use another DB. */
export async function createContext({ config, pool, logger, waitForDb = true }) {
  const db = createDb(pool);
  if (waitForDb) await waitForDatabase(db, { retries: config.db.connectRetries, logger });
  const passwords = createPasswordService({ rounds: config.bcryptRounds });
  const tokens = createTokenService(config.jwt);
  const ctx = { config, logger, db, passwords, tokens, onClose: [] };
  await runMigrations(ctx);
  ctx.schema = await loadSchema(db);
  ctx.userColumns = ctx.schema.pick('users', USER_AUTH_COLUMNS).join(', ');
  ctx.audit = createAuditor({ db, logger });
  ctx.scopeFor = (req) => {
    req.scopePromise ??= loadScope(db, req.currentUser);
    return req.scopePromise;
  };
  await seedBaseData(ctx);
  return ctx;
}

export async function start({ config = loadConfig(), logger, pool, installProcessHandlers = true } = {}) {
  logger ??= createLogger({ level: config.logLevel, json: config.logJson });
  if (config.errors.length) {
    for (const message of config.errors) logger.error(`configuration error: ${message}`);
    throw new Error('Invalid configuration, refusing to start (see the messages above)');
  }
  for (const message of config.warnings) logger.warn(`configuration: ${message}`);
  if (!pool && (!config.db.user || !config.db.database)) throw new Error('DB_USER and DB_NAME must be set (see .env.example)');

  pool ??= createMysqlPool(config.db);
  const ctx = await createContext({ config, pool, logger });
  const app = createApp(ctx);
  const server = http.createServer(app);
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  server.requestTimeout = 60000;
  await new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') err.message = `Port ${config.port} is already in use (is the backend already running?). Stop the other process or set PORT in .env.`;
      reject(err);
    });
    server.listen(config.port, () => resolve());
  });
  const port = server.address().port;
  logger.info(`Mentors CRM API listening on port ${port}`, { env: config.nodeEnv, cors: config.cors.allowAll ? '*' : config.cors.origins });

  let closing;
  async function close(reason = 'shutdown') {
    closing ??= (async () => {
      logger.info(`shutting down (${reason})`);
      const force = setTimeout(() => { logger.error('forced shutdown after timeout'); server.closeAllConnections?.(); }, config.shutdownTimeoutMs);
      force.unref();
      await new Promise((resolve) => { server.close(() => resolve()); server.closeIdleConnections?.(); });
      ctx.onClose.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
      try { await ctx.db.close(); } catch { /* pool already closed */ }
      clearTimeout(force);
    })();
    return closing;
  }

  if (installProcessHandlers) {
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => close(signal).then(() => process.exit(0)));
    // Request handlers convert their own errors to responses; a stray rejection is logged, not fatal.
    process.on('unhandledRejection', (reason) => logger.error('unhandled promise rejection', { err: reason instanceof Error ? reason : new Error(String(reason)) }));
    // After an uncaught exception process state is unknown: log, drain, exit so the supervisor (pm2/systemd/docker) restarts us.
    process.on('uncaughtException', (err) => {
      logger.error('uncaught exception, shutting down', { err });
      close('uncaughtException').finally(() => process.exit(1));
    });
  }
  return { app, server, ctx, close, port };
}

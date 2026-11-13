import express from 'express';
import { asyncHandler, errorHandler, notFoundHandler } from './http/errors.js';
import { corsMiddleware, jsonResponses, requestContext, securityHeaders } from './http/middleware.js';
import { createApiRouter } from './routes/index.js';

const withTimeout = (promise, ms) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms).unref())]);

export function createApp(ctx) {
  const { config, logger, db } = ctx;
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);

  app.use(requestContext({ logger }));
  app.use(securityHeaders({ isProd: config.isProd }));
  app.use(corsMiddleware(config.cors));
  app.use(jsonResponses());

  // Liveness: the process is up. Readiness (/health, /api/health): the database answers. Neither exposes internal errors.
  app.get('/live', (req, res) => res.json({ status: 'ok', uptime: Math.round(process.uptime()) }));
  const health = asyncHandler(async (req, res) => {
    try {
      await withTimeout(db.query('SELECT 1'), 2000);
      res.json({ status: 'healthy', ok: true, timestamp: new Date().toISOString() });
    } catch {
      res.status(503).json({ status: 'unhealthy', ok: false, timestamp: new Date().toISOString() });
    }
  });
  app.get(['/health', '/api/health'], health);

  app.use('/api', createApiRouter(ctx));
  app.use(notFoundHandler);
  app.use(errorHandler({ logger }));
  return app;
}

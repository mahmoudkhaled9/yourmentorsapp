import express from 'express';
import rateLimit from 'express-rate-limit';
import { authenticate, routeAwareJsonParser } from '../http/middleware.js';
import { createCounter, rateLimitMiddleware } from '../http/rateLimit.js';
import { accountRoutes, publicAuthRoutes } from './auth.js';
import { userRoutes } from './users.js';
import { referenceRoutes } from './reference.js';
import { recordRoutes } from './records.js';
import { importRoutes } from './imports.js';
import { commentRoutes } from './comments.js';
import { dealRoutes } from './deals.js';
import { miscRoutes } from './misc.js';
import { coldCallSpec, leadSpec } from '../domain/recordSpecs.js';

/** Order matters: per-IP limit -> public login -> authentication -> per-user limit -> body parsing -> protected routes. */
export function createApiRouter(ctx) {
  const api = express.Router();
  const perUser = createCounter({ windowMs: 60000, max: ctx.config.limits.apiPerUserPerMin });
  ctx.onClose.push(() => perUser.stop());

  api.use(rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: ctx.config.limits.apiPerIpPer15Min,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: 'Too many requests from this network, please slow down', code: 'RATE_LIMITED', requestId: req.id }),
  }));
  api.use(publicAuthRoutes(ctx));
  api.use(authenticate({ db: ctx.db, tokens: ctx.tokens, userColumns: ctx.userColumns }));
  api.use(rateLimitMiddleware(perUser, { keyFn: (req) => `u${req.currentUser.id}`, message: 'Too many requests, please slow down' }));
  api.use(routeAwareJsonParser());

  api.use(accountRoutes(ctx));
  api.use(userRoutes(ctx));
  api.use(referenceRoutes(ctx));
  api.use(importRoutes(ctx));
  api.use(recordRoutes(ctx, leadSpec(ctx)));
  api.use(recordRoutes(ctx, coldCallSpec()));
  api.use(commentRoutes(ctx));
  api.use(dealRoutes(ctx));
  api.use(miscRoutes(ctx));
  return api;
}

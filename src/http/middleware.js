import crypto from 'node:crypto';
import zlib from 'node:zlib';
import express from 'express';
import helmet from 'helmet';
import { unauthorized } from './errors.js';
import { isActiveUser } from '../auth/policy.js';
import { passwordVersion } from '../auth/tokens.js';

/** Assigns a request id (honours a sane inbound X-Request-Id) and writes one access-log line per request. */
export function requestContext({ logger }) {
  return (req, res, next) => {
    const inbound = req.headers['x-request-id'];
    req.id = typeof inbound === 'string' && /^[\w.-]{8,64}$/.test(inbound) ? inbound : crypto.randomUUID();
    res.setHeader('X-Request-Id', req.id);
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      if (req.path === '/health' || req.path === '/api/health' || req.path === '/live') return;
      const ms = Math.round(Number(process.hrtime.bigint() - started) / 1e6);
      const meta = { requestId: req.id, method: req.method, path: req.originalUrl.split('?')[0], status: res.statusCode, ms, user: req.currentUser?.id };
      if (res.statusCode >= 500) logger.error('request', meta);
      else if (res.statusCode >= 400) logger.warn('request', meta);
      else logger.info('request', meta);
    });
    next();
  };
}

/** helmet's defaults for an API that only ever returns JSON (nothing here is meant to be framed or executed). */
export function securityHeaders({ isProd }) {
  const h = helmet({
    contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    hsts: isProd ? { maxAge: 15552000, includeSubDomains: true } : false,
  });
  return (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    h(req, res, next);
  };
}

/** Allow-list CORS. Requests without an Origin header (same-origin, curl, server-to-server, mobile WebView) are untouched. */
export function corsMiddleware({ origins, allowAll }) {
  const allowed = new Set(origins);
  return (req, res, next) => {
    const origin = req.headers.origin;
    const ok = Boolean(origin) && (allowAll || allowed.has(origin));
    if (ok) {
      res.setHeader('Access-Control-Allow-Origin', allowAll ? '*' : origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id, Retry-After');
    }
    if (req.method === 'OPTIONS' && req.headers['access-control-request-method']) {
      if (ok) {
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Request-Id');
        res.setHeader('Access-Control-Max-Age', '600');
      }
      res.status(204).end();
      return;
    }
    next();
  };
}

/** res.json with async gzip for larger payloads (does not block the event loop on big lists). */
export function jsonResponses({ minBytes = 1024 } = {}) {
  return (req, res, next) => {
    res.json = (body) => {
      const payload = Buffer.from(JSON.stringify(body === undefined ? null : body), 'utf8');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Vary', res.getHeader('Vary') ? `${res.getHeader('Vary')}, Accept-Encoding` : 'Accept-Encoding');
      const send = (buf) => {
        res.setHeader('Content-Length', buf.length);
        if (req.method === 'HEAD') res.end(); else res.end(buf);
      };
      if (payload.length >= minBytes && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
        zlib.gzip(payload, { level: 5 }, (err, zipped) => {
          if (err) { send(payload); return; }
          res.setHeader('Content-Encoding', 'gzip');
          send(zipped);
        });
      } else {
        send(payload);
      }
      return res;
    };
    next();
  };
}

const LARGE_BODY_ROUTES = [
  { re: /^\/deals(\/\d+)?$/, limit: '25mb' },
  { re: /^\/developers(\/\d+)?$/, limit: '10mb' },
  { re: /^\/(leads|cold-calls)\/import$/, limit: '15mb' },
];

/** Parses JSON with a per-route size limit. Runs AFTER authentication, so anonymous clients can never make us buffer big bodies. */
export function routeAwareJsonParser() {
  const parsers = new Map();
  const parserFor = (limit) => {
    if (!parsers.has(limit)) parsers.set(limit, express.json({ limit }));
    return parsers.get(limit);
  };
  return (req, res, next) => {
    const hit = LARGE_BODY_ROUTES.find((r) => r.re.test(req.path));
    return parserFor(hit?.limit ?? '1mb')(req, res, next);
  };
}

export const smallJsonParser = () => express.json({ limit: '10kb' });

/** Verifies the bearer token and loads the current user fresh from the DB on every request (deactivation is immediate). */
export function authenticate({ db, tokens, userColumns }) {
  return async (req, res, next) => {
    try {
      const header = String(req.headers.authorization ?? '');
      const match = header.match(/^Bearer\s+(\S+)$/i);
      if (!match) throw unauthorized('Authentication required', 'AUTH_REQUIRED');
      let payload;
      try {
        payload = tokens.verify(match[1]);
      } catch {
        throw unauthorized('Your session is invalid or has expired, please sign in again', 'TOKEN_INVALID');
      }
      const userId = Number(payload.sub);
      if (!Number.isInteger(userId) || userId <= 0) throw unauthorized('Invalid session', 'TOKEN_INVALID');
      const user = await db.one(`SELECT ${userColumns} FROM users WHERE id = ? LIMIT 1`, [userId]);
      if (!user) throw unauthorized('Account no longer exists', 'TOKEN_INVALID');
      if (!isActiveUser(user)) throw unauthorized('This account is disabled', 'ACCOUNT_DISABLED');
      const version = passwordVersion(user);
      // Tokens carry the password version they were issued for and must match it exactly (a change in the same second
      // as the token's iat is still a change). Tokens issued before `pwv` existed keep the older iat rule.
      const revoked = payload.pwv !== undefined ? Number(payload.pwv) !== version : version > 0 && Number(payload.iat) < version;
      if (revoked) throw unauthorized('Your password was changed, please sign in again', 'SESSION_REVOKED');
      req.auth = payload;
      req.currentUser = user;
      next();
    } catch (err) {
      next(err);
    }
  };
}

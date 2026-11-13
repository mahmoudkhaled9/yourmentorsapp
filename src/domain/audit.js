import { nowSql } from '../lib/dates.js';

const SENSITIVE_KEY = /pass(word)?|token|secret|hash|image|avatar|attachments|reservations?_?images/i;

/** Deep-copies `value` dropping secrets/blobs and shortening long strings so logs stay small and safe. */
export function redact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return depth > 3 ? '[…]' : value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    if (depth > 3) return '[…]';
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
    return out;
  }
  if (typeof value === 'string') {
    if (/^\$2[aby]\$\d\d\$/.test(value)) return '[redacted]';
    return value.length > 300 ? `${value.slice(0, 300)}…` : value;
  }
  return value;
}

/** Best-effort audit trail: a failure here never fails the business operation. */
export function createAuditor({ db, logger }) {
  return async function audit({ userId, entityType, entityId = null, action, summary, metadata = null }, run = db) {
    try {
      let json = null;
      if (metadata !== null && metadata !== undefined) {
        json = JSON.stringify(redact(metadata));
        if (json.length > 8000) json = JSON.stringify({ truncated: true });
      }
      await run.exec(
        'INSERT INTO activity_logs (user_id, entity_type, entity_id, action, summary, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [userId ?? null, entityType, entityId, action, String(summary ?? '').slice(0, 500), json, nowSql()]
      );
    } catch (err) {
      logger.warn('audit log write failed', { err: err.message });
    }
  };
}

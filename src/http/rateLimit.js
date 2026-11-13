import { tooMany } from './errors.js';

/** Fixed-window counters kept in memory (per process). Bounded size, self-cleaning. */
export function createCounter({ windowMs, max = Infinity, maxKeys = 50000, now = () => Date.now() }) {
  const entries = new Map();
  const sweep = () => {
    const t = now();
    for (const [key, entry] of entries) if (entry.resetAt <= t) entries.delete(key);
  };
  const timer = setInterval(sweep, Math.min(windowMs, 60000));
  timer.unref?.();
  const read = (key) => {
    const entry = entries.get(key);
    return entry && entry.resetAt > now() ? entry : undefined;
  };
  return {
    hit(key) {
      const t = now();
      let entry = read(key);
      if (!entry) {
        if (entries.size >= maxKeys) { sweep(); if (entries.size >= maxKeys) entries.clear(); }
        entry = { count: 0, resetAt: t + windowMs };
        entries.set(key, entry);
      }
      entry.count += 1;
      return { count: entry.count, limited: entry.count > max, retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - t) / 1000)) };
    },
    peek(key) {
      const entry = read(key);
      return entry
        ? { count: entry.count, limited: entry.count >= max, retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - now()) / 1000)) }
        : { count: 0, limited: false, retryAfterSec: 0 };
    },
    reset(key) { entries.delete(key); },
    stop() { clearInterval(timer); },
  };
}

export function rateLimitMiddleware(counter, { keyFn, message }) {
  return (req, res, next) => {
    const result = counter.hit(keyFn(req));
    if (result.limited) { next(tooMany(message, result.retryAfterSec)); return; }
    next();
  };
}

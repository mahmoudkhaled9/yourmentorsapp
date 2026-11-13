const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

function errorMeta(x) {
  if (!x) return x;
  if (x instanceof Error) return { err: x.message, code: x.code, stack: x.stack };
  if (x.err instanceof Error) return { ...x, err: x.err.message, code: x.err.code ?? x.code, stack: x.err.stack };
  return x;
}

/** Minimal structured logger. JSON lines in production, readable lines in development. Never logs secrets on its own. */
export function createLogger({ level = 'info', json = false, sink = console } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const emit = (lvl, msg, meta) => {
    if (LEVELS[lvl] < threshold) return;
    const time = new Date().toISOString();
    const extra = meta && Object.keys(meta).length ? meta : undefined;
    const line = json
      ? JSON.stringify({ time, level: lvl, msg, ...extra })
      : `${time} ${lvl.toUpperCase().padEnd(5)} ${msg}${extra ? ` ${JSON.stringify(extra)}` : ''}`;
    (lvl === 'error' ? sink.error : lvl === 'warn' ? sink.warn : sink.log).call(sink, line);
  };
  return {
    debug: (m, x) => emit('debug', m, x),
    info: (m, x) => emit('info', m, x),
    warn: (m, x) => emit('warn', m, x),
    error: (m, x) => emit('error', m, errorMeta(x)),
  };
}

/** An error whose message is safe to show to the client. */
export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message = 'Invalid request', details) => new AppError(400, 'VALIDATION_ERROR', message, details);
export const unauthorized = (message = 'Unauthorized', code = 'UNAUTHORIZED') => new AppError(401, code, message);
export const forbidden = (message = 'You are not allowed to do this', code = 'FORBIDDEN') => new AppError(403, code, message);
export const notFound = (message = 'Not found') => new AppError(404, 'NOT_FOUND', message);
export const conflict = (message, code = 'CONFLICT', details) => new AppError(409, code, message, details);
export const tooMany = (message = 'Too many requests, please slow down', retryAfterSec = 60) => {
  const e = new AppError(429, 'RATE_LIMITED', message);
  e.retryAfterSec = retryAfterSec;
  return e;
};

/** Express 4 does not catch rejected promises: every async handler goes through this. */
export const asyncHandler = (fn) => (req, res, next) => {
  try {
    Promise.resolve(fn(req, res, next)).catch(next);
  } catch (err) {
    next(err);
  }
};

const TRANSIENT_DB_CODES = new Set([
  'PROTOCOL_CONNECTION_LOST', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ER_CON_COUNT_ERROR',
  'ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT', 'ER_QUERY_TIMEOUT', 'PROTOCOL_SEQUENCE_TIMEOUT', 'POOL_CLOSED',
  'ER_ACCESS_DENIED_ERROR', 'ER_BAD_DB_ERROR',
]);

export const isDuplicateKey = (err) => err?.code === 'ER_DUP_ENTRY' || err?.errno === 1062;
export const isDeadlock = (err) => err?.code === 'ER_LOCK_DEADLOCK' || err?.errno === 1213;

/** Turns any thrown value into { status, body } without ever leaking SQL, stack traces or internal messages. */
export function describeError(err) {
  if (err instanceof AppError) {
    const body = { error: err.message, code: err.code };
    if (err.details) body.details = err.details;
    return { status: err.status, body, headers: err.retryAfterSec ? { 'Retry-After': String(err.retryAfterSec) } : undefined };
  }
  if (err?.type === 'entity.too.large') return { status: 413, body: { error: 'Request body is too large', code: 'PAYLOAD_TOO_LARGE' } };
  if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) return { status: 400, body: { error: 'Request body is not valid JSON', code: 'INVALID_JSON' } };
  if (err?.type === 'charset.unsupported' || err?.type === 'encoding.unsupported') return { status: 415, body: { error: 'Unsupported request encoding', code: 'UNSUPPORTED_MEDIA_TYPE' } };
  if (isDuplicateKey(err)) return { status: 409, body: { error: 'A record with the same unique value already exists', code: 'DUPLICATE' } };
  if (err?.code === 'ER_DATA_TOO_LONG' || err?.errno === 1406) return { status: 400, body: { error: 'One of the values is too long', code: 'VALIDATION_ERROR' } };
  if (['ER_TRUNCATED_WRONG_VALUE', 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD', 'ER_WARN_DATA_OUT_OF_RANGE', 'ER_DATA_OUT_OF_RANGE', 'ER_BAD_NULL_ERROR', 'ER_NO_DEFAULT_FOR_FIELD', 'ER_NO_REFERENCED_ROW_2', 'ER_ROW_IS_REFERENCED_2'].includes(err?.code)) {
    return { status: 400, body: { error: 'One of the values is invalid or refers to a record that does not exist', code: 'VALIDATION_ERROR' } };
  }
  if (TRANSIENT_DB_CODES.has(err?.code) || /queue limit reached/i.test(String(err?.message))) {
    return { status: 503, body: { error: 'The service is temporarily unavailable, please retry in a moment', code: 'SERVICE_BUSY' }, headers: { 'Retry-After': '2' } };
  }
  return { status: 500, body: { error: 'Internal server error', code: 'INTERNAL' } };
}

export function notFoundHandler(req, res) {
  res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
}

export function errorHandler({ logger }) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    const { status, body, headers } = describeError(err);
    if (status >= 500) logger.error('request failed', { requestId: req.id, method: req.method, path: req.path, err });
    if (res.headersSent) { res.destroy(); return; }
    if (headers) for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.status(status).json({ ...body, requestId: req.id });
  };
}

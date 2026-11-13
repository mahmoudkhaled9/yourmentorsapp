const pad = (n) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD HH:MM:SS' in UTC – the format written to TIMESTAMP/DATETIME columns. */
export const formatSqlDateTime = (d) =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;

export const nowSql = () => formatSqlDateTime(new Date());
export const todayUtc = () => new Date().toISOString().slice(0, 10);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const PLAIN_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/;

export function isRealDate(isoDate) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === isoDate;
}

/** Anything date-like -> 'YYYY-MM-DD HH:MM:SS' (UTC) or `fallback`. Honors explicit offsets. */
export function toSqlDateTime(value, fallback = nowSql()) {
  if (value === undefined || value === null || value === '') return fallback;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? fallback : formatSqlDateTime(value);
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return fallback;
    if (ISO_DATE.test(s)) return isRealDate(s) ? `${s} 00:00:00` : fallback;
    if (PLAIN_DATETIME.test(s)) return s.slice(0, 19);
    const parsed = new Date(s);
    return Number.isNaN(parsed.getTime()) ? fallback : formatSqlDateTime(parsed);
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : formatSqlDateTime(parsed);
}

/** Anything date-like -> 'YYYY-MM-DD' or `fallback`. */
export function toSqlDate(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? fallback : value.toISOString().slice(0, 10);
  const s = String(value).trim();
  if (!s) return fallback;
  if (ISO_DATE.test(s)) return isRealDate(s) ? s : fallback;
  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString().slice(0, 10);
}

/** DB value (Date | string) -> ISO-8601 string for the client ('' when empty). */
export function toIso(value) {
  if (!value) return '';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  const s = String(value);
  if (PLAIN_DATETIME.test(s)) return `${s.slice(0, 19).replace(' ', 'T')}.000Z`;
  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? s : parsed.toISOString();
}

/** DB value -> 'YYYY-MM-DD' for the client. Non-date legacy strings are returned untouched. */
export function toDateOnly(value) {
  if (!value) return '';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10);
  const s = String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
}

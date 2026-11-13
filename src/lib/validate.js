import { badRequest } from '../http/errors.js';
import { isRealDate, toSqlDateTime } from './dates.js';
import { normalizeClientPhone, normalizeEgyptianMobile } from './phone.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const EGYPT_MOBILE_MESSAGE = 'must be an Egyptian mobile number: 11 digits starting with 010, 011, 012 or 015';
export const CLIENT_PHONE_MESSAGE = 'must be an Egyptian mobile (010/011/012/015 + 8 digits) or an international number starting with +';

/**
 * Collects every problem in a request instead of failing on the first one.
 *   const v = new Validator(); const name = v.string(body.name, 'name', { required: true }); v.assert();
 * Every method returns undefined for "not provided".
 */
export class Validator {
  constructor() { this.errors = []; }

  fail(field, message) { this.errors.push({ field, message }); return undefined; }

  assert() {
    if (this.errors.length) throw badRequest(this.errors.map((e) => `${e.field}: ${e.message}`).join('; '), this.errors);
  }

  string(value, field, { required = false, min = 0, max = 255, trim = true } = {}) {
    if (value === undefined || value === null) return required ? this.fail(field, 'is required') : undefined;
    if (typeof value !== 'string' && typeof value !== 'number') return this.fail(field, 'must be text');
    const s = trim ? String(value).trim() : String(value);
    if (required && !s) return this.fail(field, 'is required');
    if (s.length < min) return this.fail(field, `must be at least ${min} characters`);
    if (s.length > max) return this.fail(field, `must be at most ${max} characters`);
    return s;
  }

  email(value, field, { required = false } = {}) {
    const s = this.string(value, field, { required, max: 255 });
    if (s === undefined || s === '') return s;
    if (!EMAIL.test(s)) return this.fail(field, 'is not a valid email address');
    return s.toLowerCase();
  }

  /** Employee phone. `keep`: the stored value, accepted unchanged even if it predates the rule (legacy data). */
  egyptianMobile(value, field, { required = false, keep } = {}) {
    const s = this.string(value, field, { required, max: 50 });
    if (s === undefined) return undefined;
    if (s === '') return required ? this.fail(field, 'is required') : '';
    if (keep !== undefined && keep !== null && s === String(keep)) return s;
    return normalizeEgyptianMobile(s) ?? this.fail(field, EGYPT_MOBILE_MESSAGE);
  }

  /** Client phone (leads, cold calls, deals). */
  clientPhone(value, field, { required = false, keep } = {}) {
    const s = this.string(value, field, { required, max: 50 });
    if (s === undefined) return undefined;
    if (s === '') return required ? this.fail(field, 'is required') : '';
    if (keep !== undefined && keep !== null && s === String(keep)) return s;
    return normalizeClientPhone(s) ?? this.fail(field, CLIENT_PHONE_MESSAGE);
  }

  int(value, field, { required = false, min = -2147483648, max = 2147483647 } = {}) {
    if (value === undefined || value === null || value === '') return required ? this.fail(field, 'is required') : undefined;
    const n = typeof value === 'number' ? value : /^-?\d+$/.test(String(value).trim()) ? Number(value) : NaN;
    if (!Number.isInteger(n)) return this.fail(field, 'must be a whole number');
    if (n < min || n > max) return this.fail(field, `must be between ${min} and ${max}`);
    return n;
  }

  money(value, field, { required = false, max = 9999999999.99 } = {}) {
    if (value === undefined || value === null || value === '') return required ? this.fail(field, 'is required') : undefined;
    const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.replace(/,/g, '').trim()) : NaN;
    if (!Number.isFinite(n)) return this.fail(field, 'must be a number');
    if (n < 0) return this.fail(field, 'must not be negative');
    if (n > max) return this.fail(field, 'is too large');
    return Math.round(n * 100) / 100;
  }

  bool(value) {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value === 'boolean') return value;
    if (value === 1 || value === '1' || value === 'true') return true;
    if (value === 0 || value === '0' || value === 'false') return false;
    return undefined;
  }

  date(value, field, { required = false } = {}) {
    if (value === undefined || value === null || value === '') return required ? this.fail(field, 'is required') : undefined;
    if (typeof value !== 'string') return this.fail(field, 'is not a valid date');
    const s = value.trim();
    const day = /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
    if (day) return isRealDate(day) ? day : this.fail(field, 'is not a valid date');
    const parsed = new Date(s);
    if (Number.isNaN(parsed.getTime())) return this.fail(field, 'is not a valid date');
    return parsed.toISOString().slice(0, 10);
  }

  /** 'YYYY-MM-DD HH:MM:SS' (UTC) for TIMESTAMP columns, from an ISO string. */
  datetime(value, field, { required = false } = {}) {
    if (value === undefined || value === null || value === '') return required ? this.fail(field, 'is required') : undefined;
    if (typeof value !== 'string') return this.fail(field, 'is not a valid date/time');
    const out = toSqlDateTime(value, null);
    return out === null ? this.fail(field, 'is not a valid date/time') : out;
  }

  oneOf(value, field, allowed, { required = false } = {}) {
    if (value === undefined || value === null || value === '') return required ? this.fail(field, 'is required') : undefined;
    const s = String(value).toLowerCase();
    return allowed.includes(s) ? s : this.fail(field, `must be one of: ${allowed.join(', ')}`);
  }

  intList(value, field, { min = 1, max = 500 } = {}) {
    if (!Array.isArray(value)) return this.fail(field, 'must be a list of ids');
    const out = [];
    for (const item of value) {
      const n = typeof item === 'number' ? item : /^\d+$/.test(String(item)) ? Number(item) : NaN;
      if (!Number.isInteger(n) || n <= 0 || n > 2147483647) return this.fail(field, 'must only contain positive whole numbers');
      out.push(n);
    }
    const unique = [...new Set(out)];
    if (unique.length < min) return this.fail(field, `must contain at least ${min} id`);
    if (unique.length > max) return this.fail(field, `must contain at most ${max} ids`);
    return unique;
  }
}

/** Request bodies must be plain objects; anything else is treated as empty. */
export const bodyOf = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});

/** Route parameter -> positive integer id (400 otherwise). */
export function parseId(raw, name = 'id') {
  const s = String(raw ?? '');
  const n = /^\d{1,10}$/.test(s) ? Number(s) : NaN;
  if (!Number.isInteger(n) || n <= 0 || n > 2147483647) throw badRequest(`Invalid ${name}`);
  return n;
}

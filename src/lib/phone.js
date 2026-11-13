/**
 * Phone rules (the same rules live in the frontend at mentorsfront/src/lib/phone.ts):
 *  - Egyptian mobile: 11 digits, prefix 010 / 011 / 012 / 015. Accepted spellings: "01012345678", "010 1234 5678",
 *    "+201012345678", "00201012345678", "201012345678". Always stored as "01012345678".
 *  - International (clients abroad): "+" followed by 8-15 digits, not +20. Stored as "+<digits>".
 */
export const EGYPT_MOBILE = /^01[0125]\d{8}$/;

export function normalizeEgyptianMobile(raw, { allowMissingZero = false } = {}) {
  if (raw === undefined || raw === null) return null;
  let d = String(raw).trim();
  if (!/^[+\d\s().\-/]+$/.test(d)) return null;
  const plus = d.startsWith('+');
  d = d.replace(/\D/g, '');
  if (d.startsWith('0020')) d = `0${d.slice(4)}`;
  else if (d.startsWith('20') && d.length === 12) d = `0${d.slice(2)}`;
  else if (plus) return null; // "+" but not +20 is not an Egyptian number
  if (allowMissingZero && /^1[0125]\d{8}$/.test(d)) d = `0${d}`; // spreadsheets drop the leading zero
  return EGYPT_MOBILE.test(d) ? d : null;
}

export function normalizeInternational(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (!/^(\+|00)[\d\s().\-/]+$/.test(s)) return null;
  const d = s.replace(/\D/g, '').replace(/^00/, '');
  if (d.startsWith('20')) return null; // Egyptian numbers must use the Egyptian rules above
  return d.length >= 8 && d.length <= 15 ? `+${d}` : null;
}

/** Client phone: Egyptian mobile or international. */
export const normalizeClientPhone = (raw, opts) => normalizeEgyptianMobile(raw, opts) ?? normalizeInternational(raw);

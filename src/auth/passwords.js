import bcrypt from 'bcryptjs';

export const isBcryptHash = (value) => typeof value === 'string' && /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(value);

/** Passwords that must never be accepted (the old defaults of this project plus very common ones). */
export const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', '1234567890', 'qwerty123', 'qwertyuiop',
  'iloveyou', 'admin123', 'admin1234', 'letmein123', 'welcome123', 'mentors123', 'mentors123!', 'mentors@123',
  'changeme', 'changeme123', 'abc12345', 'test1234',
]);
export const isCommonPassword = (plain) => COMMON_PASSWORDS.has(String(plain).trim().toLowerCase());

/** Returns an error message, or null when the password is acceptable. */
export function checkPasswordStrength(plain, { email, name } = {}) {
  const pw = String(plain ?? '');
  if (pw.length < 8) return 'Password must be at least 8 characters';
  if (Buffer.byteLength(pw, 'utf8') > 72) return 'Password must be at most 72 bytes';
  if (!pw.trim()) return 'Password cannot be blank';
  if (isCommonPassword(pw)) return 'This password is too common, choose a different one';
  const lower = pw.toLowerCase();
  if (email && lower === String(email).toLowerCase()) return 'Password must not be the same as the email';
  if (name && lower === String(name).toLowerCase()) return 'Password must not be the same as the name';
  if (/^(.)\1+$/.test(pw)) return 'Password is too simple';
  return null;
}

export function createPasswordService({ rounds = 10 } = {}) {
  // Verifying against this when the user does not exist keeps response time similar (no user enumeration by timing).
  const dummyHash = bcrypt.hashSync('timing-equaliser-not-a-real-password', rounds);
  return {
    hash: (plain) => bcrypt.hash(String(plain ?? ''), rounds),
    /** bcrypt only: plain-text values in the DB are never accepted (migration 004 hashes any that existed). */
    async verify(plain, stored) {
      if (!isBcryptHash(stored)) {
        await bcrypt.compare(String(plain ?? ''), dummyHash);
        return false;
      }
      try { return await bcrypt.compare(String(plain ?? ''), stored); } catch { return false; }
    },
    dummyHash,
  };
}

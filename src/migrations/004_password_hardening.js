import { loadColumnTypes } from './helpers.js';
import { isBcryptHash, isCommonPassword } from '../auth/passwords.js';

export const id = '004_password_hardening';
export const critical = true;

/**
 * 1. adds users.password_changed_at (a password change invalidates older sessions);
 * 2. hashes any password still stored in clear text (the old code stored the literal default 'password' for users
 *    created without one and accepted plain text at login). Nobody is locked out: the same password keeps working.
 */
export async function up({ db, logger, passwords }) {
  if (!(await loadColumnTypes(db)).get('users')?.has('password_changed_at')) {
    await db.exec('ALTER TABLE `users` ADD COLUMN `password_changed_at` TIMESTAMP NULL');
  }
  const rows = await db.rows("SELECT id, password FROM users WHERE password IS NOT NULL AND password <> ''");
  let hashed = 0;
  let weak = 0;
  for (const row of rows) {
    if (isBcryptHash(row.password)) continue;
    if (isCommonPassword(row.password)) weak += 1;
    await db.exec('UPDATE users SET password = ? WHERE id = ? AND password = ?', [await passwords.hash(row.password), row.id, row.password]);
    hashed += 1;
  }
  if (hashed) logger.warn(`password hardening: ${hashed} plain-text password(s) were hashed`);
  if (weak) logger.warn(`SECURITY: ${weak} account(s) use a well-known default password (e.g. "password"). Ask those users to change it.`);
}

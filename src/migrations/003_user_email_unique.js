import { loadIndexNames } from './helpers.js';

export const id = '003_user_email_unique';
export const critical = false;

/**
 * users.email was not unique, so two accounts could share a login. Adds a UNIQUE index when the data allows it.
 * If duplicates exist nothing is changed: a plain index is added, the duplicate ids are logged, and the migration is
 * retried on the next start (after an administrator resolved them).
 */
export async function up({ db, logger }) {
  const names = (await loadIndexNames(db)).get('users') ?? new Set();
  if (names.has('uq_users_email')) return undefined;
  const dupes = await db.rows('SELECT LOWER(email) AS email, COUNT(*) AS cnt FROM users GROUP BY LOWER(email) HAVING COUNT(*) > 1');
  if (dupes.length) {
    const groups = [];
    for (const d of dupes.slice(0, 20)) groups.push((await db.rows('SELECT id FROM users WHERE LOWER(email) = ? ORDER BY id', [d.email])).map((r) => r.id));
    logger.warn('users.email has duplicates; the unique index was NOT created. Resolve these user id groups:', { groups });
    if (!names.has('idx_users_email')) await db.exec('CREATE INDEX `idx_users_email` ON `users` (`email`)');
    return { skipped: true, reason: `${dupes.length} duplicate email group(s)` };
  }
  await db.exec('CREATE UNIQUE INDEX `uq_users_email` ON `users` (`email`)');
  return undefined;
}

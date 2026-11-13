import fs from 'node:fs/promises';

export const id = '000_base_schema';
export const critical = true;

/**
 * Bootstraps an EMPTY database from schema.sql. Every statement is CREATE TABLE IF NOT EXISTS, so on an existing
 * database this changes nothing. (Lets a new developer / CI run the app against a blank MySQL schema.)
 */
export async function up({ db }) {
  const text = await fs.readFile(new URL('../../schema.sql', import.meta.url), 'utf8');
  const statements = text.replace(/--.*$/gm, '').split(/;\s*(?:\r?\n|$)/).map((s) => s.trim()).filter((s) => /^CREATE\s+TABLE/i.test(s));
  for (const sql of statements) await db.exec(sql);
}

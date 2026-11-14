import { loadColumnTypes } from './helpers.js';

export const id = '007_project_details';
export const critical = false;

/**
 * Project details shown on the developer page (location, starting price, down payment, description). The production
 * database already has these columns (camelCase, from the original app); a database built from schema.sql did not, so
 * the admin form could not save them. Additive and idempotent: only missing columns are added, nothing is changed or
 * dropped. Rollback (manual, only if needed): ALTER TABLE projects DROP COLUMN ... for the columns this added.
 */
const COLUMNS = [
  ['location', 'VARCHAR(255) NULL'],
  ['startingPrice', 'DECIMAL(18,2) NULL'],
  ['downPayment', 'VARCHAR(255) NULL'],
  ['description', 'TEXT NULL'],
];

export async function up({ db }) {
  const existing = (await loadColumnTypes(db)).get('projects');
  if (!existing) return { skipped: true, reason: 'projects table not found' };
  for (const [name, type] of COLUMNS) {
    if (!existing.has(name.toLowerCase())) await db.exec(`ALTER TABLE \`projects\` ADD COLUMN \`${name}\` ${type}`);
  }
  return undefined;
}

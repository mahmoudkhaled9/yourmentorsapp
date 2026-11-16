import fs from 'node:fs/promises';
import { loadIndexNames } from './helpers.js';

export const id = '010_number_pool';
export const critical = true;

/**
 * Number Pool: pool_imports, pool_batches, pool_numbers, pool_batch_items (definitions in schema.sql, the single source
 * of the table layout), plus the indexes the ownership / reporting queries use. Additive and idempotent: it creates new
 * tables only and never touches existing ones. Rollback (manual, only if needed, after a backup):
 *   DROP TABLE pool_batch_items, pool_numbers, pool_batches, pool_imports; DELETE FROM schema_migrations WHERE id = '010_number_pool';
 */
const TABLES = ['pool_imports', 'pool_batches', 'pool_numbers', 'pool_batch_items'];
const INDEXES = [
  ['pool_numbers', 'idx_pool_numbers_status', ['status', 'id']],
  ['pool_numbers', 'idx_pool_numbers_owner', ['user_id', 'status']],
  ['pool_numbers', 'idx_pool_numbers_batch', ['batch_id']],
  ['pool_batches', 'idx_pool_batches_owner', ['user_id', 'status']],
  ['pool_batches', 'idx_pool_batches_created', ['created_at']],
  ['pool_batch_items', 'idx_pool_items_owner', ['user_id', 'allocated_at']],
  ['pool_batch_items', 'idx_pool_items_number', ['pool_number_id']],
  ['pool_batch_items', 'idx_pool_items_open', ['batch_id', 'ended_at']],
];

export async function poolTableStatements() {
  const text = await fs.readFile(new URL('../../schema.sql', import.meta.url), 'utf8');
  const statements = text.replace(/--.*$/gm, '').split(/;\s*(?:\r?\n|$)/).map((s) => s.trim());
  return TABLES.map((t) => {
    const sql = statements.find((s) => new RegExp(`^CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+\`?${t}\`?\\s*\\(`, 'i').test(s));
    if (!sql) throw new Error(`schema.sql has no CREATE TABLE for ${t}`);
    return sql;
  });
}

export async function up({ db }) {
  for (const sql of await poolTableStatements()) await db.exec(sql); // in dependency order (TABLES)
  const indexes = await loadIndexNames(db);
  for (const [table, name, cols] of INDEXES) {
    if (indexes.get(table)?.has(name)) continue;
    await db.exec(`CREATE INDEX \`${name}\` ON \`${table}\` (${cols.map((c) => `\`${c}\``).join(', ')})`);
  }
  return undefined;
}

export const id = '009_safe_foreign_keys';
export const critical = false;

/**
 * A database built from scratch (schema.sql, i.e. every NEW installation, production included) had foreign keys that
 * silently deleted history in MySQL:
 *   comments.lead_id / comments.cold_call_id ON DELETE CASCADE  -> deleting a lead / cold call deleted its comments
 *   comments.user_id ON DELETE CASCADE                           -> deleting a user deleted every comment they wrote
 *   cold_calls.status_id ON DELETE CASCADE                       -> deleting a status would delete its cold calls
 * The business rule is the opposite (history is kept; an in-use status cannot be deleted). The older production
 * layout has no such keys, so nobody noticed. This replaces exactly those keys with ON DELETE SET NULL (RESTRICT for
 * the status). It changes no data. Idempotent: keys that are already safe, or absent, are left alone; on a database
 * without foreign-key metadata (the SQLite test stand-in) it does nothing.
 * Rollback (not recommended): re-create the keys with ON DELETE CASCADE.
 */
const FIXES = [
  { table: 'comments', column: 'lead_id', parent: 'leads', rule: 'SET NULL' },
  { table: 'comments', column: 'cold_call_id', parent: 'cold_calls', rule: 'SET NULL' },
  { table: 'comments', column: 'user_id', parent: 'users', rule: 'SET NULL', nullable: 'INT NULL' },
  { table: 'cold_calls', column: 'status_id', parent: 'statuses', rule: 'RESTRICT' },
];

export async function up({ db, logger }) {
  let keys;
  try {
    keys = await db.rows(
      `SELECT k.TABLE_NAME AS tableName, k.COLUMN_NAME AS columnName, k.CONSTRAINT_NAME AS name, r.DELETE_RULE AS deleteRule
         FROM information_schema.KEY_COLUMN_USAGE k
         JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
        WHERE k.TABLE_SCHEMA = DATABASE() AND k.REFERENCED_TABLE_NAME IS NOT NULL`,
    );
  } catch {
    return undefined; // no foreign-key metadata (SQLite stand-in): nothing to repair
  }
  for (const fix of FIXES) {
    const key = keys.find((k) => String(k.tableName).toLowerCase() === fix.table && String(k.columnName).toLowerCase() === fix.column);
    if (!key || String(key.deleteRule).toUpperCase() !== 'CASCADE') continue;
    await db.exec(`ALTER TABLE \`${fix.table}\` DROP FOREIGN KEY \`${key.name}\``);
    if (fix.nullable) await db.exec(`ALTER TABLE \`${fix.table}\` MODIFY \`${fix.column}\` ${fix.nullable}`);
    await db.exec(`ALTER TABLE \`${fix.table}\` ADD CONSTRAINT \`${key.name}\` FOREIGN KEY (\`${fix.column}\`) REFERENCES \`${fix.parent}\`(id) ON DELETE ${fix.rule}`);
    logger?.info?.(`foreign key ${fix.table}.${fix.column}: ON DELETE CASCADE -> ${fix.rule}`);
  }
  return undefined;
}

/**
 * Cache of which columns really exist.  The production database carries many legacy/duplicate columns
 * (statusId + status_id, ...) and deployments differ, so every INSERT/UPDATE is filtered through this.
 */
export async function loadSchema(db) {
  const rows = await db.rows(
    'SELECT table_name AS tableName, column_name AS columnName, data_type AS dataType FROM information_schema.columns WHERE table_schema = DATABASE()'
  );
  const tables = new Map();
  for (const r of rows) {
    const t = String(r.tableName).toLowerCase();
    if (!tables.has(t)) tables.set(t, new Map());
    tables.get(t).set(String(r.columnName).toLowerCase(), String(r.dataType).toLowerCase());
  }
  const has = (table, column) => tables.get(String(table).toLowerCase())?.has(String(column).toLowerCase()) ?? false;
  return {
    hasTable: (table) => tables.has(String(table).toLowerCase()),
    has,
    only: (table, row) => Object.fromEntries(Object.entries(row).filter(([column]) => has(table, column))),
    pick: (table, columns) => columns.filter((c) => has(table, c)),
    /** COALESCE over whichever of the candidate columns exist: coalesce('leads', ['status_id','statusId']). */
    coalesce(table, columns, alias = table) {
      const present = columns.filter((c) => has(table, c)).map((c) => `${alias}.${c}`);
      if (!present.length) return 'NULL';
      return present.length === 1 ? present[0] : `COALESCE(${present.join(', ')})`;
    },
  };
}

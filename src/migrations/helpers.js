/** Map<table(lowercase), Map<column(lowercase), dataType>> for the current database. */
export async function loadColumnTypes(db) {
  const rows = await db.rows('SELECT table_name AS tableName, column_name AS columnName, data_type AS dataType FROM information_schema.columns WHERE table_schema = DATABASE()');
  const tables = new Map();
  for (const r of rows) {
    const t = String(r.tableName).toLowerCase();
    if (!tables.has(t)) tables.set(t, new Map());
    tables.get(t).set(String(r.columnName).toLowerCase(), String(r.dataType).toLowerCase());
  }
  return tables;
}

/** Map<table(lowercase), Set<indexName(lowercase)>>. */
export async function loadIndexNames(db) {
  const rows = await db.rows('SELECT table_name AS tableName, index_name AS indexName FROM information_schema.statistics WHERE table_schema = DATABASE()');
  const tables = new Map();
  for (const r of rows) {
    const t = String(r.tableName).toLowerCase();
    if (!tables.has(t)) tables.set(t, new Set());
    tables.get(t).add(String(r.indexName).toLowerCase());
  }
  return tables;
}

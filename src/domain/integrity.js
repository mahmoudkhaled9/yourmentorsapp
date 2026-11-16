/**
 * Read-only relationship checks (the database declares only a few foreign keys; the application enforces the rest).
 * Used by scripts/db-audit.mjs and by the tests that prove a fresh database + seed has no orphans.
 *
 * Every column variant that exists is checked separately (the legacy layout carries both `developerId` and
 * `developer_id`; they must each point at a real row). 0 and NULL mean "none".
 */
export const RELATIONS = [
  // [child table, candidate columns, parent table, kind]
  ['leads', ['user_id', 'assignedToId'], 'users'],
  ['leads', ['status_id', 'statusId'], 'statuses'],
  ['leads', ['project_id', 'projectId'], 'projects'],
  ['leads', ['source_id', 'sourceId'], 'sources'],
  ['cold_calls', ['user_id'], 'users'],
  ['cold_calls', ['status_id'], 'statuses'],
  ['cold_calls', ['project_id'], 'projects'],
  ['call_history', ['lead_id'], 'leads'],
  ['call_history', ['cold_call_id'], 'cold_calls'],
  ['call_history', ['user_id'], 'users'],
  ['call_history', ['status_id'], 'statuses'],
  ['call_history', ['comment_id'], 'comments'],
  ['calendar_events', ['lead_id'], 'leads'],
  ['lead_requirements', ['lead_id'], 'leads'],
  ['lead_requirement_destinations', ['lead_id'], 'leads'],
  ['lead_requirement_destinations', ['destination_id'], 'destinations'],
  ['lead_requirement_property_types', ['lead_id'], 'leads'],
  ['lead_requirement_property_types', ['property_type_id'], 'property_types'],
  ['projects', ['developer_id', 'developerId'], 'developers'],
  ['projects', ['destination_id'], 'destinations'],
  ['brokers', ['developer_id'], 'developers'],
  ['deals', ['project_id', 'projectId'], 'projects'],
  ['deals', ['developer_id', 'developerId'], 'developers'],
  ['deals', ['user_id', 'agentId'], 'users'],
  ['users', ['parent_id'], 'users'],
  ['pool_numbers', ['import_id'], 'pool_imports'],
  ['pool_numbers', ['user_id'], 'users'],
  ['pool_numbers', ['batch_id'], 'pool_batches'],
  ['pool_batches', ['user_id'], 'users'],
  ['pool_batch_items', ['batch_id'], 'pool_batches'],
  ['pool_batch_items', ['pool_number_id'], 'pool_numbers'],
  ['pool_batch_items', ['user_id'], 'users'],
  ['jobtitles', ['department_id'], 'departments'],
  ['reports', ['comment_id'], 'comments'],
  // By design (no silent data loss): deleting a lead or cold call keeps its comment history. Reported as a note.
  ['comments', ['lead_id'], 'leads', 'kept-history'],
  // a lead / cold call created from a pool number may be deleted later; the pool history keeps the reference
  ['pool_batch_items', ['lead_id'], 'leads', 'kept-history'],
  ['pool_batch_items', ['cold_call_id'], 'cold_calls', 'kept-history'],
  ['comments', ['cold_call_id'], 'cold_calls', 'kept-history'],
];

/** Returns { problems: [{ relation, count, ids }], notes: [...] }. Only SELECTs. */
export async function findOrphans(db, schema) {
  const problems = [];
  const notes = [];
  for (const [table, columns, parent, kind] of RELATIONS) {
    if (!schema.hasTable(table) || !schema.hasTable(parent)) continue;
    for (const column of columns.filter((c) => schema.has(table, c))) {
      const key = schema.has(table, 'id') ? 'id' : column; // lead_requirements is keyed by lead_id
      const rows = await db.rows(
        `SELECT c.\`${key}\` AS id FROM \`${table}\` c LEFT JOIN \`${parent}\` p ON p.id = c.\`${column}\`
          WHERE c.\`${column}\` IS NOT NULL AND c.\`${column}\` <> 0 AND p.id IS NULL ORDER BY c.\`${key}\` LIMIT 1000`,
      );
      if (!rows.length) continue;
      const entry = { relation: `${table}.${column} -> ${parent}`, count: rows.length, ids: rows.map((r) => Number(r.id)) };
      (kind === 'kept-history' ? notes : problems).push(entry);
    }
  }
  return { problems, notes };
}

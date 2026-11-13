import { loadColumnTypes, loadIndexNames } from './helpers.js';

export const id = '002_indexes';
export const critical = false;

/**
 * The production tables had NO secondary indexes, so every scoped list query was a full scan. Each index is created only
 * if its table and columns exist and no index of that name exists. Additive, idempotent, never touches data.
 */
export const INDEXES = [
  ['leads', 'idx_leads_user_id', ['user_id']], ['leads', 'idx_leads_status_id', ['status_id']], ['leads', 'idx_leads_project_id', ['project_id']],
  ['leads', 'idx_leads_source_id', ['source_id']], ['leads', 'idx_leads_created_at', ['created_at']], ['leads', 'idx_leads_phone', ['phone']],
  ['cold_calls', 'idx_cold_calls_phone', ['phone']], ['cold_calls', 'idx_cold_calls_created_at', ['created_at']], ['cold_calls', 'idx_cold_calls_user_id', ['user_id']],
  ['comments', 'idx_comments_user_id', ['user_id']], ['comments', 'idx_comments_lead_id', ['lead_id']], ['comments', 'idx_comments_cold_call_id', ['cold_call_id']],
  ['comments', 'idx_comments_entity', ['entity_type', 'entity_id']],
  ['deals', 'idx_deals_user_id', ['user_id']], ['deals', 'idx_deals_project_id', ['project_id']], ['deals', 'idx_deals_created_at', ['created_at']],
  ['reports', 'idx_reports_agent_id', ['agent_id']], ['reports', 'idx_reports_team_leader_id', ['team_leader_id']], ['reports', 'idx_reports_entity', ['entity_type', 'entity_id']],
  ['reports', 'idx_reports_created_at', ['created_at']], ['users', 'idx_users_parent_id', ['parent_id']],
  ['activity_logs', 'idx_activity_logs_created_at', ['created_at']], ['activity_logs', 'idx_activity_logs_user_id', ['user_id']],
  ['tasks', 'idx_tasks_assigned_to_id', ['assigned_to_id']], ['calendar_events', 'idx_calendar_events_user_id', ['user_id']],
  ['call_history', 'idx_call_history_user_id', ['user_id']], ['notifications', 'idx_notifications_user_id', ['user_id', 'is_read']],
  ['pipeline', 'idx_pipeline_owner_id', ['owner_id']],
];

export async function up({ db, logger }) {
  const columns = await loadColumnTypes(db);
  const indexes = await loadIndexNames(db);
  let created = 0;
  for (const [table, name, cols] of INDEXES) {
    const tableColumns = columns.get(table);
    if (!tableColumns || !cols.every((c) => tableColumns.has(c)) || indexes.get(table)?.has(name)) continue;
    try {
      await db.exec(`CREATE INDEX \`${name}\` ON \`${table}\` (${cols.map((c) => `\`${c}\``).join(', ')})`);
      created += 1;
    } catch (err) {
      logger.warn(`could not create index ${name}: ${err.message}`);
    }
  }
  if (created) logger.info(`indexes: created ${created}`);
}

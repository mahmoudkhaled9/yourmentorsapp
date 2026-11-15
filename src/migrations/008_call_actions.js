import { loadColumnTypes, loadIndexNames } from './helpers.js';

export const id = '008_call_actions';
export const critical = true;

/**
 * Call actions: every logged call is a row of the EXISTING call_history table (no second storage). Adds what a call
 * action records: the lead status chosen during the call, Delivery / Finishing / Purpose of purchase, the follow-up, the
 * comment it created for Reports, and a client request id so a re-sent Save never creates a second call.
 * Additive and idempotent; existing rows are untouched (their new columns stay NULL and are shown as "not recorded").
 * Rollback (manual, only if needed): ALTER TABLE call_history DROP COLUMN ... for the columns below, DROP INDEX ...
 */
const COLUMNS = [
  ['status_id', 'INT NULL'],
  ['status_name', 'VARCHAR(100) NULL'],
  ['delivery', 'VARCHAR(30) NULL'],
  ['finishing', 'VARCHAR(30) NULL'],
  ['purpose', 'VARCHAR(30) NULL'],
  ['follow_up_at', 'TIMESTAMP NULL'],
  ['follow_up_event_id', 'INT NULL'],
  ['comment_id', 'INT NULL'],
  ['request_id', 'VARCHAR(64) NULL'],
];
const INDEXES = [
  ['idx_call_history_lead', 'INDEX', ['lead_id']],
  ['idx_call_history_cold_call', 'INDEX', ['cold_call_id']],
  ['uq_call_history_request', 'UNIQUE INDEX', ['user_id', 'request_id']],
];

export async function up({ db }) {
  const columns = (await loadColumnTypes(db)).get('call_history');
  if (!columns) {
    await db.exec(`CREATE TABLE IF NOT EXISTS call_history (
      id INT PRIMARY KEY AUTO_INCREMENT, lead_id INT NULL, cold_call_id INT NULL, user_id INT NULL, result VARCHAR(100) NULL,
      notes TEXT NULL, call_at TIMESTAMP NULL, created_at TIMESTAMP NULL, updated_at TIMESTAMP NULL
    )`);
  }
  const existing = (await loadColumnTypes(db)).get('call_history');
  for (const [name, type] of COLUMNS) {
    if (!existing.has(name)) await db.exec(`ALTER TABLE \`call_history\` ADD COLUMN \`${name}\` ${type}`);
  }
  const indexes = (await loadIndexNames(db)).get('call_history') ?? new Set();
  for (const [name, kind, cols] of INDEXES) {
    if (!indexes.has(name)) await db.exec(`CREATE ${kind} \`${name}\` ON \`call_history\` (${cols.map((c) => `\`${c}\``).join(', ')})`);
  }
  return undefined;
}

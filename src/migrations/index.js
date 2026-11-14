import * as base from './000_base_schema.js';
import * as legacy from './001_legacy_schema.js';
import * as indexes from './002_indexes.js';
import * as emailUnique from './003_user_email_unique.js';
import * as passwords from './004_password_hardening.js';
import * as sequences from './005_id_sequences.js';
import * as requirements from './006_crm_requirements.js';
import * as projectDetails from './007_project_details.js';
import { nowSql } from '../lib/dates.js';

export const MIGRATIONS = [base, legacy, indexes, emailUnique, passwords, sequences, requirements, projectDetails];
const LOCK = 'mentors_crm_migrations';

/**
 * Runs pending migrations under a MySQL advisory lock (safe when several instances boot together). Applied ids are
 * recorded in schema_migrations. A failing non-critical migration is logged and retried next start; a critical one aborts.
 */
export async function runMigrations(ctx) {
  const { db, logger } = ctx;
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id VARCHAR(100) NOT NULL PRIMARY KEY, applied_at TIMESTAMP NULL)');
  const conn = await db.pool.getConnection();
  try {
    const [[lock]] = await conn.query('SELECT GET_LOCK(?, 60) AS l', [LOCK]);
    if (!lock || Number(lock.l) !== 1) throw new Error('could not obtain the migration lock');
    const applied = new Set((await db.rows('SELECT id FROM schema_migrations')).map((r) => r.id));
    for (const m of MIGRATIONS) {
      if (applied.has(m.id)) continue;
      try {
        const result = await m.up(ctx);
        if (result?.skipped) { logger.warn(`migration ${m.id} skipped: ${result.reason}`); continue; }
        await db.exec('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)', [m.id, nowSql()]);
        logger.info(`migration applied: ${m.id}`);
      } catch (err) {
        if (m.critical) { err.message = `migration ${m.id} failed: ${err.message}`; throw err; }
        logger.error(`migration ${m.id} failed; it will be retried on the next start`, { err });
      }
    }
  } finally {
    try { await conn.query('SELECT RELEASE_LOCK(?) AS l', [LOCK]); } catch { /* closing anyway */ }
    conn.release();
  }
}

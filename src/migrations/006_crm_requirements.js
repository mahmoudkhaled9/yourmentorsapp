import { loadColumnTypes } from './helpers.js';
import { nowSql } from '../lib/dates.js';

export const id = '006_crm_requirements';
export const critical = true;

export const DEFAULT_DESTINATIONS = ['New Cairo', 'New Capital', 'West Cairo', 'El Gouna', 'North Coast', 'Ain Sokhna'];
export const DEFAULT_PROPERTY_TYPES = ['Studio', '1 Bedroom', '2 Bedrooms', '3 Bedrooms', 'Duplex', 'Townhouse', 'Twin House', 'Standalone', 'One-story property'];

/**
 * Client requirements: admin-managed destinations and property types, one requirements row per lead, and two link
 * tables (a client can want several destinations / unit types). Plus projects.destination_id. Additive and idempotent;
 * the default lists are inserted only into EMPTY tables, so an administrator's edits are never overwritten.
 * Rollback (manual, only if needed): DROP TABLE lead_requirement_property_types, lead_requirement_destinations,
 * lead_requirements, property_types, destinations; ALTER TABLE projects DROP COLUMN destination_id.
 */
export async function up({ db }) {
  const list = (name) => `CREATE TABLE IF NOT EXISTS ${name} (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      sort_order INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP NULL,
      updated_at TIMESTAMP NULL,
      UNIQUE KEY uq_${name}_name (name)
    )`;
  await db.exec(list('destinations'));
  await db.exec(list('property_types'));
  await db.exec(`CREATE TABLE IF NOT EXISTS lead_requirements (
      lead_id INT NOT NULL PRIMARY KEY,
      budget_min DECIMAL(14,2) NULL,
      budget_max DECIMAL(14,2) NULL,
      delivery VARCHAR(30) NULL,
      finishing VARCHAR(30) NULL,
      down_payment DECIMAL(14,2) NULL,
      installment_quarterly DECIMAL(14,2) NULL,
      purpose VARCHAR(30) NULL,
      updated_at TIMESTAMP NULL
    )`);
  await db.exec(`CREATE TABLE IF NOT EXISTS lead_requirement_destinations (
      lead_id INT NOT NULL, destination_id INT NOT NULL,
      PRIMARY KEY (lead_id, destination_id), KEY idx_lrd_destination (destination_id)
    )`);
  await db.exec(`CREATE TABLE IF NOT EXISTS lead_requirement_property_types (
      lead_id INT NOT NULL, property_type_id INT NOT NULL,
      PRIMARY KEY (lead_id, property_type_id), KEY idx_lrp_type (property_type_id)
    )`);
  if (!(await loadColumnTypes(db)).get('projects')?.has('destination_id')) {
    await db.exec('ALTER TABLE `projects` ADD COLUMN `destination_id` INT NULL');
  }
  const now = nowSql();
  for (const [table, names] of [['destinations', DEFAULT_DESTINATIONS], ['property_types', DEFAULT_PROPERTY_TYPES]]) {
    if (Number((await db.one(`SELECT COUNT(*) AS cnt FROM ${table}`)).cnt) > 0) continue;
    for (const [i, name] of names.entries()) {
      await db.exec(`INSERT INTO ${table} (name, is_active, sort_order, created_at, updated_at) VALUES (?, 1, ?, ?, ?)`, [name, (i + 1) * 10, now, now]);
    }
  }
}

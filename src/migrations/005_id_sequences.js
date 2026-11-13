export const id = '005_id_sequences';
export const critical = true;

/**
 * Most production tables have a plain INT primary key (no AUTO_INCREMENT); the old code used MAX(id)+1, which hands out
 * the id of a just-deleted newest row again (and then old comments/reports attach to the new record). This counter
 * table makes ids monotonic. Purely additive: existing data is untouched; counters start at MAX(id)+1 on first use.
 */
export async function up({ db }) {
  await db.exec('CREATE TABLE IF NOT EXISTS id_sequences (table_name VARCHAR(64) NOT NULL PRIMARY KEY, next_id INT NOT NULL)');
}

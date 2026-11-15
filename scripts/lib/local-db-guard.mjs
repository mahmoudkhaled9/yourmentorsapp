// Guards for scripts that WRITE demo / repair data. They may only touch the local development database (or a temporary
// test database), never a remote or production one.
import { TEMP_NAME } from './qa-db.mjs';

export const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
export const DEV_DATABASE = 'mentors_crm';

/** Static check of the configuration. Throws with a clear message; never includes a password. */
export function assertLocalDevTarget(db, env = process.env) {
  if (String(env.NODE_ENV ?? '').toLowerCase() === 'production') throw new Error('refusing: NODE_ENV=production');
  if (!LOCAL_HOSTS.has(String(db.host ?? ''))) throw new Error(`refusing: DB_HOST "${db.host}" is not this machine (127.0.0.1)`);
  if (Number(db.port) !== 3306) throw new Error(`refusing: DB_PORT ${db.port} is not the local development port 3306`);
  if (db.database !== DEV_DATABASE && !TEMP_NAME.test(String(db.database ?? ''))) {
    throw new Error(`refusing: database "${db.database}" is neither the local development database "${DEV_DATABASE}" nor a temporary test database`);
  }
  return db;
}

/** Runtime check on an open connection: the server really is the local one, on 3306, inside the expected database. */
export async function assertConnectedTo(queryOne, expectedDatabase) {
  const row = await queryOne('SELECT DATABASE() AS db, @@port AS port');
  if (row.db !== expectedDatabase) throw new Error(`refusing: connected to "${row.db}", expected "${expectedDatabase}"`);
  if (Number(row.port) !== 3306) throw new Error(`refusing: the server reports port ${row.port}, expected 3306`);
}

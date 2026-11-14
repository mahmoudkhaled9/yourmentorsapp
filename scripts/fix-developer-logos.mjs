// Repairs the developer logos that were shipped mixed up (e.g. "Ora" showed the Al Ahly Sabbour file, "Hassan Allam"
// showed the Tatweer Misr logo). SAFE BY DEFAULT:
//   node scripts/fix-developer-logos.mjs            -> dry run: prints what would change, changes nothing
//   node scripts/fix-developer-logos.mjs --apply    -> updates only rows that still hold the exact wrong value
// A logo an administrator has changed since is never touched. Take a backup first (npm run backup).
import { readDbConfig } from '../src/config.js';
import { createMysqlPool, createDb } from '../src/db.js'; // also loads .env
import { fixDeveloperLogos } from '../src/domain/developerLogos.js';

const apply = process.argv.includes('--apply');
const dbConfig = readDbConfig(process.env);
if (!dbConfig.user || !dbConfig.database) {
  console.error('DB_USER and DB_NAME must be set (in .env or the environment).');
  process.exit(1);
}
const pool = createMysqlPool(dbConfig);
const db = createDb(pool);
try {
  const { planned, changed } = await fixDeveloperLogos(db, { apply, log: (line) => console.log(line) });
  console.log(apply ? `Done: ${changed} row(s) updated.` : `Dry run: ${planned} row(s) would change. Re-run with --apply to update them.`);
} finally {
  await db.close();
}

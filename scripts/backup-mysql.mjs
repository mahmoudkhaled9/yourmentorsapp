// PRODUCTION BACKUP (run daily from cron / a systemd timer, see DEPLOYMENT.md):
//   node scripts/backup-mysql.mjs
// Settings (.env or environment): DB_* (the application database), BACKUP_DIR (required; outside the code folder),
// BACKUP_RETENTION_DAYS (default 14). Uses mysqldump --single-transaction (consistent, no table locks while the CRM is
// in use), gzips, verifies the dump completed, writes it readable by the owner only, then deletes this script's own
// backups older than the retention. The password reaches mysqldump through the environment, never the command line.
// Exit 0 = backup written and verified.
import 'dotenv/config';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';

const db = process.env.DB_NAME;
const dir = process.env.BACKUP_DIR;
const keepDays = Number(process.env.BACKUP_RETENTION_DAYS ?? 14);
if (!db || !process.env.DB_USER) { console.error('DB_USER and DB_NAME must be set'); process.exit(2); }
if (!dir) { console.error('BACKUP_DIR must be set (a folder outside the application, e.g. /var/backups/mentors-crm)'); process.exit(2); }
if (!/^[\w$]+$/.test(db)) { console.error('unexpected DB_NAME'); process.exit(2); }
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
const file = path.join(dir, `${db}-${stamp}.sql.gz`);
const dump = spawn(process.env.MYSQLDUMP ?? 'mysqldump', [
  '-h', process.env.DB_HOST ?? '127.0.0.1', '-P', String(process.env.DB_PORT ?? 3306), '-u', process.env.DB_USER,
  '--single-transaction', '--quick', '--routines', '--triggers', '--no-tablespaces', '--set-gtid-purged=OFF', '--default-character-set=utf8mb4', db,
], { env: { ...process.env, MYSQL_PWD: process.env.DB_PASSWORD ?? '' }, stdio: ['ignore', 'pipe', 'pipe'] });
let stderr = '';
dump.stderr.on('data', (c) => { stderr += c; });
const exited = new Promise((resolve) => dump.on('close', resolve));
try {
  await pipeline(dump.stdout, zlib.createGzip({ level: 6 }), fs.createWriteStream(file, { mode: 0o600, flags: 'wx' }));
} catch (err) {
  console.error(`backup failed while writing: ${err.message}`);
  process.exit(1);
}
const code = await exited;
const relevant = stderr.split('\n').filter((l) => l.trim() && !/Using a password|masking polic/i.test(l));
const text = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
const tables = (text.match(/^CREATE TABLE /gm) ?? []).length;
if (code !== 0 || !/-- Dump completed/.test(text.slice(-200)) || !tables) {
  console.error(`backup FAILED (mysqldump exit ${code}${relevant.length ? `: ${relevant.join(' ').slice(0, 300)}` : ''}); incomplete file removed`);
  fs.rmSync(file, { force: true });
  process.exit(1);
}
console.log(`backup ok: ${file} (${tables} tables, ${(fs.statSync(file).size / 1024).toFixed(0)} kB compressed)`);

// retention: only files this script wrote for this database
const cutoff = Date.now() - keepDays * 86400000;
const mine = new RegExp(`^${db}-\\d{14}\\.sql\\.gz$`);
let removed = 0;
for (const f of fs.readdirSync(dir)) {
  const p = path.join(dir, f);
  if (mine.test(f) && p !== file && fs.statSync(p).mtimeMs < cutoff) { fs.rmSync(p); removed += 1; }
}
if (removed) console.log(`retention: removed ${removed} backup(s) older than ${keepDays} days`);

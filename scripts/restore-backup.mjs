// RESTORE a backup into the database in .env (DB_*). This REPLACES the tables in that database.
//   node scripts/restore-backup.mjs <file.sql | file.sql.gz> --confirm <DB_NAME>
// Both the file and the database name are required (there is no default file: a mistyped command must never restore
// an old dump over current data). Take a fresh backup of the target first (npm run backup:mysql).
import fs from 'node:fs';
import zlib from 'node:zlib';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--confirm');
const confirm = args.includes('--confirm') ? args[args.indexOf('--confirm') + 1] : undefined;
const target = process.env.DB_NAME;

if (!file || !fs.existsSync(file)) {
  console.error('usage: node scripts/restore-backup.mjs <backup.sql | backup.sql.gz> --confirm <DB_NAME>   (file not given or not found)');
  process.exit(2);
}
if (!target || confirm !== target) {
  console.error(`refusing: this replaces the tables of "${target ?? '(DB_NAME not set)'}" on ${process.env.DB_HOST ?? '127.0.0.1'}:${process.env.DB_PORT ?? 3306}. Repeat the database name after --confirm to proceed.`);
  process.exit(2);
}
const raw = fs.readFileSync(file);
const sql = file.endsWith('.gz') ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8');
if (!/-- Dump completed|INSERT INTO|CREATE TABLE/i.test(sql)) {
  console.error('refusing: the file does not look like a SQL dump');
  process.exit(2);
}
const connection = await mysql.createConnection({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  database: target, multipleStatements: true,
});
try {
  // A dump made with --databases switches to its own database name: make sure it only ever touches the confirmed one.
  const switches = [...sql.matchAll(/^\s*USE\s+`?([\w$]+)`?\s*;/gim)].map((m) => m[1]);
  if (switches.some((db) => db !== target)) throw new Error(`the dump switches to another database (${[...new Set(switches)].join(', ')}); restore it there or edit the USE line`);
  await connection.query(sql);
  console.log(`restored ${file} into ${target}`);
} catch (err) {
  console.error(`restore failed: ${err.code ?? err.message}`);
  process.exitCode = 1;
} finally {
  await connection.end();
}

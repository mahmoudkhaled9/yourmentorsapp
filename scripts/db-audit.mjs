// READ-ONLY integrity audit of the database in .env (DB_*):  npm run db:audit
// One connection, `START TRANSACTION READ ONLY` (MySQL refuses any write inside it), rolled back at the end. It does not
// boot the app (that would run migrations). Prints counts and row ids only: no names, phones, e-mails or hashes.
// Exit 0 = no problem found, 1 = problems, 2 = cannot connect / not configured.
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { readDbConfig } from '../src/config.js';
import { loadSchema } from '../src/schema.js';
import { findOrphans } from '../src/domain/integrity.js';
import { ROLES } from '../src/auth/policy.js';
import { DELIVERY_OPTIONS, FINISHING_OPTIONS, STORED_PURPOSES } from '../src/domain/requirements.js';
import { MIGRATIONS } from '../src/migrations/index.js';

const cfg = readDbConfig(process.env);
if (!cfg.user || !cfg.database) { console.error('DB_USER and DB_NAME must be set in .env'); process.exit(2); }
let conn;
try {
  conn = await mysql.createConnection({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database });
} catch (err) { console.error(`cannot connect: ${err.code ?? 'error'}`); process.exit(2); }

const problems = [];
const ok = (m) => console.log(`  ok      ${m}`);
const bad = (m) => { problems.push(m); console.log(`  PROBLEM ${m}`); };
const note = (m) => console.log(`  note    ${m}`);
const rows = async (sql, params = []) => (await conn.query(sql, params))[0];
const db = { rows, one: async (sql, params) => (await rows(sql, params))[0] };
const ids = (list) => list.slice(0, 10).join(', ') + (list.length > 10 ? `, ... (${list.length})` : '');

try {
  await conn.query('SET SESSION TRANSACTION READ ONLY');
  await conn.query('START TRANSACTION READ ONLY');
  const [[v]] = await conn.query('SELECT VERSION() AS v, @@transaction_read_only AS ro, DATABASE() AS db, @@port AS port');
  if (Number(v.ro) !== 1) throw new Error('could not enter a read-only transaction - stopping');
  console.log(`MySQL ${v.v} at ${cfg.host}:${v.port}, database "${v.db}", read-only transaction: yes`);
  const schema = await loadSchema(db);

  console.log('\n1. Tables and migrations');
  const tables = (await rows("SELECT TABLE_NAME t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME")).map((r) => r.t);
  const noPk = [];
  for (const t of tables) if (!Number((await db.one("SELECT COUNT(*) n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = 'PRIMARY'", [t])).n)) noPk.push(t);
  console.log(`  ${tables.length} tables`);
  if (noPk.length) bad(`tables without a primary key: ${noPk.join(', ')}`); else ok('every table has a primary key');
  const applied = new Set((await rows('SELECT * FROM schema_migrations')).map((r) => String(r.id ?? Object.values(r)[0])));
  const missing = MIGRATIONS.map((m) => m.id).filter((n) => !applied.has(n));
  if (missing.length) bad(`migrations not applied: ${missing.join(', ')}`); else ok(`all ${MIGRATIONS.length} migrations applied`);

  console.log('\n2. Users, roles and reporting lines');
  const users = await rows(`SELECT id, role, LOWER(email) AS email, parent_id, ${schema.has('users', 'password') ? 'password' : 'NULL AS password'} FROM users`);
  const byId = new Map(users.map((u) => [Number(u.id), u]));
  const unknownRole = users.filter((u) => !ROLES.includes(String(u.role ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_')));
  if (unknownRole.length) bad(`unknown roles on users ${ids(unknownRole.map((u) => u.id))}`); else ok(`every one of ${users.length} users has a known role`);
  const notBcrypt = users.filter((u) => !/^\$2[aby]\$\d{2}\$/.test(String(u.password ?? '')));
  if (notBcrypt.length) bad(`passwords not stored as bcrypt (users ${ids(notBcrypt.map((u) => u.id))})`); else ok('every password is a bcrypt hash');
  const dupEmail = Object.entries(users.reduce((a, u) => ((a[u.email] = (a[u.email] ?? 0) + 1), a), {})).filter(([, n]) => n > 1);
  if (dupEmail.length) bad(`${dupEmail.length} e-mail address(es) used by more than one user`); else ok('e-mail addresses are unique');
  const loops = [];
  for (const u of users) {
    const seen = new Set([Number(u.id)]);
    for (let p = Number(u.parent_id) || 0; p; p = Number(byId.get(p)?.parent_id) || 0) {
      if (seen.has(p)) { loops.push(u.id); break; }
      seen.add(p);
    }
  }
  if (loops.length) bad(`reporting loops (users ${ids(loops)})`); else ok('no reporting loops, nobody reports to themselves');

  console.log('\n3. Relationships (orphan rows)');
  const { problems: orphans, notes } = await findOrphans(db, schema);
  for (const o of orphans) bad(`${o.relation}: ${o.count} row(s) point to a missing record (ids ${ids(o.ids)})`);
  if (!orphans.length) ok('no orphan references');
  for (const n of notes) note(`${n.relation}: ${n.count} comment(s) kept from deleted records (by design)`);

  console.log('\n4. Stored values');
  if (schema.hasTable('lead_requirements')) {
    for (const [col, allowed] of [['delivery', DELIVERY_OPTIONS], ['finishing', FINISHING_OPTIONS], ['purpose', STORED_PURPOSES]]) {
      const badRows = await rows(`SELECT lead_id FROM lead_requirements WHERE ${col} IS NOT NULL AND ${col} NOT IN (${allowed.map(() => '?').join(',')})`, allowed);
      if (badRows.length) bad(`lead_requirements.${col}: invalid value on leads ${ids(badRows.map((r) => r.lead_id))}`); else ok(`every stored ${col} is an allowed option`);
    }
  }
  for (const t of ['statuses', 'sources', 'destinations', 'property_types', 'developers']) {
    if (!schema.hasTable(t)) continue;
    const d = await rows(`SELECT LOWER(TRIM(name)) n, COUNT(*) c FROM \`${t}\` GROUP BY LOWER(TRIM(name)) HAVING COUNT(*) > 1`);
    if (d.length) bad(`${t}: ${d.length} duplicated name(s)`); else ok(`${t}: names are unique`);
  }
  const phoneCol = schema.has('leads', 'phone') ? 'phone' : null;
  if (phoneCol) {
    const d = await rows('SELECT COUNT(*) c FROM (SELECT phone FROM leads WHERE phone <> \'\' GROUP BY phone HAVING COUNT(*) > 1) x');
    if (Number(d[0].c)) bad(`${d[0].c} phone number(s) shared by more than one lead`); else ok('no phone number is shared by two leads');
  }
  if (schema.has('call_history', 'request_id')) {
    const d = await rows('SELECT COUNT(*) c FROM (SELECT user_id, request_id FROM call_history WHERE request_id IS NOT NULL GROUP BY user_id, request_id HAVING COUNT(*) > 1) x');
    if (Number(d[0].c)) bad('a call was saved twice'); else ok('no call was saved twice');
  }
} catch (err) {
  bad(`audit stopped: ${err.code ?? err.message}`);
} finally {
  await conn.query('ROLLBACK').catch(() => {});
  await conn.end().catch(() => {});
}
console.log(`\nREAD-ONLY DATABASE AUDIT: ${problems.length} problem(s)`);
process.exit(problems.length ? 1 : 0);

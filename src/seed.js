import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { insertRow } from './db.js';
import { nowSql } from './lib/dates.js';
import { DEFAULT_USER_IMAGE } from './domain/serializers.js';
import { rebuildReports } from './domain/reports.js';

const loadSeed = async (name) => {
  try { return JSON.parse(await fs.readFile(new URL(`../seed/${name}`, import.meta.url), 'utf8')); } catch { return null; }
};

/** Inserts `rows` only when the table is empty. Never overwrites existing data. */
async function seedIfEmpty(ctx, table, rows) {
  const { db, schema } = ctx;
  if (!rows.length || !schema.hasTable(table)) return 0;
  if (Number((await db.one(`SELECT COUNT(*) AS cnt FROM \`${table}\``)).cnt) > 0) return 0;
  for (const row of rows) {
    const filtered = schema.only(table, row);
    const cols = Object.keys(filtered);
    await db.exec(`INSERT INTO \`${table}\` (${cols.map((c) => `\`${c}\``).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => filtered[c]));
  }
  return rows.length;
}

/**
 * Initial administrator for a brand-new (empty) database. The password comes from INITIAL_ADMIN_PASSWORD or is generated
 * and printed ONCE. (The old seed created admin@mentors.com / "password" and a second admin with a password in git.)
 */
async function seedAdmin(ctx) {
  const { db, schema, config, passwords, logger } = ctx;
  if (Number((await db.one('SELECT COUNT(*) AS cnt FROM users')).cnt) > 0) return;
  const { email, name } = config.initialAdmin;
  const generated = !config.initialAdmin.password;
  const password = config.initialAdmin.password || crypto.randomBytes(15).toString('base64url');
  const now = nowSql();
  const hash = await passwords.hash(password);
  await db.tx((tx) => insertRow(tx, 'users', schema.only('users', {
    name, email: email.toLowerCase(), phone: '', password: hash, role: 'admin',
    status: 1, isActive: 1, is_active: 1, image: DEFAULT_USER_IMAGE, createdAt: now, created_at: now, updated_at: now,
  })), { tables: ['users'] });
  logger.warn(`created the initial administrator ${email}`);
  if (generated) {
    process.stdout.write(`\n==============================================================\n INITIAL ADMIN CREATED  email: ${email}\n                        password: ${password}\n This is shown only once. Sign in and change it now.\n==============================================================\n\n`);
  }
}

export async function seedBaseData(ctx) {
  const { db, schema, logger } = ctx;
  const now = nowSql();
  await seedAdmin(ctx);
  const [titles, statuses, sources, projects, agentCare, developers] = await Promise.all(
    ['titles.json', 'statuses.json', 'sources.json', 'projects.json', 'agent-care.json', 'developers.json'].map(loadSeed)
  );
  const dated = (row) => ({ ...row, created_at: now, updated_at: now });
  await seedIfEmpty(ctx, 'statuses', (statuses ?? []).map((s) => dated({ id: s.id, name: s.name, color: s.color })));
  await seedIfEmpty(ctx, 'sources', (sources ?? []).map((s) => dated({ id: s.id, name: s.name, color: s.color })));
  if (titles?.length && schema.hasTable('jobtitles') && Number((await db.one('SELECT COUNT(*) AS cnt FROM jobtitles')).cnt) === 0) {
    let dept = await db.one('SELECT id FROM departments WHERE name = ? LIMIT 1', ['Sales']);
    if (!dept) dept = { id: Number((await db.exec('INSERT INTO departments (name, created_at, updated_at) VALUES (?, ?, ?)', ['Sales', now, now])).insertId) };
    await seedIfEmpty(ctx, 'jobtitles', titles.map((t) => dated({ id: t.id, name: t.name, department_id: dept.id })));
  }
  // Developers are inserted only when missing (by id) - the old code re-wrote them on EVERY start, undoing admin edits.
  for (const d of developers ?? []) {
    if (await db.one('SELECT id FROM developers WHERE id = ?', [d.id])) continue;
    const row = schema.only('developers', dated({ id: d.id, name: d.name, logo: d.logo ?? null, description: d.description ?? null, phone: d.phone ?? null, whatsapp: d.whatsapp ?? null, email: d.email ?? null, website: d.website ?? null, establishedYear: d.establishedYear ?? null, foundedBy: d.foundedBy ?? null }));
    const cols = Object.keys(row);
    await db.exec(`INSERT INTO developers (${cols.map((c) => `\`${c}\``).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => row[c]));
  }
  // Referential consistency: a seed project never points at a developer that does not exist (that is how the orphan
  // "project 13 -> developer 9" looked). Unknown developers are stored as "no developer" and reported.
  const developerIds = new Set((await db.rows('SELECT id FROM developers')).map((r) => Number(r.id)));
  const projectRows = (projects ?? []).map((p) => {
    const developerId = p.developerId && developerIds.has(Number(p.developerId)) ? Number(p.developerId) : null;
    if (p.developerId && developerId === null) logger.warn(`seed project "${p.name}" refers to missing developer #${p.developerId}: stored without a developer`);
    return dated({ id: p.id, name: p.name, developer_id: developerId, developerId });
  });
  await seedIfEmpty(ctx, 'projects', projectRows);
  if (agentCare) await seedIfEmpty(ctx, 'agent_care', [{ id: agentCare.id, name: agentCare.name, phone: agentCare.phone, whatsapp: agentCare.whatsapp, email: agentCare.email }]);
  // One-time backfill: reports are derived from comments; an empty reports table with existing comments means an upgrade.
  if (schema.hasTable('reports')) {
    const reports = Number((await db.one('SELECT COUNT(*) AS cnt FROM reports')).cnt);
    const comments = Number((await db.one('SELECT COUNT(*) AS cnt FROM comments')).cnt);
    if (reports === 0 && comments > 0) logger.info(`reports backfilled from ${await rebuildReports(db, schema)} comment(s)`);
  }
}

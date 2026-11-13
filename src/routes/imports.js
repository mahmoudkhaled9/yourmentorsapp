import express from 'express';
import { asyncHandler, badRequest, isDuplicateKey } from '../http/errors.js';
import { bodyOf } from '../lib/validate.js';
import { normalizeClientPhone, normalizeEgyptianMobile } from '../lib/phone.js';
import { nowSql, toSqlDate } from '../lib/dates.js';
import { requireSuper } from '../auth/policy.js';
import { allocateId } from '../db.js';
import { coldCallSpec, leadSpec } from '../domain/recordSpecs.js';

export const MAX_IMPORT_ROWS = 10000;
const CHUNK = 250;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const digits = (v) => String(v ?? '').replace(/\D/g, '');
/** Spreadsheets drop the leading zero of 010..., so the 10-digit form is accepted (and repaired) on import. */
const importPhone = (raw) => normalizeClientPhone(raw, { allowMissingZero: true });
/** The same number typed differently ("010 1234 5678", "+20 10...") must be recognised as a duplicate. */
const phoneKey = (raw) => normalizeEgyptianMobile(raw, { allowMissingZero: true }) ?? digits(raw);
const lower = (v) => String(v ?? '').trim().toLowerCase();
const clip = (v, max) => {
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  const s = String(v).trim();
  return s.length > max ? s.slice(0, max) : s;
};
const byName = (rows) => new Map(rows.map((r) => [lower(r.name), r]));
const byId = (rows) => new Map(rows.map((r) => [Number(r.id), r]));

/**
 * Bulk import (administrators only). One transaction per request, plain INSERTs in chunks (the old code upserted on a
 * guessed id and could silently overwrite someone else's lead). Duplicate phones (against the table and within the file)
 * are skipped, never overwritten. Phones must be Egyptian mobiles or international (+country code).
 */
export function importRoutes(ctx) {
  const { db, schema, audit } = ctx;
  const router = express.Router();

  async function loadLookups() {
    const [statuses, sources, projects, users] = await Promise.all([
      db.rows('SELECT id, name FROM statuses ORDER BY id ASC'),
      db.rows('SELECT id, name FROM sources'),
      db.rows('SELECT id, name FROM projects'),
      db.rows('SELECT id, name, role, parent_id, status FROM users'),
    ]);
    return {
      statuses, statusById: byId(statuses), statusByName: byName(statuses),
      sourceById: byId(sources), sourceByName: byName(sources),
      projectById: byId(projects), projectByName: byName(projects), userById: byId(users),
    };
  }

  async function insertAll(table, rows) {
    const columns = Object.keys(rows[0]);
    const colSql = columns.map((c) => `\`${c}\``).join(', ');
    const rowPh = `(?, ${columns.map(() => '?').join(', ')})`;
    for (let attempt = 1; ; attempt += 1) {
      try {
        await db.tx(async (tx) => {
          const first = await allocateId(tx, table, rows.length); // reserve the whole block of ids
          for (let i = 0; i < rows.length; i += CHUNK) {
            const chunk = rows.slice(i, i + CHUNK);
            await tx.exec(`INSERT INTO \`${table}\` (id, ${colSql}) VALUES ${chunk.map(() => rowPh).join(', ')}`, chunk.flatMap((r, k) => [first + i + k, ...columns.map((c) => r[c])]));
          }
        }, { tables: [table], retries: 0 });
        return;
      } catch (err) {
        if (isDuplicateKey(err) && attempt < 6) { await sleep(5 * attempt); continue; }
        throw err;
      }
    }
  }

  function register(spec, { withCrm }) {
    const { table, label } = spec;
    router.post(`/${spec.route}/import`, asyncHandler(async (req, res) => {
      requireSuper(req.currentUser, 'Only administrators can import data');
      const rows = bodyOf(req).rows;
      if (!Array.isArray(rows)) throw badRequest('rows must be a list');
      if (rows.length > MAX_IMPORT_ROWS) throw badRequest(`At most ${MAX_IMPORT_ROWS} rows can be imported per request`);
      const empty = { ok: true, count: 0, skipped: 0, duplicates: 0, invalid: 0 };
      if (!rows.length) { res.json(empty); return; }

      const L = await loadLookups();
      if (!L.statuses.length) throw badRequest('No statuses are configured yet');
      const known = new Set((await db.rows(`SELECT phone FROM \`${table}\``)).map((r) => phoneKey(r.phone)));
      const now = nowSql();
      const prepared = [];
      let duplicates = 0;
      let invalid = 0;
      for (const item of rows) {
        if (!item || typeof item !== 'object') { invalid += 1; continue; }
        const phone = importPhone(clip(item.phone, 50));
        if (!phone) { invalid += 1; continue; }
        const key = phoneKey(phone);
        if (known.has(key)) { duplicates += 1; continue; }
        known.add(key);
        const status = L.statusById.get(Number(item.statusId ?? item.status_id)) ?? L.statusByName.get(lower(item.status)) ?? L.statuses[0];
        const ownerRow = L.userById.get(Number(item.assignedToId ?? item.userId));
        const owner = ownerRow && Number(ownerRow.status ?? 1) === 1 ? ownerRow : null;
        const teamLeader = !owner ? null : String(owner.role).toLowerCase() === 'team_leader' ? owner : L.userById.get(Number(owner.parent_id)) ?? null;
        const input = {
          name: clip(item.name, 255) || 'Unknown',
          phone,
          whatsapp: importPhone(clip(item.whatsapp, 50)) ?? undefined,
          workPhone: clip(item.workPhone ?? item.workphone, 50) || undefined,
          email: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(clip(item.email, 255)) ? clip(item.email, 255).toLowerCase() : undefined,
          comment: clip(item.comment ?? item.notes, 5000) || undefined,
          notes: clip(item.notes ?? item.comment, 5000) || undefined,
          date: toSqlDate(item.date, null) ?? undefined,
        };
        const refs = {
          status,
          source: withCrm ? L.sourceByName.get(lower(item.source)) ?? L.sourceById.get(Number(item.sourceId ?? item.source_id)) ?? null : null,
          project: withCrm ? L.projectByName.get(lower(item.project)) ?? L.projectById.get(Number(item.projectId ?? item.project_id)) ?? null : null,
        };
        prepared.push(schema.only(table, spec.buildRow({ input, refs, owner, teamLeader, existing: null, now, ownerChanged: true })));
      }
      if (prepared.length) await insertAll(table, prepared);
      await audit({ userId: req.currentUser.id, entityType: table, action: 'imported', summary: `${prepared.length} ${label.toLowerCase()}(s) imported, ${duplicates} duplicate(s) and ${invalid} invalid row(s) skipped` });
      res.json({ ...empty, count: prepared.length, skipped: duplicates + invalid, duplicates, invalid });
    }));
  }

  register(leadSpec(ctx), { withCrm: true });
  register(coldCallSpec(), { withCrm: false });
  return router;
}

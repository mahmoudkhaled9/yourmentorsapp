import express from 'express';
import { asyncHandler, badRequest, conflict, forbidden, notFound } from '../http/errors.js';
import { Validator, bodyOf, parseId } from '../lib/validate.js';
import { nowSql, toIso } from '../lib/dates.js';
import { normalizeClientPhone, normalizeEgyptianMobile } from '../lib/phone.js';
import { isSuper, loadTreeScope, normalizeRole, requireSuper } from '../auth/policy.js';
import { insertRow } from '../db.js';
import { inClause, teamLeaderFor, userBrief } from '../domain/lookups.js';
import { coldCallSpec, leadSpec } from '../domain/recordSpecs.js';
import { upsertReportForComment } from '../domain/reports.js';
import { DELIVERY_OPTIONS, FINISHING_OPTIONS, LEGACY_PURPOSES, PURPOSE_OPTIONS, parseRequirements, saveRequirements } from '../domain/requirements.js';
import { BATCH_SIZES, OUTCOMES, OUTCOME_KEYS, readUploadedRow, requirementsText, serializeBatch, serializeItem } from '../domain/pool.js';

export const MAX_POOL_IMPORT_ROWS = 10000;
const CHUNK = 250;
const MAX_PAGE = 5000;
const digits = (v) => String(v ?? '').replace(/\D/g, '');
const phoneKey = (raw) => normalizeEgyptianMobile(raw, { allowMissingZero: true }) ?? digits(raw);
const clip = (v, max) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim().slice(0, max) : '');

const ITEM_SELECT = `SELECT i.*, n.name AS number_name, n.phone, n.notes AS number_notes, n.import_id, n.destination, n.property_type,
       n.budget_min, n.budget_max, n.delivery, n.finishing, n.purpose, n.down_payment, n.installment, n.original_json,
       u.name AS user_name, e.name AS ended_by_name
  FROM pool_batch_items i
  JOIN pool_numbers n ON n.id = i.pool_number_id
  LEFT JOIN users u ON u.id = i.user_id
  LEFT JOIN users e ON e.id = i.ended_by`;
const BATCH_SELECT = `SELECT b.*, u.name AS user_name,
       (SELECT COUNT(*) FROM pool_batch_items x WHERE x.batch_id = b.id AND x.ended_at IS NULL) AS open_count,
       (SELECT COUNT(*) FROM pool_batch_items x WHERE x.batch_id = b.id AND x.end_reason = 'processed') AS processed_count,
       (SELECT COUNT(*) FROM pool_batch_items x WHERE x.batch_id = b.id AND x.end_reason IN ('released', 'cancelled')) AS released_count
  FROM pool_batches b
  LEFT JOIN users u ON u.id = b.user_id`;

/**
 * Number Pool. Privacy rule, enforced in every query below (never in the browser):
 *   a person sees pool records owned by themselves or by someone directly / indirectly below them in users.parent_id.
 * There is NO role bypass: an admin or franchise owner who is not an ancestor in the tree sees no employee-level pool
 * record (phone numbers, requirements, batches, history); they get the non-identifying /pool/summary instead.
 * Records outside the caller's tree answer 404 (never 403), so their existence is not confirmed. Identity always comes
 * from the token: user ids in a body or query string can only narrow what the caller already may see.
 */
export function poolRoutes(ctx) {
  const { db, audit } = ctx;
  const router = express.Router();
  const treeScope = (req) => { req.poolScope ??= loadTreeScope(db, req.currentUser); return req.poolScope; };
  const hidden = (what) => notFound(`${what} not found`);

  /**
   * Time window: `since` / `until` are exact instants (the browser sends its own local midnight, so "today" follows the
   * user's clock, not UTC); `from` / `to` are whole UTC days (kept for API clients). `until` is exclusive.
   */
  function timeRange(query, v) {
    return { from: v.date(query.from, 'from'), to: v.date(query.to, 'to'), since: v.datetime(query.since, 'since'), until: v.datetime(query.until, 'until') };
  }
  function addRange(where, params, column, r) {
    if (r.from) { where.push(`${column} >= ?`); params.push(`${r.from} 00:00:00`); }
    if (r.to) { where.push(`${column} <= ?`); params.push(`${r.to} 23:59:59`); }
    if (r.since) { where.push(`${column} >= ?`); params.push(r.since); }
    if (r.until) { where.push(`${column} < ?`); params.push(r.until); }
  }

  function paging(query, v) {
    const page = v.int(query.page, 'page', { min: 1, max: 100000 }) ?? 1;
    const pageSize = v.int(query.pageSize, 'pageSize', { min: 1, max: MAX_PAGE }) ?? 100;
    return { page, pageSize, offset: (page - 1) * pageSize };
  }

  async function loadBatch(run, id) {
    const row = await run.one(`${BATCH_SELECT} WHERE b.id = ?`, [id]);
    return row ? serializeBatch(row) : null;
  }
  const batchItems = async (run, batchId) => (await run.rows(`${ITEM_SELECT} WHERE i.batch_id = ? ORDER BY i.id ASC`, [batchId])).map(serializeItem);

  async function closeBatchIfDone(tx, batchId, now) {
    const open = await tx.one('SELECT COUNT(*) AS c FROM pool_batch_items WHERE batch_id = ? AND ended_at IS NULL', [batchId]);
    if (Number(open.c) === 0) await tx.exec("UPDATE pool_batches SET status = 'completed', completed_at = ? WHERE id = ? AND status = 'active'", [now, batchId]);
  }

  // ---------------------------------------------------------------- the caller's own pool -------------------------
  router.get('/pool/me', asyncHandler(async (req, res) => {
    const actor = req.currentUser;
    const scope = await treeScope(req);
    const active = await db.one(`${BATCH_SELECT} WHERE b.user_id = ? AND b.status = 'active' ORDER BY b.id DESC LIMIT 1`, [actor.id]);
    const available = await db.one("SELECT COUNT(*) AS c FROM pool_numbers WHERE status = 'available'");
    const batch = active ? serializeBatch(active) : null;
    res.json({
      isAgent: normalizeRole(actor.role) === 'agent',
      canRequest: normalizeRole(actor.role) === 'agent' && (!batch || batch.counts.open === 0),
      sizes: BATCH_SIZES,
      outcomes: OUTCOME_KEYS.map((key) => ({ value: key, label: OUTCOMES[key] })),
      available: Number(available.c),
      activeBatch: batch ? { ...batch, items: await batchItems(db, batch.id) } : null,
      teamSize: scope.ids.size - 1,
      canSeeSummary: isSuper(actor),
      canImport: isSuper(actor),
    });
  }));

  // ---------------------------------------------------------------- request a batch (agents) -----------------------
  router.post('/pool/batches', asyncHandler(async (req, res) => {
    const actor = req.currentUser;
    if (normalizeRole(actor.role) !== 'agent') throw forbidden('Only agents can request numbers from the pool');
    const v = new Validator();
    const size = v.int(bodyOf(req).size, 'size', { required: true });
    if (size !== undefined && !BATCH_SIZES.includes(size)) v.fail('size', `must be one of ${BATCH_SIZES.join(', ')}`);
    v.assert();

    const batchId = await db.tx(async (tx) => {
      await tx.one('SELECT id FROM users WHERE id = ? FOR UPDATE', [actor.id]); // one request at a time per agent
      const now = nowSql();
      const active = await tx.rows("SELECT id FROM pool_batches WHERE user_id = ? AND status = 'active' FOR UPDATE", [actor.id]);
      for (const b of active) {
        const open = await tx.one('SELECT COUNT(*) AS c FROM pool_batch_items WHERE batch_id = ? AND ended_at IS NULL', [b.id]);
        if (Number(open.c) > 0) throw conflict('Finish the numbers of your current batch before requesting a new one', 'ACTIVE_BATCH');
        await tx.exec("UPDATE pool_batches SET status = 'completed', completed_at = ? WHERE id = ?", [now, b.id]);
      }
      // row locks: two agents asking at the same moment can never receive the same number
      const candidates = (await tx.rows(`SELECT id FROM pool_numbers WHERE status = 'available' ORDER BY id ASC LIMIT ${size} FOR UPDATE`)).map((r) => Number(r.id));
      if (!candidates.length) throw conflict('The Number Pool is empty right now. Ask an administrator to upload more numbers.', 'POOL_EMPTY');
      const created = await tx.exec(
        "INSERT INTO pool_batches (user_id, requested_by, size_requested, size_allocated, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)",
        [actor.id, actor.id, size, candidates.length, now],
      );
      const id = Number(created.insertId);
      const q = inClause(candidates);
      const updated = await tx.exec(
        `UPDATE pool_numbers SET status = 'allocated', user_id = ?, batch_id = ?, allocated_at = ?, updated_at = ? WHERE status = 'available' AND id IN (${q.sql})`,
        [actor.id, id, now, now, ...q.params],
      );
      if (Number(updated.affectedRows) !== candidates.length) throw conflict('The pool changed while your batch was being prepared. Please try again.', 'POOL_BUSY');
      await tx.exec(
        `INSERT INTO pool_batch_items (batch_id, pool_number_id, user_id, allocated_at) VALUES ${candidates.map(() => '(?, ?, ?, ?)').join(', ')}`,
        candidates.flatMap((n) => [id, n, actor.id, now]),
      );
      return id;
    }, { tables: ['pool_numbers'] });

    const batch = await loadBatch(db, batchId);
    await audit({ userId: actor.id, entityType: 'pool_batches', entityId: batchId, action: 'requested', summary: `Pool batch #${batchId}: ${batch.sizeAllocated} of ${batch.sizeRequested} number(s) allocated` });
    res.json({ ok: true, item: { ...batch, items: await batchItems(db, batchId) } });
  }));

  // ---------------------------------------------------------------- batches (own + subtree) ------------------------
  router.get('/pool/batches', asyncHandler(async (req, res) => {
    const scope = await treeScope(req);
    const v = new Validator();
    const userId = v.int(req.query.userId, 'userId', { min: 1 });
    const status = v.oneOf(req.query.status, 'status', ['active', 'completed', 'cancelled']);
    const range = timeRange(req.query, v);
    const { page, pageSize, offset } = paging(req.query, v);
    v.assert();
    const f = scope.sqlIn('b.user_id');
    const where = [f.sql];
    const params = [...f.params];
    if (userId) { where.push('b.user_id = ?'); params.push(userId); } // narrows the scope, never widens it
    if (status) { where.push('b.status = ?'); params.push(status); }
    addRange(where, params, 'b.created_at', range);
    const sql = where.join(' AND ');
    const total = await db.one(`SELECT COUNT(*) AS c FROM pool_batches b WHERE ${sql}`, params);
    const rows = await db.rows(`${BATCH_SELECT} WHERE ${sql} ORDER BY b.id DESC LIMIT ${pageSize} OFFSET ${offset}`, params);
    res.json({ items: rows.map(serializeBatch), total: Number(total.c), page, pageSize });
  }));

  router.get('/pool/batches/:id', asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const scope = await treeScope(req);
    const batch = await loadBatch(db, id);
    if (!batch || !scope.has(batch.userId)) throw hidden('Batch');
    res.json({ ...batch, items: await batchItems(db, id) });
  }));

  /** Hands open numbers back to the pool. Only a manager ABOVE the batch owner (a strict ancestor) may do this. */
  async function endOpen(req, { cancel }) {
    const actor = req.currentUser;
    const id = parseId(req.params.id);
    const scope = await treeScope(req);
    const v = new Validator();
    const body = bodyOf(req);
    const itemIds = !cancel && body.itemIds !== undefined ? v.intList(body.itemIds, 'itemIds', { max: 100 }) : undefined;
    v.assert();
    const result = await db.tx(async (tx) => {
      const batch = await tx.one('SELECT * FROM pool_batches WHERE id = ? FOR UPDATE', [id]);
      if (!batch || !scope.has(batch.user_id)) throw hidden('Batch');
      if (Number(batch.user_id) === Number(actor.id)) throw forbidden('Only a manager above you in the reporting line can hand numbers back to the pool');
      if (batch.status !== 'active') throw conflict('This batch is already closed', 'BATCH_CLOSED');
      const filter = itemIds ? inClause(itemIds) : null;
      const open = await tx.rows(
        `SELECT id, pool_number_id FROM pool_batch_items WHERE batch_id = ? AND ended_at IS NULL${filter ? ` AND id IN (${filter.sql})` : ''} FOR UPDATE`,
        [id, ...(filter?.params ?? [])],
      );
      if (itemIds && open.length !== itemIds.length) throw notFound('Some of the selected numbers are not open in this batch');
      const now = nowSql();
      if (open.length) {
        const items = inClause(open.map((r) => Number(r.id)));
        const numbers = inClause(open.map((r) => Number(r.pool_number_id)));
        // the allocation rows stay (who had the number, when, and who took it back); only their end is recorded
        await tx.exec(`UPDATE pool_batch_items SET ended_at = ?, end_reason = ?, ended_by = ? WHERE ended_at IS NULL AND id IN (${items.sql})`, [now, cancel ? 'cancelled' : 'released', actor.id, ...items.params]);
        await tx.exec(`UPDATE pool_numbers SET status = 'available', user_id = NULL, batch_id = NULL, allocated_at = NULL, updated_at = ? WHERE batch_id = ? AND status = 'allocated' AND id IN (${numbers.sql})`, [now, id, ...numbers.params]);
      }
      if (cancel) await tx.exec("UPDATE pool_batches SET status = 'cancelled', cancelled_at = ?, cancelled_by = ? WHERE id = ?", [now, actor.id, id]);
      else await closeBatchIfDone(tx, id, now);
      return { count: open.length, ownerId: Number(batch.user_id) };
    }, { tables: ['pool_numbers'] });
    await audit({
      userId: actor.id, entityType: 'pool_batches', entityId: id, action: cancel ? 'cancelled' : 'released',
      summary: `Pool batch #${id}: ${result.count} number(s) handed back to the pool${cancel ? ', batch cancelled' : ''}`,
    });
    return { ok: true, count: result.count, item: { ...(await loadBatch(db, id)), items: await batchItems(db, id) } };
  }
  router.post('/pool/batches/:id/release', asyncHandler(async (req, res) => res.json(await endOpen(req, { cancel: false }))));
  router.post('/pool/batches/:id/cancel', asyncHandler(async (req, res) => res.json(await endOpen(req, { cancel: true }))));

  // ---------------------------------------------------------------- numbers / history (own + subtree) --------------
  router.get('/pool/items', asyncHandler(async (req, res) => {
    const scope = await treeScope(req);
    const v = new Validator();
    const userId = v.int(req.query.userId, 'userId', { min: 1 });
    const batchId = v.int(req.query.batchId, 'batchId', { min: 1 });
    const state = v.oneOf(req.query.state, 'state', ['open', 'processed', 'released', 'cancelled']);
    const outcome = v.oneOf(req.query.outcome, 'outcome', OUTCOME_KEYS);
    const range = timeRange(req.query, v);
    const search = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
    const { page, pageSize, offset } = paging(req.query, v);
    v.assert();
    const f = scope.sqlIn('i.user_id');
    const where = [f.sql];
    const params = [...f.params];
    if (userId) { where.push('i.user_id = ?'); params.push(userId); }
    if (batchId) { where.push('i.batch_id = ?'); params.push(batchId); }
    if (state === 'open') where.push('i.ended_at IS NULL');
    else if (state) { where.push('i.end_reason = ?'); params.push(state); }
    if (outcome) { where.push('i.outcome = ?'); params.push(outcome); }
    addRange(where, params, 'i.allocated_at', range);
    if (search) {
      where.push('(LOWER(n.name) LIKE ? OR n.phone LIKE ?)');
      params.push(`%${search.toLowerCase()}%`, `%${digits(search) || search}%`);
    }
    const sql = where.join(' AND ');
    const total = await db.one(`SELECT COUNT(*) AS c FROM pool_batch_items i JOIN pool_numbers n ON n.id = i.pool_number_id WHERE ${sql}`, params);
    const rows = await db.rows(`${ITEM_SELECT} WHERE ${sql} ORDER BY i.id DESC LIMIT ${pageSize} OFFSET ${offset}`, params);
    res.json({ items: rows.map(serializeItem), total: Number(total.c), page, pageSize });
  }));

  router.get('/pool/items/:id', asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const scope = await treeScope(req);
    const row = await db.one(`${ITEM_SELECT} WHERE i.id = ?`, [id]);
    if (!row || !scope.has(row.user_id)) throw hidden('Number');
    // the number's allocation history, limited to the allocations the caller may see
    const f = scope.sqlIn('i.user_id');
    const history = await db.rows(`${ITEM_SELECT} WHERE i.pool_number_id = ? AND ${f.sql} ORDER BY i.id ASC`, [row.pool_number_id, ...f.params]);
    res.json({ ...serializeItem(row), history: history.map(serializeItem) });
  }));

  /** Turns the uploaded requirements into lead requirements (only values the lead form accepts; the rest stay in text). */
  async function leadRequirements(tx, n) {
    const names = (text) => String(text ?? '').split(/[,;/|،]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
    const match = async (table, text) => {
      const wanted = names(text);
      if (!wanted.length) return [];
      const rows = await tx.rows(`SELECT id, name, is_active FROM \`${table}\``);
      return [...new Set(rows.filter((r) => Number(r.is_active ?? 1) === 1 && wanted.includes(String(r.name).trim().toLowerCase())).map((r) => Number(r.id)))].slice(0, 20);
    };
    const money = (x) => (x === null || x === undefined ? null : Number(x));
    let budgetMin = money(n.budget_min);
    let budgetMax = money(n.budget_max);
    if (budgetMin !== null && budgetMax !== null && budgetMin > budgetMax) [budgetMin, budgetMax] = [budgetMax, budgetMin];
    let downPayment = money(n.down_payment);
    if (downPayment !== null && budgetMax !== null && downPayment > budgetMax) downPayment = null; // kept in the text
    return {
      destinationIds: await match('destinations', n.destination),
      propertyTypeIds: await match('property_types', n.property_type),
      budgetMin, budgetMax, downPayment,
      delivery: DELIVERY_OPTIONS.includes(n.delivery) ? n.delivery : null,
      finishing: FINISHING_OPTIONS.includes(n.finishing) ? n.finishing : null,
      purpose: PURPOSE_OPTIONS.includes(n.purpose) ? n.purpose : null,
      installmentPerQuarter: money(n.installment),
    };
  }

  /**
   * The request the agent wrote during the call (same shape and rules as a lead's requirements). It replaces the
   * number's requirement fields, so the agent's managers see what the client actually asked for; the original upload
   * stays untouched in original_json.
   */
  async function saveRequest(tx, numberId, req) {
    const names = async (table, ids, field) => {
      if (!ids.length) return null;
      const q = inClause(ids);
      const rows = await tx.rows(`SELECT id, name, is_active FROM \`${table}\` WHERE id IN (${q.sql})`, q.params);
      const byId = new Map(rows.map((r) => [Number(r.id), r]));
      const bad = ids.filter((id) => !byId.has(id) || Number(byId.get(id).is_active ?? 1) !== 1);
      if (bad.length) throw badRequest(`This ${field === 'destinationIds' ? 'destination' : 'property type'} cannot be chosen: ${bad.join(', ')}`, [{ field: `requirements.${field}`, message: 'does not exist or is deactivated' }]);
      return ids.map((id) => byId.get(id).name).join(', ').slice(0, 500);
    };
    if (LEGACY_PURPOSES.includes(req.purpose)) throw badRequest('Purpose of purchase must be End User or Investment', [{ field: 'requirements.purpose', message: 'must be End User or Investment' }]);
    await tx.exec(
      `UPDATE pool_numbers SET destination = ?, property_type = ?, budget_min = ?, budget_max = ?, delivery = ?, finishing = ?, purpose = ?,
              down_payment = ?, installment = ?, updated_at = ? WHERE id = ?`,
      [await names('destinations', req.destinationIds, 'destinationIds'), await names('property_types', req.propertyTypeIds, 'propertyTypeIds'),
        req.budgetMin, req.budgetMax, req.delivery, req.finishing, req.purpose, req.downPayment, req.installmentPerQuarter, nowSql(), numberId],
    );
  }

  async function createRecord(tx, kind, n, owner, notes, request) {
    const spec = kind === 'lead' ? leadSpec(ctx) : coldCallSpec();
    const phone = normalizeClientPhone(n.phone, { allowMissingZero: true }) ?? n.phone;
    const dup = await tx.one(`SELECT id FROM \`${spec.table}\` WHERE phone = ? LIMIT 1`, [phone]);
    if (dup) throw conflict(`This phone number is already in ${kind === 'lead' ? 'Leads' : 'Cold Calls'}. Record another result.`, 'DUPLICATE_PHONE');
    const text = [notes, n.notes, requirementsText(n)].filter(Boolean).join('\n');
    const input = kind === 'lead' ? { name: n.name, phone, comment: text || undefined } : { name: n.name, phone, notes: text || undefined };
    const refs = await spec.resolveRefs(tx, input, null);
    const teamLeader = await teamLeaderFor(tx, owner);
    const row = spec.buildRow({ input, refs, owner, teamLeader, existing: null, now: nowSql(), ownerChanged: true });
    const id = await insertRow(tx, spec.table, ctx.schema.only(spec.table, row));
    if (kind === 'lead') await saveRequirements(tx, id, request ?? await leadRequirements(tx, n));
    if (text) {
      // the call note + every uploaded requirement, as the first entry of the record's comment history
      const now = nowSql();
      const entity = kind === 'lead' ? 'lead' : 'cold_call';
      const comment = {
        leadId: id, content: text.slice(0, 5000), body: text.slice(0, 5000), createdBy: owner.name, createdById: owner.id, createdAt: now,
        lead_id: kind === 'lead' ? id : null, cold_call_id: kind === 'lead' ? null : id,
        entity_type: entity, entity_id: id, user_id: owner.id, created_at: now, updated_at: now,
      };
      comment.id = await insertRow(tx, 'comments', ctx.schema.only('comments', comment));
      if (ctx.schema.hasTable('reports')) await upsertReportForComment(tx, ctx.schema, comment);
    }
    return id;
  }

  /** The agent who holds the number records the call result. Nobody else can act on their behalf. */
  router.post('/pool/items/:id/process', asyncHandler(async (req, res) => {
    const actor = req.currentUser;
    const id = parseId(req.params.id);
    const scope = await treeScope(req);
    const body = bodyOf(req);
    const v = new Validator();
    const outcome = v.oneOf(body.outcome, 'outcome', OUTCOME_KEYS, { required: true });
    const notes = v.string(body.notes, 'notes', { max: 2000 });
    const request = parseRequirements(body.requirements ?? undefined, v) ?? undefined; // optional: the request written in the call
    v.assert();
    const result = await db.tx(async (tx) => {
      const item = await tx.one('SELECT * FROM pool_batch_items WHERE id = ? FOR UPDATE', [id]);
      if (!item || !scope.has(item.user_id)) throw hidden('Number');
      if (Number(item.user_id) !== Number(actor.id)) throw forbidden('Only the agent this number is assigned to can record the call result');
      if (item.ended_at) throw conflict('This number has already been processed or handed back', 'ITEM_CLOSED');
      const batch = await tx.one('SELECT status FROM pool_batches WHERE id = ? FOR UPDATE', [item.batch_id]);
      if (batch?.status !== 'active') throw conflict('This batch is closed', 'BATCH_CLOSED');
      await tx.one('SELECT id FROM pool_numbers WHERE id = ? FOR UPDATE', [item.pool_number_id]);
      if (request) await saveRequest(tx, item.pool_number_id, request);
      const number = await tx.one('SELECT * FROM pool_numbers WHERE id = ?', [item.pool_number_id]);
      const owner = await userBrief(tx, actor.id);
      const leadId = outcome === 'lead' ? await createRecord(tx, 'lead', number, owner, notes, request) : null;
      const coldCallId = outcome === 'cold_call' ? await createRecord(tx, 'cold_call', number, owner, notes) : null;
      const now = nowSql();
      await tx.exec(
        "UPDATE pool_batch_items SET ended_at = ?, end_reason = 'processed', ended_by = ?, outcome = ?, notes = ?, lead_id = ?, cold_call_id = ? WHERE id = ? AND ended_at IS NULL",
        [now, actor.id, outcome, notes ?? null, leadId, coldCallId, id],
      );
      await tx.exec("UPDATE pool_numbers SET status = 'processed', processed_at = ?, updated_at = ? WHERE id = ?", [now, now, number.id]);
      await closeBatchIfDone(tx, item.batch_id, now);
      return { leadId, coldCallId, batchId: Number(item.batch_id) };
    }, { tables: ['pool_numbers', 'leads', 'cold_calls', 'comments'] });
    await audit({ userId: actor.id, entityType: 'pool_batch_items', entityId: id, action: 'processed', summary: `Pool number processed (batch #${result.batchId}): ${OUTCOMES[outcome]}${request ? ', request written by the agent' : ''}` });
    const row = await db.one(`${ITEM_SELECT} WHERE i.id = ?`, [id]);
    res.json({ ok: true, item: serializeItem(row), leadId: result.leadId, coldCallId: result.coldCallId });
  }));

  // ---------------------------------------------------------------- reports (own + subtree) ------------------------
  router.get('/pool/report', asyncHandler(async (req, res) => {
    const scope = await treeScope(req);
    const v = new Validator();
    const range = timeRange(req.query, v);
    const userId = v.int(req.query.userId, 'userId', { min: 1 });
    v.assert();
    const f = scope.sqlIn('i.user_id');
    const where = [f.sql];
    const params = [...f.params];
    if (userId) { where.push('i.user_id = ?'); params.push(userId); }
    addRange(where, params, 'i.allocated_at', range);
    const count = (cond) => `SUM(CASE WHEN ${cond} THEN 1 ELSE 0 END)`;
    const rows = await db.rows(
      `SELECT i.user_id, u.name AS user_name, u.role AS user_role, p.name AS parent_name,
              COUNT(*) AS allocated, COUNT(DISTINCT i.batch_id) AS batches,
              ${count('i.ended_at IS NULL')} AS open_count,
              ${count("i.end_reason = 'processed'")} AS processed,
              ${count("i.end_reason IN ('released', 'cancelled')")} AS released,
              ${OUTCOME_KEYS.map((k) => `${count(`i.outcome = '${k}'`)} AS o_${k}`).join(', ')}
         FROM pool_batch_items i
         LEFT JOIN users u ON u.id = i.user_id
         LEFT JOIN users p ON p.id = u.parent_id
        WHERE ${where.join(' AND ')}
        GROUP BY i.user_id, u.name, u.role, p.name
        ORDER BY u.name ASC`,
      params,
    );
    const rate = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);
    const shape = (r) => {
      const allocated = Number(r.allocated ?? 0);
      const processed = Number(r.processed ?? 0);
      const outcomes = Object.fromEntries(OUTCOME_KEYS.map((k) => [k, Number(r[`o_${k}`] ?? 0)]));
      return {
        allocated, processed, open: Number(r.open_count ?? 0), released: Number(r.released ?? 0), batches: Number(r.batches ?? 0), outcomes,
        completionRate: rate(processed, allocated), conversionRate: rate(outcomes.lead, processed),
      };
    };
    const people = rows.map((r) => ({ userId: Number(r.user_id), userName: r.user_name, role: r.user_role, managerName: r.parent_name ?? null, ...shape(r) }));
    const sum = (k) => people.reduce((acc, p) => acc + p[k], 0);
    const outcomes = Object.fromEntries(OUTCOME_KEYS.map((k) => [k, people.reduce((acc, p) => acc + p.outcomes[k], 0)]));
    const totals = { allocated: sum('allocated'), processed: sum('processed'), open: sum('open'), released: sum('released'), batches: sum('batches'), outcomes };
    totals.completionRate = rate(totals.processed, totals.allocated);
    totals.conversionRate = rate(outcomes.lead, totals.processed);
    res.json({ from: range.from ?? null, to: range.to ?? null, since: range.since ?? null, until: range.until ?? null, rows: people, totals });
  }));

  // ---------------------------------------------------------------- administration (no employee-level data) -------
  /** Company-wide, non-identifying figures for administrators: counts only, no phone numbers, names or per-agent rows. */
  router.get('/pool/summary', asyncHandler(async (req, res) => {
    requireSuper(req.currentUser, 'Only administrators can see the pool summary');
    const byStatus = await db.rows('SELECT status, COUNT(*) AS c FROM pool_numbers GROUP BY status');
    const status = Object.fromEntries(['available', 'allocated', 'processed'].map((s) => [s, Number(byStatus.find((r) => r.status === s)?.c ?? 0)]));
    const outcomes = await db.rows('SELECT outcome, COUNT(*) AS c FROM pool_batch_items WHERE outcome IS NOT NULL GROUP BY outcome');
    const batches = await db.rows('SELECT status, COUNT(*) AS c FROM pool_batches GROUP BY status');
    const imports = await db.rows(
      `SELECT m.id, m.file_name, m.row_count, m.created_at, u.name AS uploaded_by_name,
              (SELECT COUNT(*) FROM pool_numbers n WHERE n.import_id = m.id AND n.status = 'available') AS available
         FROM pool_imports m LEFT JOIN users u ON u.id = m.uploaded_by ORDER BY m.id DESC LIMIT 50`,
    );
    res.json({
      numbers: { ...status, total: status.available + status.allocated + status.processed },
      batches: Object.fromEntries(['active', 'completed', 'cancelled'].map((s) => [s, Number(batches.find((r) => r.status === s)?.c ?? 0)])),
      outcomes: Object.fromEntries(OUTCOME_KEYS.map((k) => [k, Number(outcomes.find((r) => r.outcome === k)?.c ?? 0)])),
      imports: imports.map((m) => ({ id: Number(m.id), fileName: m.file_name, rowCount: Number(m.row_count), available: Number(m.available), createdAt: m.created_at ? toIso(m.created_at) : null, uploadedBy: m.uploaded_by_name ?? null })),
    });
  }));

  /** Upload Data -> Number Pool (administrators). Duplicates against the pool, Leads and Cold Calls are skipped. */
  router.post('/pool/import', asyncHandler(async (req, res) => {
    const actor = req.currentUser;
    requireSuper(actor, 'Only administrators can import data');
    const body = bodyOf(req);
    const rows = body.rows;
    if (!Array.isArray(rows)) throw badRequest('rows must be a list');
    if (rows.length > MAX_POOL_IMPORT_ROWS) throw badRequest(`At most ${MAX_POOL_IMPORT_ROWS} rows can be imported per request`);
    const empty = { ok: true, count: 0, skipped: 0, duplicates: 0, invalid: 0, importId: null };
    if (!rows.length) { res.json(empty); return; }

    const known = new Set();
    for (const r of await db.rows('SELECT phone_key FROM pool_numbers')) known.add(r.phone_key);
    for (const table of ['leads', 'cold_calls']) for (const r of await db.rows(`SELECT phone FROM \`${table}\``)) known.add(phoneKey(r.phone));
    const now = nowSql();
    const prepared = [];
    let duplicates = 0;
    let invalid = 0;
    rows.forEach((item, index) => {
      if (!item || typeof item !== 'object') { invalid += 1; return; }
      const phone = normalizeClientPhone(clip(item.phone, 50), { allowMissingZero: true });
      if (!phone) { invalid += 1; return; }
      const key = phoneKey(phone);
      if (known.has(key)) { duplicates += 1; return; }
      known.add(key);
      prepared.push({ ...readUploadedRow(item), phone, phone_key: key, source_row: index + 2 }); // +2: header row, 1-based
    });

    let importId = null;
    if (prepared.length) {
      importId = await db.tx(async (tx) => {
        const created = await tx.exec('INSERT INTO pool_imports (file_name, uploaded_by, row_count, created_at) VALUES (?, ?, ?, ?)', [clip(body.fileName, 255) || null, actor.id, prepared.length, now]);
        const newId = Number(created.insertId);
        const cols = ['import_id', 'source_row', 'name', 'phone', 'phone_key', 'notes', 'destination', 'property_type', 'budget_min', 'budget_max',
          'delivery', 'finishing', 'purpose', 'down_payment', 'installment', 'original_json', 'status', 'created_at', 'updated_at'];
        for (let i = 0; i < prepared.length; i += CHUNK) {
          const chunk = prepared.slice(i, i + CHUNK);
          await tx.exec(
            `INSERT INTO pool_numbers (${cols.join(', ')}) VALUES ${chunk.map(() => `(${cols.map(() => '?').join(', ')})`).join(', ')}`,
            chunk.flatMap((r) => cols.map((c) => (c === 'import_id' ? newId : c === 'status' ? 'available' : c === 'created_at' || c === 'updated_at' ? now : r[c] ?? null))),
          );
        }
        return newId;
      }, { tables: ['pool_numbers'] });
    }
    await audit({ userId: actor.id, entityType: 'pool_imports', entityId: importId, action: 'imported', summary: `${prepared.length} number(s) added to the Number Pool, ${duplicates} duplicate(s) and ${invalid} invalid row(s) skipped` });
    res.json({ ...empty, count: prepared.length, skipped: duplicates + invalid, duplicates, invalid, importId });
  }));

  return router;
}

import express from 'express';
import { asyncHandler, badRequest, conflict, forbidden, notFound } from '../http/errors.js';
import { Validator, bodyOf, parseId } from '../lib/validate.js';
import { nowSql, toIso } from '../lib/dates.js';
import { isSuper } from '../auth/policy.js';
import { insertRow } from '../db.js';
import { pickStatus } from '../domain/lookups.js';
import { isPotentialName, serializeComment } from '../domain/serializers.js';
import { refreshReportsForEntity, upsertReportForComment } from '../domain/reports.js';
import { loadRequirements } from '../domain/requirements.js';
import { CALL_SELECT, callScopeSql, callSummary, parseCallInput, serializeCall } from '../domain/callActions.js';

const ENTITY = {
  lead: { table: 'leads', column: 'lead_id', label: 'Lead' },
  cold_call: { table: 'cold_calls', column: 'cold_call_id', label: 'Cold call' },
};

/**
 * Call actions: POST /leads/:id/call-actions and /cold-calls/:id/call-actions log a call; GET /call-actions (also
 * served as /call-history) lists calls; GET/PUT /call-actions/:id read / correct one; GET /leads/:id/activity and
 * /cold-calls/:id/activity return the timeline (calls + comments + follow-ups). Everything is scoped like the records:
 * you can only act on leads / cold calls of your own team.
 */
export function callActionRoutes(ctx) {
  const { db, schema, audit } = ctx;
  const router = express.Router();

  const loadCall = async (run, id) => {
    const row = await run.one(`${CALL_SELECT} WHERE ch.id = ?`, [id]);
    return row ? serializeCall(row) : null;
  };

  /** A visible call or 404 (calls of other teams are not confirmed to exist). */
  async function visibleCall(run, scope, id) {
    const row = await run.one(`${CALL_SELECT} WHERE ch.id = ?`, [id]);
    if (!row || !(scope.has(row.user_id) || scope.has(row.lead_owner) || scope.has(row.cold_owner))) throw notFound('Call not found');
    return row;
  }

  // ---- log a call ----------------------------------------------------------------------------------------------------
  for (const [type, route] of [['lead', 'leads'], ['cold_call', 'cold-calls']]) {
    const { table, column, label } = ENTITY[type];
    router.post(`/${route}/:id/call-actions`, asyncHandler(async (req, res) => {
      const actor = req.currentUser;
      const entityId = parseId(req.params.id);
      const scope = await ctx.scopeFor(req);
      const v = new Validator();
      const input = parseCallInput(bodyOf(req), v, { create: true });
      v.assert();

      const result = await db.tx(async (tx) => {
        const record = await tx.one(`SELECT * FROM \`${table}\` WHERE id = ? FOR UPDATE`, [entityId]);
        if (!record || !scope.has(record.user_id)) throw notFound(`${label} not found`);
        // the same Save sent twice (double click, retry after a network error) returns the first call, no duplicate
        if (input.requestId) {
          const dup = await tx.one('SELECT id, lead_id, cold_call_id FROM call_history WHERE user_id = ? AND request_id = ?', [actor.id, input.requestId]);
          if (dup && Number(dup[column]) === entityId) return { id: Number(dup.id), duplicate: true };
          if (dup) throw conflict('This save was already used for another record; reopen the form and save again', 'REQUEST_ID_REUSED');
        }
        const now = nowSql();

        // the outcome of the call is the record's new status (the CRM's admin-managed statuses)
        const status = pickStatus(await tx.rows('SELECT id, name FROM statuses ORDER BY id ASC'), { statusId: input.statusId });
        {
          const changes = type === 'lead'
            ? { status: status.name, statusId: status.id, status_id: status.id, isPotential: isPotentialName(status.name) ? 1 : 0, updated_at: now }
            : { status_id: status.id, updated_at: now };
          const cols = Object.keys(schema.only(table, changes));
          await tx.exec(`UPDATE \`${table}\` SET ${cols.map((c) => `\`${c}\` = ?`).join(', ')} WHERE id = ?`, [...cols.map((c) => changes[c]), entityId]);
        }

        // read-only snapshot of the lead's requirements (edited only through Edit Lead) for the call's history
        const snapshot = type === 'lead' ? (await loadRequirements(tx, [entityId])).get(entityId) ?? null : null;

        let followUpEventId = null;
        if (input.followUpAt) {
          followUpEventId = await insertRow(tx, 'calendar_events', schema.only('calendar_events', {
            title: `Follow up: ${record.name}`, type: 'follow_up', notes: input.notes ?? null, start_at: input.followUpAt,
            due_date: input.followUpAt.slice(0, 10), [column]: entityId, user_id: actor.id, created_at: now, updated_at: now,
          }));
        }

        const summary = callSummary({ ...input, outcomeName: status.name });
        const comment = {
          leadId: entityId, content: summary, body: summary, createdBy: actor.name, createdById: actor.id, createdAt: now,
          lead_id: type === 'lead' ? entityId : null, cold_call_id: type === 'cold_call' ? entityId : null,
          entity_type: type, entity_id: entityId, user_id: actor.id, created_at: now, updated_at: now,
        };
        comment.id = await insertRow(tx, 'comments', schema.only('comments', comment));
        if (schema.hasTable('reports')) await upsertReportForComment(tx, schema, comment);

        const callId = await insertRow(tx, 'call_history', schema.only('call_history', {
          [column]: entityId, user_id: actor.id, result: status.name, notes: input.notes ?? null, call_at: now,
          status_id: status.id, status_name: status.name,
          delivery: snapshot?.delivery ?? null, finishing: snapshot?.finishing ?? null, purpose: snapshot?.purpose ?? null,
          follow_up_at: input.followUpAt ?? null, follow_up_event_id: followUpEventId, comment_id: comment.id,
          request_id: input.requestId ?? null, created_at: now, updated_at: now,
        }));
        if (schema.hasTable('reports')) await refreshReportsForEntity(tx, schema, type, entityId);
        return { id: callId, duplicate: false };
      }, { tables: ['call_history', 'comments', 'calendar_events'] });

      if (!result.duplicate) {
        await audit({ userId: actor.id, entityType: 'call_history', entityId: result.id, action: 'created', summary: `Call logged on ${label.toLowerCase()} #${entityId}` });
      }
      res.status(result.duplicate ? 200 : 201).json({ ok: true, id: result.id, duplicate: result.duplicate, item: await loadCall(db, result.id) });
    }));

    // ---- timeline of one lead / cold call ----------------------------------------------------------------------------
    router.get(`/${route}/:id/activity`, asyncHandler(async (req, res) => {
      const entityId = parseId(req.params.id);
      const scope = await ctx.scopeFor(req);
      const record = await db.one(`SELECT id, user_id FROM \`${table}\` WHERE id = ?`, [entityId]);
      if (!record || !scope.has(record.user_id)) throw notFound(`${label} not found`);
      const calls = (await db.rows(`${CALL_SELECT} WHERE ch.${column} = ? ORDER BY COALESCE(ch.call_at, ch.created_at) DESC, ch.id DESC`, [entityId])).map(serializeCall);
      const commentCols = [];
      if (schema.has('comments', 'entity_type')) commentCols.push(`(comments.entity_type = '${type}' AND comments.entity_id = ?)`);
      if (schema.has('comments', column)) commentCols.push(`comments.${column} = ?`);
      if (type === 'lead' && schema.has('comments', 'leadId')) commentCols.push(`(comments.leadId = ? AND (comments.entity_type IS NULL OR comments.entity_type = 'lead'))`);
      const comments = commentCols.length
        ? (await db.rows(`SELECT comments.*, users.name AS user_name FROM comments LEFT JOIN users ON users.id = comments.user_id WHERE ${commentCols.join(' OR ')} ORDER BY comments.id DESC`, commentCols.map(() => entityId))).map(serializeComment)
        : [];
      const followUps = schema.hasTable('calendar_events') && schema.has('calendar_events', column)
        ? (await db.rows(`SELECT id, title, notes, start_at, user_id FROM calendar_events WHERE ${column} = ? ORDER BY start_at DESC`, [entityId]))
          .map((r) => ({ id: r.id, title: r.title, notes: r.notes ?? '', startAt: toIso(r.start_at), userId: r.user_id ?? null }))
        : [];
      // a call's own summary comment is already shown as the call - keep only the other comments in the timeline
      const callComments = new Set(calls.map((c) => c.commentId).filter(Boolean));
      const timeline = [
        ...calls.map((c) => ({ kind: 'call', at: c.callAt, id: `call-${c.id}`, call: c })),
        ...comments.filter((c) => !callComments.has(c.id)).map((c) => ({ kind: 'comment', at: c.createdAt, id: `comment-${c.id}`, comment: c })),
        ...followUps.map((f) => ({ kind: 'follow_up', at: f.startAt, id: `follow-${f.id}`, followUp: f })),
      ].sort((a, b) => String(b.at).localeCompare(String(a.at)));
      res.json({ calls, comments, followUps, timeline });
    }));
  }

  // ---- list ------------------------------------------------------------------------------------------------------------
  const list = asyncHandler(async (req, res) => {
    const scope = await ctx.scopeFor(req);
    const v = new Validator();
    const leadId = v.int(req.query.leadId, 'leadId', { min: 1 });
    const coldCallId = v.int(req.query.coldCallId, 'coldCallId', { min: 1 });
    const userId = v.int(req.query.userId, 'userId', { min: 1 });
    const statusId = v.int(req.query.statusId, 'statusId', { min: 1 });
    const from = v.date(req.query.from, 'from');
    const to = v.date(req.query.to, 'to');
    const limit = v.int(req.query.limit, 'limit', { min: 1, max: 2000 }) ?? 500;
    v.assert();
    const s = callScopeSql(scope);
    const conds = [s.sql];
    const params = [...s.params];
    if (leadId) { conds.push('ch.lead_id = ?'); params.push(leadId); }
    if (coldCallId) { conds.push('ch.cold_call_id = ?'); params.push(coldCallId); }
    if (userId) { conds.push('ch.user_id = ?'); params.push(userId); }
    if (statusId) { conds.push('ch.status_id = ?'); params.push(statusId); }
    if (from) { conds.push('COALESCE(ch.call_at, ch.created_at) >= ?'); params.push(`${from} 00:00:00`); }
    if (to) { conds.push('COALESCE(ch.call_at, ch.created_at) <= ?'); params.push(`${to} 23:59:59`); }
    const rows = await db.rows(`${CALL_SELECT} WHERE ${conds.join(' AND ')} ORDER BY COALESCE(ch.call_at, ch.created_at) DESC, ch.id DESC LIMIT ${limit}`, params);
    res.json(rows.map(serializeCall));
  });
  router.get('/call-actions', list);
  router.get('/call-history', list);

  router.get('/call-actions/:id', asyncHandler(async (req, res) => {
    const scope = await ctx.scopeFor(req);
    res.json(serializeCall(await visibleCall(db, scope, parseId(req.params.id))));
  }));

  // ---- correct a saved call (its author, or an administrator) ---------------------------------------------------------
  router.put('/call-actions/:id', asyncHandler(async (req, res) => {
    const actor = req.currentUser;
    const id = parseId(req.params.id);
    const scope = await ctx.scopeFor(req);
    const v = new Validator();
    const input = parseCallInput(bodyOf(req), v, { create: false });
    v.assert();
    // a saved call is history: only its notes can be corrected. The outcome changed the record's status at that time
    // (log a new call for a new outcome); the requirement snapshot is never editable.
    if (input.statusId || input.followUpAt) throw badRequest('The outcome and follow-up of a saved call cannot be changed - log a new call instead');
    await db.tx(async (tx) => {
      const row = await visibleCall(tx, scope, id);
      if (!isSuper(actor) && Number(row.user_id) !== Number(actor.id)) throw forbidden('You can only edit calls you logged yourself');
      const changes = { updated_at: nowSql() };
      if (input.notes !== undefined) changes.notes = input.notes || null;
      const filtered = schema.only('call_history', changes);
      const cols = Object.keys(filtered);
      await tx.exec(`UPDATE call_history SET ${cols.map((c) => `\`${c}\` = ?`).join(', ')} WHERE id = ?`, [...cols.map((c) => filtered[c]), id]);
      // keep the summary comment (lead history + Reports) in line with the corrected call
      if (row.comment_id) {
        const merged = { ...row, ...changes };
        const summary = callSummary({ outcomeName: merged.status_name || merged.result, followUpAt: merged.follow_up_at ? toIso(merged.follow_up_at) : null, notes: merged.notes });
        const comment = await tx.one('SELECT * FROM comments WHERE id = ?', [row.comment_id]);
        if (comment) {
          const c = schema.only('comments', { content: summary, body: summary, updated_at: nowSql() });
          const cc = Object.keys(c);
          await tx.exec(`UPDATE comments SET ${cc.map((k) => `\`${k}\` = ?`).join(', ')} WHERE id = ?`, [...cc.map((k) => c[k]), row.comment_id]);
          if (schema.hasTable('reports')) await upsertReportForComment(tx, schema, { ...comment, ...c });
        }
      }
    });
    await audit({ userId: actor.id, entityType: 'call_history', entityId: id, action: 'updated', summary: `Call #${id} corrected` });
    res.json({ ok: true, item: await loadCall(db, id) });
  }));

  return router;
}

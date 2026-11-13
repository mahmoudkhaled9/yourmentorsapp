import express from 'express';
import { asyncHandler, forbidden, notFound } from '../http/errors.js';
import { Validator, bodyOf, parseId } from '../lib/validate.js';
import { nowSql } from '../lib/dates.js';
import { isSuper, requireSuper } from '../auth/policy.js';
import { insertRow } from '../db.js';
import { serializeComment, serializeReport } from '../domain/serializers.js';
import { deleteReportForComment, rebuildReports, upsertReportForComment } from '../domain/reports.js';

const ENTITIES = { lead: 'leads', cold_call: 'cold_calls' };
const normalizeType = (raw, hasColdCall) => {
  const t = String(raw ?? (hasColdCall ? 'cold_call' : 'lead')).toLowerCase().replace(/[-\s]+/g, '_');
  return t === 'coldcall' ? 'cold_call' : t;
};

export function commentRoutes(ctx) {
  const { db, schema, audit, logger } = ctx;
  const router = express.Router();
  const hasReports = () => schema.hasTable('reports');

  /** Visible when the author is in scope OR the lead / cold call it is about is in scope. */
  router.get('/comments', asyncHandler(async (req, res) => {
    const scope = await ctx.scopeFor(req);
    let where = '1 = 1';
    let params = [];
    if (!scope.all) {
      const ids = [...scope.ids];
      const ph = ids.map(() => '?').join(', ');
      where = `(comments.user_id IN (${ph})
        OR ((comments.entity_type IS NULL OR comments.entity_type <> 'cold_call')
            AND COALESCE(comments.entity_id, comments.lead_id) IN (SELECT id FROM leads WHERE user_id IN (${ph})))
        OR (comments.entity_type = 'cold_call'
            AND COALESCE(comments.entity_id, comments.cold_call_id) IN (SELECT id FROM cold_calls WHERE user_id IN (${ph}))))`;
      params = [...ids, ...ids, ...ids];
    }
    const rows = await db.rows(`SELECT comments.*, users.name AS user_name FROM comments LEFT JOIN users ON users.id = comments.user_id WHERE ${where} ORDER BY comments.id ASC`, params);
    res.json(rows.map(serializeComment));
  }));

  router.post('/comments', asyncHandler(async (req, res) => {
    const actor = req.currentUser;
    const scope = await ctx.scopeFor(req);
    const body = bodyOf(req);
    const v = new Validator();
    const type = v.oneOf(normalizeType(body.entityType, Boolean(body.coldCallId)), 'entityType', Object.keys(ENTITIES), { required: true });
    const entityId = v.int(body.entityId ?? body.leadId ?? body.coldCallId, 'entityId', { required: true, min: 1 });
    const content = v.string(body.content ?? body.body, 'content', { required: true, max: 5000 });
    v.assert();
    const created = await db.tx(async (tx) => {
      const target = await tx.one(`SELECT id, user_id FROM \`${ENTITIES[type]}\` WHERE id = ?`, [entityId]);
      if (!target || !scope.has(target.user_id)) throw notFound(type === 'lead' ? 'Lead not found' : 'Cold call not found');
      const now = nowSql();
      // The author is ALWAYS the signed-in user; createdBy / createdById in the body are ignored (they allowed impersonation).
      const row = {
        leadId: entityId, content, body: content, createdBy: actor.name, createdById: actor.id, createdAt: now,
        lead_id: type === 'lead' ? entityId : null, cold_call_id: type === 'cold_call' ? entityId : null,
        entity_type: type, entity_id: entityId, user_id: actor.id, created_at: now, updated_at: now,
      };
      const id = await insertRow(tx, 'comments', schema.only('comments', row));
      const comment = { id, ...row };
      if (hasReports()) await upsertReportForComment(tx, schema, comment);
      return comment;
    }, { tables: ['comments'] });
    await audit({ userId: actor.id, entityType: 'comments', entityId: created.id, action: 'created', summary: `Comment added on ${type.replace('_', ' ')} #${entityId}` });
    res.json({ ok: true, id: created.id, item: serializeComment({ ...created, user_name: actor.name }) });
  }));

  router.put('/comments/:id', asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const actor = req.currentUser;
    const v = new Validator();
    const body = bodyOf(req);
    const content = v.string(body.content ?? body.body, 'content', { required: true, max: 5000 });
    v.assert();
    const updated = await db.tx(async (tx) => {
      const existing = await tx.one('SELECT * FROM comments WHERE id = ? FOR UPDATE', [id]);
      if (!existing) throw notFound('Comment not found');
      if (!isSuper(actor) && Number(existing.user_id) !== Number(actor.id)) throw forbidden('You can only edit your own comments');
      const changes = schema.only('comments', { content, body: content, updated_at: nowSql() });
      const cols = Object.keys(changes);
      await tx.exec(`UPDATE comments SET ${cols.map((c) => `\`${c}\` = ?`).join(', ')} WHERE id = ?`, [...cols.map((c) => changes[c]), id]);
      const fresh = { ...existing, ...changes };
      if (hasReports()) await upsertReportForComment(tx, schema, fresh);
      return fresh;
    });
    const author = await db.one('SELECT name FROM users WHERE id = ?', [updated.user_id]);
    await audit({ userId: actor.id, entityType: 'comments', entityId: id, action: 'updated', summary: `Comment edited: #${id}` });
    res.json({ ok: true, item: serializeComment({ ...updated, user_name: author?.name }) });
  }));

  router.delete('/comments/:id', asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const actor = req.currentUser;
    const removed = await db.tx(async (tx) => {
      const existing = await tx.one('SELECT * FROM comments WHERE id = ? FOR UPDATE', [id]);
      if (!existing) throw notFound('Comment not found');
      if (!isSuper(actor) && Number(existing.user_id) !== Number(actor.id)) throw forbidden('You can only delete your own comments');
      await tx.exec('DELETE FROM comments WHERE id = ?', [id]);
      if (hasReports()) await deleteReportForComment(tx, id);
      return existing;
    });
    await audit({ userId: actor.id, entityType: 'comments', entityId: id, action: 'deleted', summary: `Comment deleted: #${id}`, metadata: { entity_type: removed.entity_type, entity_id: removed.entity_id } });
    res.json({ ok: true });
  }));

  router.get('/reports', asyncHandler(async (req, res) => {
    const scope = await ctx.scopeFor(req);
    const f = scope.sqlIn('reports.agent_id');
    const rows = await db.rows(`SELECT reports.* FROM reports WHERE ${f.sql} ORDER BY reports.created_at DESC, reports.id DESC`, f.params);
    res.json(rows.map(serializeReport));
  }));

  router.post('/admin/rebuild-reports', asyncHandler(async (req, res) => {
    requireSuper(req.currentUser);
    const started = Date.now();
    const count = await rebuildReports(db, schema);
    logger.info('reports rebuilt', { count, ms: Date.now() - started });
    res.json({ ok: true, count });
  }));

  return router;
}

import express from 'express';
import { asyncHandler, badRequest, forbidden, notFound } from '../http/errors.js';
import { Validator, bodyOf, parseId } from '../lib/validate.js';
import { nowSql } from '../lib/dates.js';
import { isSuper, requireAssigner } from '../auth/policy.js';
import { insertRow } from '../db.js';
import { inClause, teamLeaderFor, userBrief } from '../domain/lookups.js';
import { refreshReportsForEntity } from '../domain/reports.js';
import { EMPTY_REQUIREMENTS, deleteRequirements, loadRequirements, parseRequirements, requirementFilters, saveRequirements } from '../domain/requirements.js';

/**
 * Shared CRUD for lead-like records that belong to a user (leads, cold calls). Enforced here, not in the UI:
 *  - a user sees/edits/deletes only records owned by someone in their own subtree (admins: everything);
 *  - changing the owner needs an "assigner" role and a target inside the actor's subtree;
 *  - records created without an owner are owned by their creator (admins may leave them unassigned).
 * Records outside the caller's scope answer 404 (not 403), so ids of other people's records are not confirmed.
 */
export function recordRoutes(ctx, spec) {
  const { db, schema, audit } = ctx;
  const { route, table, entity, label } = spec;
  const router = express.Router();
  const withReq = spec.hasRequirements;

  async function attachRequirements(run, items) {
    if (!withReq || !items.length) return items;
    const map = await loadRequirements(run, items.map((i) => i.id));
    return items.map((i) => ({ ...i, requirements: map.get(Number(i.id)) ?? { ...EMPTY_REQUIREMENTS, destinationIds: [], propertyTypeIds: [] } }));
  }
  const loadOne = async (run, id) => (await attachRequirements(run, [spec.serialize(await run.one(`${spec.selectSql()} WHERE ${table}.id = ?`, [id]))]))[0];

  async function resolveAssignee(run, req, scope, targetId) {
    const target = await userBrief(run, targetId);
    if (!target) throw badRequest('The selected user does not exist', [{ field: 'assignedToId', message: 'does not exist' }]);
    if (Number(target.status ?? 1) !== 1) throw badRequest('The selected user is not active', [{ field: 'assignedToId', message: 'is not active' }]);
    if (!isSuper(req.currentUser) && !scope.has(Number(target.id))) throw forbidden('You can only assign to people in your own team');
    return target;
  }
  const invisible = () => notFound(`${label} not found`);

  router.get(`/${route}`, asyncHandler(async (req, res) => {
    const scope = await ctx.scopeFor(req);
    const f = scope.sqlIn(`${table}.user_id`);
    let where = f.sql;
    let params = f.params;
    if (withReq) {
      const v = new Validator();
      const extra = requirementFilters(req.query, v);
      v.assert();
      if (extra.sql) { where += ` AND ${extra.sql}`; params = [...params, ...extra.params]; }
    }
    const rows = await db.rows(`${spec.selectSql()} WHERE ${where} ORDER BY ${table}.id ASC`, params);
    res.json(await attachRequirements(db, rows.map(spec.serialize)));
  }));

  router.get(`/${route}/:id`, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const scope = await ctx.scopeFor(req);
    const stored = await db.one(`SELECT id, user_id FROM \`${table}\` WHERE id = ?`, [id]);
    if (!stored || !scope.has(stored.user_id)) throw invisible();
    res.json(await loadOne(db, id));
  }));

  router.post(`/${route}`, asyncHandler(async (req, res) => {
    const actor = req.currentUser;
    const scope = await ctx.scopeFor(req);
    const body = bodyOf(req);
    const v = new Validator();
    const input = spec.parse(body, v, null);
    const requirements = withReq ? parseRequirements(body.requirements, v) : undefined;
    v.assert();

    const id = await db.tx(async (tx) => {
      let owner = null;
      if (input.assignedToId && Number(input.assignedToId) !== Number(actor.id)) {
        requireAssigner(actor, 'You are not allowed to assign records to other users');
        owner = await resolveAssignee(tx, req, scope, input.assignedToId);
      } else if (input.assignedToId || !isSuper(actor)) {
        owner = await userBrief(tx, actor.id);
      }
      const teamLeader = await teamLeaderFor(tx, owner);
      const refs = await spec.resolveRefs(tx, input, null);
      const row = spec.buildRow({ input, refs, owner, teamLeader, existing: null, now: nowSql(), ownerChanged: true });
      const newId = await insertRow(tx, table, schema.only(table, row));
      if (requirements) await saveRequirements(tx, newId, requirements);
      return newId;
    }, { tables: [table] });

    await audit({ userId: actor.id, entityType: table, entityId: id, action: 'created', summary: `${label} created: ${input.name}` });
    res.json({ ok: true, id, item: await loadOne(db, id) });
  }));

  const update = asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const actor = req.currentUser;
    const scope = await ctx.scopeFor(req);
    const body = bodyOf(req);

    await db.tx(async (tx) => {
      const existing = await tx.one(`SELECT * FROM \`${table}\` WHERE id = ? FOR UPDATE`, [id]);
      if (!existing || !scope.has(existing.user_id)) throw invisible();
      const v = new Validator();
      const input = spec.parse(body, v, existing);
      const requirements = withReq ? parseRequirements(body.requirements, v) : undefined;
      v.assert();

      let owner = null; let teamLeader = null; let ownerChanged = false;
      if (input.assignedProvided && Number(input.assignedToId ?? 0) !== Number(existing.user_id ?? 0)) {
        requireAssigner(actor, 'You are not allowed to reassign records');
        if (input.assignedToId) {
          owner = await resolveAssignee(tx, req, scope, input.assignedToId);
          teamLeader = await teamLeaderFor(tx, owner);
        } else if (!isSuper(actor)) {
          throw forbidden('Only administrators can unassign a record');
        }
        ownerChanged = true;
      }
      const refs = await spec.resolveRefs(tx, input, existing);
      const row = spec.buildRow({ input, refs, owner, teamLeader, existing, now: nowSql(), ownerChanged });
      const filtered = schema.only(table, row);
      const cols = Object.keys(filtered);
      await tx.exec(`UPDATE \`${table}\` SET ${cols.map((c) => `\`${c}\` = ?`).join(', ')} WHERE id = ?`, [...cols.map((c) => filtered[c]), id]);
      if (requirements !== undefined) await saveRequirements(tx, id, requirements);
      if (schema.hasTable('reports')) await refreshReportsForEntity(tx, schema, entity, id);
    });

    await audit({ userId: actor.id, entityType: table, entityId: id, action: 'updated', summary: `${label} updated: #${id}`, metadata: { fields: Object.keys(body) } });
    res.json({ ok: true, item: await loadOne(db, id) });
  });
  router.put(`/${route}/:id`, update);
  router.patch(`/${route}/:id`, update);

  router.delete(`/${route}/:id`, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const scope = await ctx.scopeFor(req);
    const removed = await db.tx(async (tx) => {
      const existing = await tx.one(`SELECT * FROM \`${table}\` WHERE id = ? FOR UPDATE`, [id]);
      if (!existing || !scope.has(existing.user_id)) throw invisible();
      await tx.exec(`DELETE FROM \`${table}\` WHERE id = ?`, [id]);
      if (withReq) await deleteRequirements(tx, [id]);
      return existing;
    });
    await audit({ userId: req.currentUser.id, entityType: table, entityId: id, action: 'deleted', summary: `${label} deleted: ${removed.name ?? id}`, metadata: spec.snapshot(removed) });
    res.json({ ok: true });
  }));

  /** Loads the requested ids and verifies every one exists and is visible; all-or-nothing. */
  async function loadVisible(run, scope, ids) {
    const q = inClause(ids);
    const rows = await run.rows(`SELECT id, user_id, name FROM \`${table}\` WHERE id IN (${q.sql}) FOR UPDATE`, q.params);
    const found = new Set(rows.filter((r) => scope.has(r.user_id)).map((r) => Number(r.id)));
    const missing = ids.filter((i) => !found.has(i));
    if (missing.length) throw notFound(`${missing.length} of the selected ${label.toLowerCase()}s were not found or are not accessible`);
    return rows;
  }

  router.post(`/${route}/bulk-assign`, asyncHandler(async (req, res) => {
    const actor = req.currentUser;
    requireAssigner(actor, 'You are not allowed to assign records to other users');
    const scope = await ctx.scopeFor(req);
    const body = bodyOf(req);
    const v = new Validator();
    const ids = v.intList(body.ids, 'ids');
    const assignedToId = v.int(body.assignedToId, 'assignedToId', { required: true, min: 1 });
    v.assert();
    const count = await db.tx(async (tx) => {
      const owner = await resolveAssignee(tx, req, scope, assignedToId);
      const teamLeader = await teamLeaderFor(tx, owner);
      await loadVisible(tx, scope, ids);
      const set = schema.only(table, {
        user_id: owner.id, assignedToId: owner.id, assignedTo: owner.name,
        teamLeaderId: teamLeader?.id ?? null, teamLeader: teamLeader?.name ?? null, updated_at: nowSql(),
      });
      const cols = Object.keys(set);
      const q = inClause(ids);
      await tx.exec(`UPDATE \`${table}\` SET ${cols.map((c) => `\`${c}\` = ?`).join(', ')} WHERE id IN (${q.sql})`, [...cols.map((c) => set[c]), ...q.params]);
      return ids.length;
    });
    await audit({ userId: actor.id, entityType: table, action: 'bulk_assigned', summary: `${count} ${label.toLowerCase()}(s) assigned to user #${assignedToId}`, metadata: { ids: ids.slice(0, 100), assignedToId } });
    res.json({ ok: true, count });
  }));

  router.post(`/${route}/bulk-delete`, asyncHandler(async (req, res) => {
    const scope = await ctx.scopeFor(req);
    const v = new Validator();
    const ids = v.intList(bodyOf(req).ids, 'ids');
    v.assert();
    const count = await db.tx(async (tx) => {
      await loadVisible(tx, scope, ids);
      const q = inClause(ids);
      await tx.exec(`DELETE FROM \`${table}\` WHERE id IN (${q.sql})`, q.params);
      if (withReq) await deleteRequirements(tx, ids);
      return ids.length;
    });
    await audit({ userId: req.currentUser.id, entityType: table, action: 'bulk_deleted', summary: `${count} ${label.toLowerCase()}(s) deleted`, metadata: { ids: ids.slice(0, 100) } });
    res.json({ ok: true, count });
  }));

  return router;
}

import express from 'express';
import { asyncHandler, forbidden, notFound } from '../http/errors.js';
import { Validator, bodyOf, parseId } from '../lib/validate.js';
import { nowSql, toDateOnly, toIso } from '../lib/dates.js';
import { isSuper } from '../auth/policy.js';
import { insertRow } from '../db.js';
import { redact } from '../domain/audit.js';

/**
 * Secondary resources (API only - the current UI does not use them): tasks, calendar events, call history, pipeline,
 * knowledge base, notifications, plus the activity log. Owner-scoped like the main records; knowledge base is
 * read-by-all / write-by-admin; notifications are private to their owner.
 */
const parseJson = (value) => {
  if (value === null || value === undefined || value === '') return null;
  try { return JSON.parse(value); } catch { return null; }
};

const RESOURCES = [
  {
    route: 'tasks', table: 'tasks', owner: 'assigned_to_id', order: 'COALESCE(due_date, created_at) DESC',
    fields: [['title', 'string', { required: true, max: 255 }], ['status', 'string', { max: 100, def: 'Open' }], ['priority', 'string', { max: 50, def: 'Normal' }],
      ['dueDate', 'date', { col: 'due_date' }], ['assignedToId', 'int', { col: 'assigned_to_id', owner: true }], ['leadId', 'int', { col: 'lead_id' }], ['notes', 'string', { max: 5000 }]],
    serialize: (r) => ({ id: r.id, title: r.title, status: r.status ?? '', priority: r.priority ?? '', dueDate: toDateOnly(r.due_date), assignedToId: r.assigned_to_id ?? null, leadId: r.lead_id ?? null, notes: r.notes ?? '' }),
  },
  {
    route: 'calendar-events', table: 'calendar_events', owner: 'user_id', order: 'COALESCE(start_at, due_date, created_at) ASC',
    fields: [['title', 'string', { required: true, max: 255 }], ['type', 'string', { max: 100 }], ['notes', 'string', { max: 5000 }],
      ['startAt', 'datetime', { col: 'start_at' }], ['endAt', 'datetime', { col: 'end_at' }], ['dueDate', 'date', { col: 'due_date' }],
      ['leadId', 'int', { col: 'lead_id' }], ['coldCallId', 'int', { col: 'cold_call_id' }], ['dealId', 'int', { col: 'deal_id' }], ['userId', 'int', { col: 'user_id', owner: true }]],
    serialize: (r) => ({ id: r.id, title: r.title, type: r.type ?? '', notes: r.notes ?? '', startAt: toIso(r.start_at), endAt: toIso(r.end_at), dueDate: toDateOnly(r.due_date), leadId: r.lead_id ?? null, coldCallId: r.cold_call_id ?? null, dealId: r.deal_id ?? null, userId: r.user_id ?? null }),
  },
  {
    route: 'call-history', table: 'call_history', owner: 'user_id', order: 'COALESCE(call_at, created_at) DESC',
    fields: [['leadId', 'int', { col: 'lead_id' }], ['coldCallId', 'int', { col: 'cold_call_id' }], ['userId', 'int', { col: 'user_id', owner: true }],
      ['result', 'string', { max: 100 }], ['notes', 'string', { max: 5000 }], ['callAt', 'datetime', { col: 'call_at' }]],
    serialize: (r) => ({ id: r.id, leadId: r.lead_id ?? null, coldCallId: r.cold_call_id ?? null, userId: r.user_id ?? null, result: r.result ?? '', notes: r.notes ?? '', callAt: toIso(r.call_at) }),
  },
  {
    route: 'pipeline', table: 'pipeline', owner: 'owner_id', order: 'id DESC',
    fields: [['title', 'string', { required: true, max: 255 }], ['stage', 'string', { max: 100 }], ['value', 'money', { max: 9999999999.99 }],
      ['ownerId', 'int', { col: 'owner_id', owner: true }], ['leadId', 'int', { col: 'lead_id' }], ['dealId', 'int', { col: 'deal_id' }], ['notes', 'string', { max: 5000 }]],
    serialize: (r) => ({ id: r.id, title: r.title, stage: r.stage ?? '', value: Number(r.value ?? 0), ownerId: r.owner_id ?? null, leadId: r.lead_id ?? null, dealId: r.deal_id ?? null, notes: r.notes ?? '' }),
  },
  {
    route: 'knowledge-base', table: 'knowledge_base', owner: null, order: 'id DESC', adminWrite: true,
    fields: [['title', 'string', { required: true, max: 255 }], ['category', 'string', { max: 100 }], ['content', 'string', { max: 100000 }],
      ['projectId', 'int', { col: 'project_id' }], ['developerId', 'int', { col: 'developer_id' }], ['priceRange', 'string', { col: 'price_range', max: 100 }],
      ['paymentPlan', 'string', { col: 'payment_plan', max: 255 }], ['deliveryDate', 'string', { col: 'delivery_date', max: 50 }]],
    serialize: (r) => ({ id: r.id, title: r.title, category: r.category ?? '', content: r.content ?? '', projectId: r.project_id ?? null, developerId: r.developer_id ?? null, priceRange: r.price_range ?? '', paymentPlan: r.payment_plan ?? '', deliveryDate: r.delivery_date ?? '' }),
  },
  {
    route: 'notifications', table: 'notifications', owner: 'user_id', order: 'id DESC', private: true,
    fields: [['userId', 'int', { col: 'user_id', owner: true }], ['title', 'string', { required: true, max: 255 }], ['body', 'string', { max: 5000 }], ['isRead', 'bool', { col: 'is_read' }]],
    serialize: (r) => ({ id: r.id, userId: r.user_id ?? null, title: r.title, body: r.body ?? '', isRead: Number(r.is_read ?? 0) === 1, createdAt: toIso(r.created_at) }),
  },
];

export function miscRoutes(ctx) {
  const { db, schema, audit } = ctx;
  const router = express.Router();

  for (const def of RESOURCES) {
    const { route, table, owner } = def;

    function parse(body, mode) {
      const v = new Validator();
      const out = {};
      let ownerValue;
      for (const [name, type, opts] of def.fields) {
        const raw = body[name];
        let value;
        if (type === 'string') value = v.string(raw, name, { required: mode === 'create' && opts.required, max: opts.max ?? 255 });
        else if (type === 'int') value = v.int(raw, name, { min: 1 });
        else if (type === 'money') value = v.money(raw, name, { max: opts.max });
        else if (type === 'date') value = v.date(raw, name);
        else if (type === 'datetime') value = v.datetime(raw, name);
        else if (type === 'bool') { const b = v.bool(raw); value = b === undefined ? undefined : b ? 1 : 0; }
        if (opts.owner) { ownerValue = value; continue; }
        const col = opts.col ?? name;
        if (value !== undefined) out[col] = value;
        else if (mode === 'create' && opts.def !== undefined) out[col] = opts.def;
      }
      v.assert();
      return { values: out, ownerValue };
    }
    const canSee = (scope, actor, row) => {
      if (!owner) return true;
      if (def.private) return Number(row[owner]) === Number(actor.id);
      return scope.has(row[owner]);
    };

    router.get(`/${route}`, asyncHandler(async (req, res) => {
      const scope = await ctx.scopeFor(req);
      const f = !owner ? { sql: '1 = 1', params: [] } : def.private ? { sql: `${owner} = ?`, params: [req.currentUser.id] } : scope.sqlIn(owner);
      res.json((await db.rows(`SELECT * FROM \`${table}\` WHERE ${f.sql} ORDER BY ${def.order}`, f.params)).map(def.serialize));
    }));

    router.post(`/${route}`, asyncHandler(async (req, res) => {
      const actor = req.currentUser;
      if (def.adminWrite && !isSuper(actor)) throw forbidden('Only administrators can change this');
      const scope = await ctx.scopeFor(req);
      const { values, ownerValue } = parse(bodyOf(req), 'create');
      if (owner) {
        const target = ownerValue ?? actor.id;
        if (Number(target) !== Number(actor.id) && (def.private ? !isSuper(actor) : !scope.has(target))) throw forbidden('You can only create items for yourself or your team');
        values[owner] = target;
      }
      const now = nowSql();
      const id = await db.tx((tx) => insertRow(tx, table, schema.only(table, { ...values, created_at: now, updated_at: now })), { tables: [table] });
      await audit({ userId: actor.id, entityType: table, entityId: id, action: 'created', summary: `${route} item created` });
      res.json({ ok: true, id, item: def.serialize(await db.one(`SELECT * FROM \`${table}\` WHERE id = ?`, [id])) });
    }));

    router.put(`/${route}/:id`, asyncHandler(async (req, res) => {
      const actor = req.currentUser;
      if (def.adminWrite && !isSuper(actor)) throw forbidden('Only administrators can change this');
      const id = parseId(req.params.id);
      const scope = await ctx.scopeFor(req);
      const { values, ownerValue } = parse(bodyOf(req), 'update');
      await db.tx(async (tx) => {
        const existing = await tx.one(`SELECT * FROM \`${table}\` WHERE id = ? FOR UPDATE`, [id]);
        if (!existing || !canSee(scope, actor, existing)) throw notFound('Not found');
        if (owner && ownerValue !== undefined && Number(ownerValue) !== Number(existing[owner])) {
          if (def.private || !scope.has(ownerValue)) throw forbidden('You cannot hand this item to that user');
          values[owner] = ownerValue;
        }
        const changes = schema.only(table, { ...values, updated_at: nowSql() });
        const cols = Object.keys(changes);
        await tx.exec(`UPDATE \`${table}\` SET ${cols.map((c) => `\`${c}\` = ?`).join(', ')} WHERE id = ?`, [...cols.map((c) => changes[c]), id]);
      });
      res.json({ ok: true, item: def.serialize(await db.one(`SELECT * FROM \`${table}\` WHERE id = ?`, [id])) });
    }));

    router.delete(`/${route}/:id`, asyncHandler(async (req, res) => {
      const actor = req.currentUser;
      if (def.adminWrite && !isSuper(actor)) throw forbidden('Only administrators can change this');
      const id = parseId(req.params.id);
      const scope = await ctx.scopeFor(req);
      await db.tx(async (tx) => {
        const existing = await tx.one(`SELECT * FROM \`${table}\` WHERE id = ? FOR UPDATE`, [id]);
        if (!existing || !canSee(scope, actor, existing)) throw notFound('Not found');
        await tx.exec(`DELETE FROM \`${table}\` WHERE id = ?`, [id]);
      });
      await audit({ userId: actor.id, entityType: table, entityId: id, action: 'deleted', summary: `${route} item deleted` });
      res.json({ ok: true });
    }));
  }

  /** Audit trail. Paged (default 200, max 1000); secrets that old rows may contain are redacted on the way out. */
  router.get('/activity-logs', asyncHandler(async (req, res) => {
    const scope = await ctx.scopeFor(req);
    const limit = Math.min(1000, Math.max(1, Number.parseInt(req.query.limit, 10) || 200));
    const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
    const f = scope.sqlIn('activity_logs.user_id');
    const rows = await db.rows(
      `SELECT activity_logs.*, users.name AS user_name FROM activity_logs LEFT JOIN users ON users.id = activity_logs.user_id
       WHERE ${f.sql} ORDER BY activity_logs.id DESC LIMIT ${limit} OFFSET ${offset}`, f.params);
    res.json(rows.map((r) => ({
      id: r.id, userId: r.user_id ?? null, userName: r.user_name ?? '', entityType: r.entity_type ?? '', entityId: r.entity_id ?? null,
      action: r.action ?? '', summary: r.summary ?? '', metadata: redact(parseJson(r.metadata)), createdAt: toIso(r.created_at),
    })));
  }));

  return router;
}

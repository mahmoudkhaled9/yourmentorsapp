import express from 'express';
import { asyncHandler, badRequest, notFound } from '../http/errors.js';
import { Validator, bodyOf, parseId } from '../lib/validate.js';
import { nowSql, todayUtc } from '../lib/dates.js';
import { requireSuper } from '../auth/policy.js';
import { insertRow } from '../db.js';
import { serializeDeal } from '../domain/serializers.js';

const MAX_ATTACHMENT_JSON = 22 * 1024 * 1024;
const DEAL_STATUSES = ['pending', 'approved', 'closed', 'cancelled', 'rejected'];

/** Deals: every signed-in user reads the deals of their scope; only administrators create, edit and delete them. */
export function dealRoutes(ctx) {
  const { db, schema, audit } = ctx;
  const router = express.Router();

  const selectSql = () => {
    const projectId = schema.coalesce('deals', ['project_id', 'projectId']);
    const developerId = schema.coalesce('deals', ['developer_id', 'developerId']);
    return `SELECT deals.*, projects.name AS project_name, developers.name AS developer_name, users.name AS user_name
       FROM deals
       LEFT JOIN projects ON projects.id = ${projectId}
       LEFT JOIN developers ON developers.id = ${developerId}
       LEFT JOIN users ON users.id = deals.user_id`;
  };
  const loadOne = async (run, id) => serializeDeal(await run.one(`${selectSql()} WHERE deals.id = ?`, [id]));

  router.get('/deals', asyncHandler(async (req, res) => {
    const scope = await ctx.scopeFor(req);
    const f = scope.sqlIn('deals.user_id');
    res.json((await db.rows(`${selectSql()} WHERE ${f.sql} ORDER BY deals.id ASC`, f.params)).map(serializeDeal));
  }));

  function parse(body, v, existing) {
    const list = (value, field) => {
      if (value === undefined || value === null) return undefined;
      if (!Array.isArray(value) || value.length > 50) return v.fail(field, 'must be a list with at most 50 items');
      for (const item of value) {
        if (!item || typeof item !== 'object' || typeof item.name !== 'string') return v.fail(field, 'every item needs a name');
        const data = item.dataUrl ?? item.data ?? item.url;
        if (typeof data !== 'string' || !/^(data:[\w.+-]+\/[\w.+-]+;base64,|https?:\/\/)/.test(data)) return v.fail(field, 'every item needs a file (data URL) or an http(s) link');
        // files that a browser would execute when opened are refused (stored XSS through an attachment link)
        if (/^data:(text\/html|image\/svg\+xml|application\/(xhtml\+xml|javascript|x-javascript)|text\/javascript|text\/xml|application\/xml)/i.test(data)) {
          return v.fail(field, 'HTML, SVG, XML and script files cannot be attached');
        }
      }
      return value;
    };
    const status = v.string(body.status, 'status', { max: 50 });
    if (status && !DEAL_STATUSES.includes(status.toLowerCase())) v.fail('status', `must be one of: ${DEAL_STATUSES.join(', ')}`);
    const parsed = {
      leadId: v.int(body.leadId, 'leadId', { min: 0 }),
      leadName: v.string(body.leadName, 'leadName', { max: 255 }),
      clientPhone: v.clientPhone(body.clientPhone, 'clientPhone', { keep: existing?.clientPhone ?? existing?.client_phone }),
      agentId: v.int(body.agentId, 'agentId', { min: 1 }),
      projectId: v.int(body.projectId, 'projectId', { min: 0 }),
      developerId: v.int(body.developerId, 'developerId', { min: 0 }),
      brokerId: v.int(body.brokerId, 'brokerId', { min: 0 }),
      amount: v.money(body.amount, 'amount'),
      contractPrice: v.money(body.contractPrice, 'contractPrice'),
      reservationPrice: v.money(body.reservationPrice, 'reservationPrice'),
      commission: v.money(body.commission, 'commission'),
      status: status ? status.toLowerCase() : undefined,
      stage: v.string(body.stage, 'stage', { max: 50 }),
      reservationDate: v.date(body.reservationDate, 'reservationDate'),
      contractDate: v.date(body.contractDate, 'contractDate'),
      date: v.date(body.date, 'date'),
      unitNumber: v.string(body.unitNumber, 'unitNumber', { max: 100 }),
      notes: v.string(body.notes ?? body.comment, 'notes', { max: 5000 }),
      attachments: list(body.attachments, 'attachments'),
      reservationImages: list(body.reservationImages ?? body.reservationsImages, 'reservationImages'),
    };
    if (JSON.stringify([parsed.attachments ?? [], parsed.reservationImages ?? []]).length > MAX_ATTACHMENT_JSON) v.fail('attachments', 'are too large');
    if (parsed.commission !== undefined && (parsed.contractPrice ?? parsed.amount) !== undefined && parsed.commission > (parsed.contractPrice ?? parsed.amount)) {
      v.fail('commission', 'cannot be higher than the deal amount');
    }
    return parsed;
  }

  async function nameById(tx, table, id) {
    if (!id) return 'Unknown';
    const row = await tx.one(`SELECT name FROM \`${table}\` WHERE id = ?`, [id]);
    if (!row) throw badRequest(`Unknown ${table.replace(/s$/, '')}`, [{ field: `${table.replace(/s$/, '')}Id`, message: 'does not exist' }]);
    return row.name;
  }

  /** `d` is a complete deal in the client's shape; produces every column (canonical + legacy mirrors). */
  async function buildRow(tx, d, { id, now, create }) {
    const agent = d.agentId ? await tx.one('SELECT id, name FROM users WHERE id = ?', [d.agentId]) : null;
    if (d.agentId && !agent) throw badRequest('Unknown agent', [{ field: 'agentId', message: 'does not exist' }]);
    if (d.brokerId && !(await tx.one('SELECT id FROM brokers WHERE id = ?', [d.brokerId]))) throw badRequest('Unknown broker', [{ field: 'brokerId', message: 'does not exist' }]);
    const agentName = agent?.name ?? 'Unknown';
    const projectName = await nameById(tx, 'projects', d.projectId);
    const developerName = await nameById(tx, 'developers', d.developerId);
    const price = d.contractPrice || d.amount || 0;
    const leadId = d.leadId || id || 0;
    const row = {
      leadId, lead_id: leadId || null, leadName: d.leadName, lead_name: d.leadName, name: d.leadName,
      clientPhone: d.clientPhone || null, client_phone: d.clientPhone || null, phone: d.clientPhone || '',
      agentId: d.agentId ?? 0, agent_id: d.agentId ?? null, agentName, agent_name: agentName,
      projectId: d.projectId ?? 0, project_id: d.projectId || null, projectName, project_name: projectName,
      developerId: d.developerId ?? 0, developer_id: d.developerId || null, developerName, developer_name: developerName,
      brokerId: d.brokerId || null, broker_id: d.brokerId || null,
      attachments: JSON.stringify(d.attachments ?? []), reservations_images: JSON.stringify(d.reservationImages ?? []),
      reservationPrice: d.reservationPrice ?? null, reservation_price: d.reservationPrice ?? null,
      reservationDate: d.reservationDate ?? null, reservation_date: d.reservationDate ?? null,
      contractPrice: d.contractPrice ?? null, price: price || null, amount: price,
      contractDate: d.contractDate ?? null, contract_date: d.contractDate ?? null,
      unitNumber: d.unitNumber ?? null, unit_number: d.unitNumber ?? null,
      commission: d.commission ?? 0, stage: d.stage ?? null, notes: d.notes ?? null, comment: d.notes ?? null,
      status: d.status ?? 'pending', user_id: d.agentId ?? null, date: d.date ?? d.contractDate ?? todayUtc(), updated_at: now,
    };
    if (create) { row.createdAt = now; row.created_at = now; }
    return row;
  }

  router.post('/deals', asyncHandler(async (req, res) => {
    requireSuper(req.currentUser, 'Only administrators can create deals');
    const v = new Validator();
    const parsed = parse(bodyOf(req), v, null);
    if (!parsed.leadName) v.fail('leadName', 'is required');
    v.assert();
    parsed.agentId ??= req.currentUser.id;
    const id = await db.tx(async (tx) => {
      const row = await buildRow(tx, parsed, { id: 0, now: nowSql(), create: true });
      const newId = await insertRow(tx, 'deals', schema.only('deals', row));
      if (!parsed.leadId) {
        const fix = schema.only('deals', { leadId: newId, lead_id: newId });
        const cols = Object.keys(fix);
        if (cols.length) await tx.exec(`UPDATE deals SET ${cols.map((c) => `\`${c}\` = ?`).join(', ')} WHERE id = ?`, [...cols.map((c) => fix[c]), newId]);
      }
      return newId;
    }, { tables: ['deals'] });
    await audit({ userId: req.currentUser.id, entityType: 'deals', entityId: id, action: 'created', summary: `Deal created: ${parsed.leadName}` });
    res.json({ ok: true, id, item: await loadOne(db, id) });
  }));

  router.put('/deals/:id', asyncHandler(async (req, res) => {
    requireSuper(req.currentUser, 'Only administrators can edit deals');
    const id = parseId(req.params.id);
    const body = bodyOf(req);
    await db.tx(async (tx) => {
      const existing = await tx.one('SELECT * FROM deals WHERE id = ? FOR UPDATE', [id]);
      if (!existing) throw notFound('Deal not found');
      const v = new Validator();
      const parsed = parse(body, v, existing);
      v.assert();
      const merged = { ...serializeDeal(existing) };
      merged.agentId = existing.user_id ?? existing.agent_id ?? existing.agentId ?? null;
      for (const [key, value] of Object.entries(parsed)) if (value !== undefined) merged[key] = value;
      const row = await buildRow(tx, merged, { id, now: nowSql(), create: false });
      const filtered = schema.only('deals', row);
      const cols = Object.keys(filtered);
      await tx.exec(`UPDATE deals SET ${cols.map((c) => `\`${c}\` = ?`).join(', ')} WHERE id = ?`, [...cols.map((c) => filtered[c]), id]);
    });
    await audit({ userId: req.currentUser.id, entityType: 'deals', entityId: id, action: 'updated', summary: `Deal updated: #${id}`, metadata: { fields: Object.keys(body) } });
    res.json({ ok: true, item: await loadOne(db, id) });
  }));

  router.delete('/deals/:id', asyncHandler(async (req, res) => {
    requireSuper(req.currentUser, 'Only administrators can delete deals');
    const id = parseId(req.params.id);
    const existing = await db.one('SELECT * FROM deals WHERE id = ?', [id]);
    if (!existing) throw notFound('Deal not found');
    await db.exec('DELETE FROM deals WHERE id = ?', [id]);
    await audit({ userId: req.currentUser.id, entityType: 'deals', entityId: id, action: 'deleted', summary: `Deal deleted: ${existing.leadName ?? existing.lead_name ?? id}`, metadata: { id, leadName: existing.leadName ?? existing.lead_name, amount: existing.amount ?? existing.price } });
    res.json({ ok: true });
  }));

  return router;
}

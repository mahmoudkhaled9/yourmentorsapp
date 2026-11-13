import express from 'express';
import { asyncHandler, badRequest, conflict, notFound } from '../http/errors.js';
import { Validator, bodyOf, parseId } from '../lib/validate.js';
import { nowSql } from '../lib/dates.js';
import { requireSuper } from '../auth/policy.js';
import { insertRow } from '../db.js';
import { serializeDeveloper } from '../domain/serializers.js';
import { DELIVERY_OPTIONS, FINISHING_OPTIONS, OPTION_LABELS, PURPOSE_OPTIONS } from '../domain/requirements.js';

const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;

/**
 * Reference data. Everyone signed in may read; only administrators may write. Deleting something that is still in use is
 * refused (the production schema has no foreign keys, and a status delete used to CASCADE-delete cold calls).
 */
export function referenceRoutes(ctx) {
  const { db, schema, audit } = ctx;
  const router = express.Router();

  async function countUsage(run, usage, id) {
    const parts = [];
    for (const u of usage) {
      if (!schema.hasTable(u.table)) continue;
      const cols = u.columns.filter((c) => schema.has(u.table, c));
      if (!cols.length) continue;
      const row = await run.one(`SELECT COUNT(*) AS cnt FROM \`${u.table}\` WHERE ${cols.map((c) => `\`${c}\` = ?`).join(' OR ')}`, cols.map(() => id));
      if (Number(row?.cnt ?? 0) > 0) parts.push(`${row.cnt} ${u.label}`);
    }
    return parts;
  }

  async function assertNameFree(run, table, name, exceptId = null) {
    const row = await run.one(`SELECT id FROM \`${table}\` WHERE LOWER(name) = ? AND id <> ? LIMIT 1`, [String(name).toLowerCase(), exceptId ?? 0]);
    if (row) throw conflict(`"${name}" already exists`, 'DUPLICATE_NAME', [{ field: 'name', message: 'already exists' }]);
  }

  /** POST / PUT / DELETE for one reference table. `autoId`: the table has AUTO_INCREMENT ids. */
  function writable({ route, table, entity, parse, toRow, usage = [], uniqueName = false, afterUpdate, fresh, autoId = false }) {
    const loadOne = fresh ?? ((run, id) => run.one(`SELECT * FROM \`${table}\` WHERE id = ?`, [id]));

    router.post(`/${route}`, asyncHandler(async (req, res) => {
      requireSuper(req.currentUser);
      const v = new Validator();
      const parsed = await parse(bodyOf(req), v, null);
      v.assert();
      const now = nowSql();
      const id = await db.tx(async (tx) => {
        if (uniqueName) await assertNameFree(tx, table, parsed.name);
        const row = schema.only(table, { ...(await toRow(parsed, null, tx)), created_at: now, updated_at: now });
        if (autoId) {
          const cols = Object.keys(row);
          const r = await tx.exec(`INSERT INTO \`${table}\` (${cols.map((c) => `\`${c}\``).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => row[c]));
          return Number(r.insertId);
        }
        return insertRow(tx, table, row);
      }, { tables: [table] });
      await audit({ userId: req.currentUser.id, entityType: table, entityId: id, action: 'created', summary: `${entity} created: ${parsed.name ?? id}` });
      res.json({ ok: true, id, item: await loadOne(db, id) });
    }));

    router.put(`/${route}/:id`, asyncHandler(async (req, res) => {
      requireSuper(req.currentUser);
      const id = parseId(req.params.id);
      const v = new Validator();
      const body = bodyOf(req);
      await db.tx(async (tx) => {
        const existing = await tx.one(`SELECT * FROM \`${table}\` WHERE id = ? FOR UPDATE`, [id]);
        if (!existing) throw notFound(`${entity} not found`);
        const parsed = await parse(body, v, existing);
        v.assert();
        if (uniqueName && parsed.name !== undefined) await assertNameFree(tx, table, parsed.name, id);
        const row = await toRow(parsed, existing, tx);
        const filtered = schema.only(table, { ...row, updated_at: nowSql() });
        const cols = Object.keys(filtered);
        await tx.exec(`UPDATE \`${table}\` SET ${cols.map((c) => `\`${c}\` = ?`).join(', ')} WHERE id = ?`, [...cols.map((c) => filtered[c]), id]);
        if (afterUpdate) await afterUpdate(tx, id, { ...existing, ...row });
      });
      await audit({ userId: req.currentUser.id, entityType: table, entityId: id, action: 'updated', summary: `${entity} updated: #${id}` });
      res.json({ ok: true, item: await loadOne(db, id) });
    }));

    router.delete(`/${route}/:id`, asyncHandler(async (req, res) => {
      requireSuper(req.currentUser);
      const id = parseId(req.params.id);
      const existing = await db.tx(async (tx) => {
        const row = await tx.one(`SELECT * FROM \`${table}\` WHERE id = ? FOR UPDATE`, [id]);
        if (!row) throw notFound(`${entity} not found`);
        const used = await countUsage(tx, usage, id);
        if (used.length) {
          const hint = schema.has(table, 'is_active') ? ' You can deactivate it instead.' : ' Reassign or remove them first.';
          throw conflict(`This ${entity.toLowerCase()} is still used by ${used.join(' and ')}.${hint}`, 'IN_USE', { usedBy: used });
        }
        await tx.exec(`DELETE FROM \`${table}\` WHERE id = ?`, [id]);
        return row;
      });
      await audit({ userId: req.currentUser.id, entityType: table, entityId: id, action: 'deleted', summary: `${entity} deleted: ${existing.name ?? id}`, metadata: existing });
      res.json({ ok: true });
    }));
  }

  const nameField = (body, v, existing) => v.string(body.name, 'name', { required: !existing, min: 1 }) ?? existing?.name;
  const colorField = (body, v, existing) => {
    const c = v.string(body.color, 'color', { max: 20 });
    if (c !== undefined && c !== '' && !HEX_COLOR.test(c)) v.fail('color', 'must be a hex color like #3B82F6');
    return c || existing?.color || '#3B82F6';
  };

  // ---- statuses & sources -----------------------------------------------------------------------------------------
  router.get('/statuses', asyncHandler(async (req, res) => res.json(await db.rows('SELECT id, name, color FROM statuses ORDER BY id ASC'))));
  writable({
    route: 'statuses', table: 'statuses', entity: 'Status', uniqueName: true,
    parse: (body, v, e) => ({ name: nameField(body, v, e), color: colorField(body, v, e) }),
    toRow: (p) => ({ name: p.name, color: p.color }),
    usage: [{ table: 'leads', columns: ['status_id', 'statusId'], label: 'leads' }, { table: 'cold_calls', columns: ['status_id'], label: 'cold calls' }],
    afterUpdate: async (tx, id, row) => {
      if (schema.has('leads', 'status') && schema.has('leads', 'status_id')) await tx.exec('UPDATE leads SET status = ? WHERE status_id = ?', [row.name, id]);
      if (schema.hasTable('reports')) await tx.exec('UPDATE reports SET status_name = ? WHERE status_id = ?', [row.name, id]);
    },
    fresh: (run, id) => run.one('SELECT id, name, color FROM statuses WHERE id = ?', [id]),
  });

  router.get('/lead-sources', asyncHandler(async (req, res) => res.json(await db.rows('SELECT id, name, color FROM sources ORDER BY id ASC'))));
  writable({
    route: 'lead-sources', table: 'sources', entity: 'Source', uniqueName: true,
    parse: (body, v, e) => ({ name: nameField(body, v, e), color: colorField(body, v, e) }),
    toRow: (p) => ({ name: p.name, color: p.color }),
    usage: [{ table: 'leads', columns: ['source_id', 'sourceId'], label: 'leads' }],
    afterUpdate: async (tx, id, row) => {
      if (schema.has('leads', 'source') && schema.has('leads', 'source_id')) await tx.exec('UPDATE leads SET source = ? WHERE source_id = ?', [row.name, id]);
    },
    fresh: (run, id) => run.one('SELECT id, name, color FROM sources WHERE id = ?', [id]),
  });

  // ---- destinations & property types (admin-managed lists used by lead requirements) -----------------------------
  const optionRow = (r) => ({ id: r.id, name: r.name, isActive: Number(r.is_active) === 1, sortOrder: Number(r.sort_order ?? 0) });
  for (const [route, table, entity, link, column] of [
    ['destinations', 'destinations', 'Destination', 'lead_requirement_destinations', 'destination_id'],
    ['property-types', 'property_types', 'Property type', 'lead_requirement_property_types', 'property_type_id'],
  ]) {
    router.get(`/${route}`, asyncHandler(async (req, res) => {
      const activeOnly = req.query.active === '1' || req.query.active === 'true';
      const rows = await db.rows(`SELECT id, name, is_active, sort_order FROM \`${table}\` ${activeOnly ? 'WHERE is_active = 1' : ''} ORDER BY sort_order ASC, name ASC`);
      res.json(rows.map(optionRow));
    }));
    writable({
      route, table, entity, uniqueName: true, autoId: true,
      parse: (body, v, e) => ({
        name: v.string(body.name, 'name', { required: !e, min: 1, max: 100 }) ?? e?.name,
        isActive: v.bool(body.isActive),
        sortOrder: v.int(body.sortOrder, 'sortOrder', { min: 0, max: 100000 }),
      }),
      toRow: (p, e) => ({ name: p.name, is_active: (p.isActive ?? (e ? Number(e.is_active) === 1 : true)) ? 1 : 0, sort_order: p.sortOrder ?? e?.sort_order ?? 0 }),
      usage: [{ table: link, columns: [column], label: 'lead requirements' }, ...(table === 'destinations' ? [{ table: 'projects', columns: ['destination_id'], label: 'projects' }] : [])],
      fresh: async (run, id) => optionRow(await run.one(`SELECT id, name, is_active, sort_order FROM \`${table}\` WHERE id = ?`, [id])),
    });
  }

  router.get('/lead-options', asyncHandler(async (req, res) => {
    const [destinations, propertyTypes] = await Promise.all([
      db.rows('SELECT id, name, is_active, sort_order FROM destinations ORDER BY sort_order ASC, name ASC'),
      db.rows('SELECT id, name, is_active, sort_order FROM property_types ORDER BY sort_order ASC, name ASC'),
    ]);
    const choices = (list) => list.map((value) => ({ value, label: OPTION_LABELS[value] }));
    res.json({
      destinations: destinations.map(optionRow),
      propertyTypes: propertyTypes.map(optionRow),
      delivery: choices(DELIVERY_OPTIONS),
      finishing: choices(FINISHING_OPTIONS),
      purpose: choices(PURPOSE_OPTIONS),
    });
  }));

  // ---- developers ---------------------------------------------------------------------------------------------------
  router.get('/developers', asyncHandler(async (req, res) => {
    const cols = schema.pick('developers', ['id', 'name', 'logo', 'description', 'phone', 'whatsapp', 'email', 'website', 'updated_at']);
    res.json((await db.rows(`SELECT ${cols.join(', ')} FROM developers ORDER BY id ASC`)).map(serializeDeveloper));
  }));
  writable({
    route: 'developers', table: 'developers', entity: 'Developer', uniqueName: true,
    parse: (body, v, e) => {
      const logo = v.string(body.logo, 'logo', { max: 255 });
      if (logo && !/^(https?:\/\/|\/)[^\s"'<>]+$/i.test(logo)) v.fail('logo', 'must be an http(s) URL or a site path like /developers/x.jpg');
      const website = v.string(body.website, 'website', { max: 255 });
      if (website && !/^https?:\/\/[^\s"'<>]+$/i.test(website)) v.fail('website', 'must start with http:// or https://');
      return {
        name: nameField(body, v, e), logo, website,
        description: v.string(body.description, 'description', { max: 5000 }),
        phone: v.string(body.phone, 'phone', { max: 50 }),
        whatsapp: v.string(body.whatsapp, 'whatsapp', { max: 50 }),
        email: v.email(body.email, 'email'),
      };
    },
    toRow: (p, e) => ({
      name: p.name, logo: p.logo ?? e?.logo ?? null, description: p.description ?? e?.description ?? null, phone: p.phone ?? e?.phone ?? null,
      whatsapp: p.whatsapp ?? e?.whatsapp ?? null, email: p.email ?? e?.email ?? null, website: p.website ?? e?.website ?? null,
    }),
    usage: [
      { table: 'projects', columns: ['developer_id', 'developerId'], label: 'projects' },
      { table: 'brokers', columns: ['developer_id'], label: 'brokers' },
      { table: 'deals', columns: ['developer_id', 'developerId'], label: 'deals' },
    ],
    afterUpdate: async (tx, id, row) => { if (schema.hasTable('reports')) await tx.exec('UPDATE reports SET developer_name = ? WHERE developer_id = ?', [row.name, id]); },
    fresh: async (run, id) => serializeDeveloper(await run.one('SELECT * FROM developers WHERE id = ?', [id])),
  });

  // ---- projects -------------------------------------------------------------------------------------------------------
  const projectSelect = () => {
    const dev = schema.coalesce('projects', ['developer_id', 'developerId']);
    const dest = schema.has('projects', 'destination_id') ? 'projects.destination_id' : 'NULL';
    return `SELECT projects.id, projects.name, ${dev} AS developer_id, developers.name AS developer_name, ${dest} AS destination_id, destinations.name AS destination_name
       FROM projects LEFT JOIN developers ON developers.id = ${dev} LEFT JOIN destinations ON destinations.id = ${dest}`;
  };
  const serializeProject = (r) => ({ id: r.id, name: r.name, developerId: r.developer_id ?? undefined, developerName: r.developer_name ?? undefined, destinationId: r.destination_id ?? undefined, destinationName: r.destination_name ?? undefined });
  router.get('/projects', asyncHandler(async (req, res) => res.json((await db.rows(`${projectSelect()} ORDER BY projects.id ASC`)).map(serializeProject))));
  writable({
    route: 'projects', table: 'projects', entity: 'Project',
    parse: (body, v, e) => ({
      name: nameField(body, v, e),
      developerId: v.int(body.developerId ?? body.developer_id, 'developerId', { min: 1 }),
      developerProvided: 'developerId' in body || 'developer_id' in body,
      destinationId: v.int(body.destinationId, 'destinationId', { min: 1 }),
      destinationProvided: 'destinationId' in body,
    }),
    toRow: async (p, e, tx) => {
      const developerId = p.developerProvided ? p.developerId ?? null : e?.developer_id ?? e?.developerId ?? null;
      const destinationId = p.destinationProvided ? p.destinationId ?? null : e?.destination_id ?? null;
      let developerName = null;
      if (developerId) {
        const d = await tx.one('SELECT name FROM developers WHERE id = ?', [developerId]);
        if (!d) throw badRequest('The selected developer does not exist', [{ field: 'developerId', message: 'does not exist' }]);
        developerName = d.name;
      }
      if (destinationId && !(await tx.one('SELECT id FROM destinations WHERE id = ?', [destinationId]))) {
        throw badRequest('The selected destination does not exist', [{ field: 'destinationId', message: 'does not exist' }]);
      }
      return { name: p.name, developer_id: developerId, developerId, developerName, destination_id: destinationId };
    },
    usage: [
      { table: 'leads', columns: ['project_id', 'projectId'], label: 'leads' },
      { table: 'deals', columns: ['project_id', 'projectId'], label: 'deals' },
      { table: 'knowledge_base', columns: ['project_id'], label: 'knowledge-base articles' },
    ],
    afterUpdate: async (tx, id, row) => {
      if (schema.has('leads', 'project') && schema.has('leads', 'project_id')) await tx.exec('UPDATE leads SET project = ? WHERE project_id = ?', [row.name, id]);
      if (schema.hasTable('reports')) {
        const dev = row.developer_id ? await tx.one('SELECT id, name FROM developers WHERE id = ?', [row.developer_id]) : null;
        await tx.exec('UPDATE reports SET project_name = ?, developer_id = ?, developer_name = ? WHERE project_id = ?', [row.name, dev?.id ?? null, dev?.name ?? '', id]);
      }
    },
    fresh: async (run, id) => serializeProject(await run.one(`${projectSelect()} WHERE projects.id = ?`, [id])),
  });

  // ---- departments / job titles / titles ------------------------------------------------------------------------------
  router.get('/departments', asyncHandler(async (req, res) => res.json((await db.rows('SELECT id, name FROM departments ORDER BY id ASC')).map((r) => ({ id: r.id, name: r.name })))));
  writable({
    route: 'departments', table: 'departments', entity: 'Department', uniqueName: true, autoId: true,
    parse: (body, v, e) => ({ name: nameField(body, v, e) }),
    toRow: (p) => ({ name: p.name }),
    usage: [{ table: 'jobtitles', columns: ['department_id'], label: 'job titles' }, { table: 'users', columns: ['department_id'], label: 'users' }],
    fresh: (run, id) => run.one('SELECT id, name FROM departments WHERE id = ?', [id]),
  });

  const jobTitleRows = (run, where = '', params = []) => run.rows(
    `SELECT jobtitles.id, jobtitles.name, jobtitles.department_id, departments.name AS department_name
     FROM jobtitles LEFT JOIN departments ON departments.id = jobtitles.department_id ${where} ORDER BY jobtitles.id ASC`, params);
  const serializeJobTitle = (r) => ({ id: r.id, name: r.name, departmentId: r.department_id ?? null, departmentName: r.department_name ?? '' });
  router.get('/jobtitles', asyncHandler(async (req, res) => res.json((await jobTitleRows(db)).map(serializeJobTitle))));
  writable({
    route: 'jobtitles', table: 'jobtitles', entity: 'Job title', autoId: true,
    parse: (body, v, e) => ({
      name: nameField(body, v, e),
      departmentId: v.int(body.departmentId ?? body.department_id, 'departmentId', { min: 1 }),
      departmentProvided: 'departmentId' in body || 'department_id' in body,
    }),
    toRow: async (p, e, tx) => {
      const departmentId = p.departmentProvided ? p.departmentId ?? null : e?.department_id ?? null;
      if (departmentId && !(await tx.one('SELECT id FROM departments WHERE id = ?', [departmentId]))) throw badRequest('The selected department does not exist', [{ field: 'departmentId', message: 'does not exist' }]);
      return { name: p.name, department_id: departmentId };
    },
    usage: [{ table: 'users', columns: ['jobtitle_id'], label: 'users' }],
    fresh: async (run, id) => serializeJobTitle((await jobTitleRows(run, 'WHERE jobtitles.id = ?', [id]))[0]),
  });

  // `titles` is the older, name-based view of job titles used by the Titles admin page: { name, department: 'Sales' }.
  router.get('/titles', asyncHandler(async (req, res) => res.json((await jobTitleRows(db)).map((r) => ({ id: r.id, name: r.name, department: r.department_name ?? 'Sales' })))));
  async function departmentIdByName(tx, name) {
    const wanted = (name || 'Sales').trim();
    const found = await tx.one('SELECT id FROM departments WHERE LOWER(name) = ? LIMIT 1', [wanted.toLowerCase()]);
    if (found) return found.id;
    const r = await tx.exec('INSERT INTO departments (name, created_at, updated_at) VALUES (?, ?, ?)', [wanted, nowSql(), nowSql()]);
    return Number(r.insertId);
  }
  writable({
    route: 'titles', table: 'jobtitles', entity: 'Job title', autoId: true,
    parse: (body, v, e) => ({ name: nameField(body, v, e), department: v.string(body.department, 'department') }),
    toRow: async (p, e, tx) => ({
      name: p.name,
      department_id: p.department !== undefined ? await departmentIdByName(tx, p.department) : e?.department_id ?? (await departmentIdByName(tx, 'Sales')),
    }),
    usage: [{ table: 'users', columns: ['jobtitle_id'], label: 'users' }],
    fresh: async (run, id) => {
      const r = (await jobTitleRows(run, 'WHERE jobtitles.id = ?', [id]))[0];
      return { id: r.id, name: r.name, department: r.department_name ?? 'Sales' };
    },
  });

  // ---- brokers ----------------------------------------------------------------------------------------------------------
  const brokerRows = (run, where = '', params = []) => run.rows(
    `SELECT brokers.id, brokers.name, brokers.phone, brokers.developer_id, developers.name AS developer_name
     FROM brokers LEFT JOIN developers ON developers.id = brokers.developer_id ${where} ORDER BY brokers.id ASC`, params);
  const serializeBroker = (r) => ({ id: r.id, name: r.name, phone: r.phone ?? '', developerId: r.developer_id ?? null, developerName: r.developer_name ?? '' });
  router.get('/brokers', asyncHandler(async (req, res) => res.json((await brokerRows(db)).map(serializeBroker))));
  writable({
    route: 'brokers', table: 'brokers', entity: 'Broker',
    parse: (body, v, e) => ({
      name: nameField(body, v, e),
      phone: v.clientPhone(body.phone, 'phone', { keep: e?.phone }),
      developerId: v.int(body.developerId ?? body.developer_id, 'developerId', { min: 1 }),
      developerProvided: 'developerId' in body || 'developer_id' in body,
    }),
    toRow: async (p, e, tx) => {
      const developerId = p.developerProvided ? p.developerId ?? null : e?.developer_id ?? null;
      if (developerId && !(await tx.one('SELECT id FROM developers WHERE id = ?', [developerId]))) throw badRequest('The selected developer does not exist', [{ field: 'developerId', message: 'does not exist' }]);
      return { name: p.name, phone: (p.phone ?? e?.phone ?? '') || null, developer_id: developerId };
    },
    usage: [{ table: 'deals', columns: ['broker_id'], label: 'deals' }],
    fresh: async (run, id) => serializeBroker((await brokerRows(run, 'WHERE brokers.id = ?', [id]))[0]),
  });

  // ---- agent care (one support contact card) ------------------------------------------------------------------------
  router.get('/agent-care', asyncHandler(async (req, res) => res.json(await db.rows('SELECT id, name, phone, whatsapp, email FROM agent_care ORDER BY id ASC'))));
  router.put('/agent-care/:id', asyncHandler(async (req, res) => {
    requireSuper(req.currentUser);
    const id = parseId(req.params.id);
    const body = bodyOf(req);
    const existing = await db.one('SELECT id, name, phone, whatsapp, email FROM agent_care WHERE id = ?', [id]);
    if (!existing) throw notFound('Agent care contact not found');
    const v = new Validator();
    const next = {
      name: v.string(body.name, 'name', { min: 1 }) ?? existing.name,
      phone: v.clientPhone(body.phone, 'phone', { keep: existing.phone }) ?? existing.phone,
      whatsapp: v.clientPhone(body.whatsapp, 'whatsapp', { keep: existing.whatsapp }) ?? existing.whatsapp,
      email: v.email(body.email, 'email') ?? existing.email,
    };
    v.assert();
    await db.exec('UPDATE agent_care SET name = ?, phone = ?, whatsapp = ?, email = ? WHERE id = ?', [next.name, next.phone, next.whatsapp, next.email, id]);
    await audit({ userId: req.currentUser.id, entityType: 'agent_care', entityId: id, action: 'updated', summary: 'Agent care contact updated' });
    res.json({ ok: true, item: { id, ...next } });
  }));

  return router;
}

import { badRequest } from '../http/errors.js';
import { todayUtc } from '../lib/dates.js';
import { pickStatus } from './lookups.js';
import { serializeLead, serializeColdCall } from './serializers.js';

const isPotentialName = (name) => {
  const n = String(name ?? '').toLowerCase();
  return n.includes('potential') && !n.includes('non');
};
const pickCI = (row, name) => {
  for (const key of Object.keys(row)) if (key.toLowerCase() === name.toLowerCase() && row[key] !== undefined) return row[key];
  return undefined;
};

/** A reference row by id (or, failing that, by exact name). Unknown positive ids are rejected. */
async function resolveReference(tx, table, { id, name }, label) {
  if (id && id > 0) {
    const row = await tx.one(`SELECT id, name FROM \`${table}\` WHERE id = ?`, [id]);
    if (!row) throw badRequest(`Unknown ${label}`, [{ field: `${label}Id`, message: 'does not exist' }]);
    return row;
  }
  if (name) return (await tx.one(`SELECT id, name FROM \`${table}\` WHERE LOWER(name) = ? LIMIT 1`, [String(name).toLowerCase()])) ?? null;
  return null;
}

const statusCatalog = (tx) => tx.rows('SELECT id, name FROM statuses ORDER BY id ASC');

// ------------------------------------------------------------------------------------------------------------------
export function leadSpec(ctx) {
  const { schema } = ctx;
  const statusId = schema.coalesce('leads', ['status_id', 'statusId']);
  const sourceId = schema.coalesce('leads', ['source_id', 'sourceId']);
  const projectId = schema.coalesce('leads', ['project_id', 'projectId']);

  return {
    route: 'leads', table: 'leads', entity: 'lead', label: 'Lead', serialize: serializeLead, hasRequirements: true,

    selectSql: () => `SELECT leads.*, ${statusId} AS eff_status_id, ${sourceId} AS eff_source_id, ${projectId} AS eff_project_id,
              statuses.name AS status_name, sources.name AS source_name, projects.name AS project_name,
              users.name AS user_name, users.parent_id AS parent_id, users.role AS user_role, tl.name AS team_leader_name
       FROM leads
       LEFT JOIN statuses ON statuses.id = ${statusId}
       LEFT JOIN sources ON sources.id = ${sourceId}
       LEFT JOIN projects ON projects.id = ${projectId}
       LEFT JOIN users ON users.id = leads.user_id
       LEFT JOIN users AS tl ON tl.id = users.parent_id`,

    parse(body, v, existing) {
      const create = !existing;
      const input = {
        name: v.string(body.name, 'name', { required: create, min: 1 }),
        phone: v.clientPhone(body.phone, 'phone', { required: create, keep: existing?.phone }),
        whatsapp: v.clientPhone(body.whatsapp, 'whatsapp', { keep: existing?.whatsapp }),
        workPhone: v.string(body.workPhone ?? body.workphone, 'workPhone', { max: 50 }),
        email: v.email(body.email, 'email'),
        comment: v.string(body.comment, 'comment', { max: 5000 }),
        date: v.date(body.date, 'date'),
        statusId: v.int(body.statusId ?? body.status_id, 'statusId', { min: 0 }),
        statusName: typeof body.status === 'string' ? body.status.trim() || undefined : undefined,
        sourceId: v.int(body.sourceId ?? body.source_id, 'sourceId', { min: 0 }),
        sourceName: typeof body.source === 'string' ? body.source.trim() || undefined : undefined,
        projectId: v.int(body.projectId ?? body.project_id, 'projectId', { min: 0 }),
        projectProvided: 'projectId' in body || 'project_id' in body,
        projectName: typeof body.project === 'string' ? body.project.trim() || undefined : undefined,
        assignedProvided: 'assignedToId' in body || 'userId' in body,
        assignedToId: v.int(body.assignedToId ?? body.userId, 'assignedToId', { min: 0 }) || null,
      };
      if (create && input.phone === '') v.fail('phone', 'is required');
      return input;
    },

    async resolveRefs(tx, input, existing) {
      const touchedStatus = input.statusId !== undefined || input.statusName !== undefined;
      const status = !existing || touchedStatus
        ? pickStatus(await statusCatalog(tx), { statusId: input.statusId, statusName: input.statusName })
        : { id: pickCI(existing, 'status_id') ?? pickCI(existing, 'statusId') ?? 0, name: existing.status ?? '' };
      const source = existing && input.sourceId === undefined && input.sourceName === undefined
        ? { id: pickCI(existing, 'source_id') ?? pickCI(existing, 'sourceId') ?? null, name: existing.source ?? null }
        : await resolveReference(tx, 'sources', { id: input.sourceId, name: input.sourceName }, 'source');
      let project;
      if (existing && !input.projectProvided && input.projectName === undefined) {
        project = { id: pickCI(existing, 'project_id') ?? pickCI(existing, 'projectId') ?? null, name: existing.project ?? null };
      } else if (input.projectProvided && !input.projectId) {
        project = null; // explicitly cleared
      } else {
        project = await resolveReference(tx, 'projects', { id: input.projectId, name: input.projectName }, 'project');
      }
      return { status, source, project };
    },

    buildRow({ input, refs, owner, teamLeader, existing, now, ownerChanged }) {
      const create = !existing;
      const row = {
        name: input.name ?? existing?.name,
        phone: input.phone ?? existing?.phone,
        whatsapp: input.whatsapp === undefined ? existing?.whatsapp ?? null : input.whatsapp || null,
        workPhone: input.workPhone === undefined ? (existing ? pickCI(existing, 'workPhone') : null) ?? null : input.workPhone || null,
        email: input.email === undefined ? existing?.email ?? null : input.email || null,
        comment: input.comment ?? existing?.comment ?? null,
        date: input.date ?? (existing ? existing.date : undefined) ?? todayUtc(),
        status: refs.status.name, statusId: refs.status.id, status_id: refs.status.id,
        source: refs.source?.name ?? null, sourceId: refs.source?.id ?? null, source_id: refs.source?.id ?? null,
        project: refs.project?.name ?? null, projectId: refs.project?.id ?? null, project_id: refs.project?.id ?? null,
        isPotential: isPotentialName(refs.status.name) ? 1 : 0,
        updated_at: now,
      };
      if (create) { row.type = 'Lead'; row.created_at = now; }
      if (create || ownerChanged) {
        row.user_id = owner?.id ?? null; row.assignedToId = owner?.id ?? null; row.assignedTo = owner?.name ?? null;
        row.teamLeaderId = teamLeader?.id ?? null; row.teamLeader = teamLeader?.name ?? null;
      }
      return row;
    },

    snapshot: (r) => ({ id: r.id, name: r.name, phone: r.phone, status: r.status, user_id: r.user_id }),
  };
}

// ------------------------------------------------------------------------------------------------------------------
export function coldCallSpec() {
  return {
    route: 'cold-calls', table: 'cold_calls', entity: 'cold_call', label: 'Cold call', serialize: serializeColdCall,

    selectSql: () => `SELECT cold_calls.*, statuses.name AS status_name,
              users.name AS user_name, users.parent_id AS parent_id, users.role AS user_role, tl.name AS team_leader_name
       FROM cold_calls
       LEFT JOIN statuses ON statuses.id = cold_calls.status_id
       LEFT JOIN users ON users.id = cold_calls.user_id
       LEFT JOIN users AS tl ON tl.id = users.parent_id`,

    parse(body, v, existing) {
      const create = !existing;
      const input = {
        name: v.string(body.name, 'name', { required: create, min: 1 }),
        phone: v.clientPhone(body.phone, 'phone', { required: create, keep: existing?.phone }),
        notes: v.string(body.notes ?? body.comment, 'notes', { max: 5000 }),
        statusId: v.int(body.statusId ?? body.status_id, 'statusId', { min: 0 }),
        statusName: typeof body.status === 'string' ? body.status.trim() || undefined : undefined,
        assignedProvided: 'assignedToId' in body || 'userId' in body,
        assignedToId: v.int(body.assignedToId ?? body.userId, 'assignedToId', { min: 0 }) || null,
      };
      if (create && input.phone === '') v.fail('phone', 'is required');
      return input;
    },

    async resolveRefs(tx, input, existing) {
      const touched = input.statusId !== undefined || input.statusName !== undefined;
      if (!existing || touched) return { status: pickStatus(await statusCatalog(tx), { statusId: input.statusId, statusName: input.statusName }) };
      return { status: { id: existing.status_id, name: '' } };
    },

    buildRow({ input, refs, owner, existing, now, ownerChanged }) {
      const create = !existing;
      const row = { name: input.name ?? existing?.name, phone: input.phone ?? existing?.phone, status_id: refs.status.id, notes: input.notes ?? existing?.notes ?? null, updated_at: now };
      if (create) row.created_at = now;
      if (create || ownerChanged) row.user_id = owner?.id ?? null;
      return row;
    },

    snapshot: (r) => ({ id: r.id, name: r.name, phone: r.phone, user_id: r.user_id }),
  };
}

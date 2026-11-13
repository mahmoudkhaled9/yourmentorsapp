import { nowSql } from '../lib/dates.js';
import { inClause } from './lookups.js';

const REPORT_COLUMNS = [
  'comment_id', 'lead_id', 'cold_call_id', 'entity_type', 'entity_id', 'client_name', 'client_phone',
  'agent_id', 'agent_name', 'team_leader_id', 'team_leader_name', 'status_id', 'status_name',
  'project_id', 'project_name', 'developer_id', 'developer_name', 'content', 'created_by', 'created_by_id',
  'created_at', 'updated_at',
];

export const entityKey = (type, id) => `${type}:${id}`;

export function commentEntity(row) {
  const type = row.entity_type || (row.cold_call_id ? 'cold_call' : 'lead');
  const id = row.entity_id ?? (type === 'cold_call' ? row.cold_call_id : row.lead_id) ?? row.leadId ?? null;
  return { type, id: id === null ? null : Number(id) };
}

/** Name / phone / status / project / developer for a batch of leads and cold calls. Map("lead:1" -> summary). */
export async function loadEntitySummaries(run, schema, { leadIds = [], coldCallIds = [] }) {
  const out = new Map();
  if (leadIds.length) {
    const ids = inClause(leadIds);
    const statusId = schema.coalesce('leads', ['status_id', 'statusId']);
    const projectId = schema.coalesce('leads', ['project_id', 'projectId']);
    const developerId = schema.coalesce('projects', ['developer_id', 'developerId']);
    const rows = await run.rows(
      `SELECT leads.id, leads.name, leads.phone, ${statusId} AS status_id, statuses.name AS status_name,
              ${projectId} AS project_id, projects.name AS project_name,
              ${developerId} AS developer_id, developers.name AS developer_name
       FROM leads
       LEFT JOIN statuses ON statuses.id = ${statusId}
       LEFT JOIN projects ON projects.id = ${projectId}
       LEFT JOIN developers ON developers.id = ${developerId}
       WHERE leads.id IN (${ids.sql})`,
      ids.params
    );
    for (const r of rows) out.set(entityKey('lead', r.id), r);
  }
  if (coldCallIds.length) {
    const ids = inClause(coldCallIds);
    const rows = await run.rows(
      `SELECT cold_calls.id, cold_calls.name, cold_calls.phone, cold_calls.status_id, statuses.name AS status_name,
              NULL AS project_id, NULL AS project_name, NULL AS developer_id, NULL AS developer_name
       FROM cold_calls LEFT JOIN statuses ON statuses.id = cold_calls.status_id
       WHERE cold_calls.id IN (${ids.sql})`,
      ids.params
    );
    for (const r of rows) out.set(entityKey('cold_call', r.id), r);
  }
  return out;
}

function teamLeaderOfAuthor(author, parent) {
  if (!author) return null;
  if (String(author.role).toLowerCase() === 'team_leader') return { id: author.id, name: author.name };
  return parent ?? null;
}

export function buildReportRow({ comment, author, teamLeader, entity }) {
  const { type, id } = commentEntity(comment);
  return {
    comment_id: comment.id,
    lead_id: type === 'lead' ? id : null,
    cold_call_id: type === 'cold_call' ? id : null,
    entity_type: type,
    entity_id: id,
    client_name: entity?.name ?? 'Unknown',
    client_phone: entity?.phone ?? '',
    agent_id: author?.id ?? comment.user_id ?? null,
    agent_name: author?.name ?? '',
    team_leader_id: teamLeader?.id ?? null,
    team_leader_name: teamLeader?.name ?? '',
    status_id: entity?.status_id ?? null,
    status_name: entity?.status_name ?? '',
    project_id: entity?.project_id ?? null,
    project_name: entity?.project_name ?? '',
    developer_id: entity?.developer_id ?? null,
    developer_name: entity?.developer_name ?? '',
    content: comment.body ?? comment.content ?? '',
    created_by: author?.name ?? comment.createdBy ?? 'Unknown',
    created_by_id: comment.user_id ?? comment.createdById ?? 0,
    created_at: comment.created_at ?? nowSql(),
    updated_at: comment.updated_at ?? comment.created_at ?? nowSql(),
  };
}

/** Creates or refreshes the single report row that mirrors one comment (O(1) work per comment). */
export async function upsertReportForComment(run, schema, comment) {
  const { type, id } = commentEntity(comment);
  const authorId = comment.user_id ?? comment.createdById ?? null;
  const author = authorId ? await run.one('SELECT id, name, role, parent_id FROM users WHERE id = ?', [authorId]) : null;
  const parent = author?.parent_id ? await run.one('SELECT id, name FROM users WHERE id = ?', [author.parent_id]) : null;
  const summaries = await loadEntitySummaries(run, schema, {
    leadIds: type === 'lead' && id ? [id] : [],
    coldCallIds: type === 'cold_call' && id ? [id] : [],
  });
  const row = buildReportRow({ comment, author, teamLeader: teamLeaderOfAuthor(author, parent), entity: id ? summaries.get(entityKey(type, id)) : null });
  const existing = await run.one('SELECT id FROM reports WHERE comment_id = ?', [comment.id]);
  if (existing) {
    const { comment_id: _omit, created_at: _keep, ...changes } = row;
    const cols = Object.keys(changes);
    await run.exec(`UPDATE reports SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [...cols.map((c) => changes[c]), existing.id]);
  } else {
    await run.exec(`INSERT INTO reports (${REPORT_COLUMNS.join(', ')}) VALUES (${REPORT_COLUMNS.map(() => '?').join(', ')})`, REPORT_COLUMNS.map((c) => row[c]));
  }
}

export const deleteReportForComment = (run, commentId) => run.exec('DELETE FROM reports WHERE comment_id = ?', [commentId]);

/** Keeps the denormalised client/status/project columns of existing reports fresh after a lead/cold-call edit. */
export async function refreshReportsForEntity(run, schema, type, id) {
  const summaries = await loadEntitySummaries(run, schema, { leadIds: type === 'lead' ? [id] : [], coldCallIds: type === 'cold_call' ? [id] : [] });
  const e = summaries.get(entityKey(type, id));
  if (!e) return;
  await run.exec(
    `UPDATE reports SET client_name = ?, client_phone = ?, status_id = ?, status_name = ?, project_id = ?, project_name = ?,
            developer_id = ?, developer_name = ? WHERE entity_type = ? AND entity_id = ?`,
    [e.name, e.phone ?? '', e.status_id ?? null, e.status_name ?? '', e.project_id ?? null, e.project_name ?? '', e.developer_id ?? null, e.developer_name ?? '', type, id]
  );
}

/** After a user is renamed / moved in the hierarchy, refresh the names stored on their reports. */
export async function refreshReportsForUser(run, userId) {
  const u = await run.one('SELECT id, name, role, parent_id FROM users WHERE id = ?', [userId]);
  if (!u) return;
  await run.exec('UPDATE reports SET agent_name = ?, created_by = ? WHERE agent_id = ?', [u.name, u.name, u.id]);
  const parent = u.parent_id ? await run.one('SELECT id, name FROM users WHERE id = ?', [u.parent_id]) : null;
  const tl = teamLeaderOfAuthor(u, parent);
  await run.exec('UPDATE reports SET team_leader_id = ?, team_leader_name = ? WHERE agent_id = ?', [tl?.id ?? null, tl?.name ?? '', u.id]);
  await run.exec('UPDATE reports SET team_leader_name = ? WHERE team_leader_id = ?', [u.name, u.id]);
}

/** Full, paged rebuild (admin maintenance / first-run backfill). ~6 queries per 500 comments; no table-wide DELETE. */
export async function rebuildReports(db, schema, { pageSize = 500 } = {}) {
  let lastId = 0;
  let total = 0;
  const commentCols = schema.pick('comments', ['id', 'user_id', 'lead_id', 'cold_call_id', 'entity_type', 'entity_id', 'leadId', 'body', 'content', 'createdBy', 'createdById', 'created_at', 'updated_at']);
  for (;;) {
    const comments = await db.rows(`SELECT ${commentCols.join(', ')} FROM comments WHERE id > ? ORDER BY id ASC LIMIT ${Number(pageSize)}`, [lastId]);
    if (!comments.length) break;
    const authorIds = [...new Set(comments.map((c) => c.user_id ?? c.createdById).filter(Boolean).map(Number))];
    const authors = new Map();
    const parents = new Map();
    if (authorIds.length) {
      const q = inClause(authorIds);
      for (const u of await db.rows(`SELECT id, name, role, parent_id FROM users WHERE id IN (${q.sql})`, q.params)) authors.set(Number(u.id), u);
      const parentIds = [...new Set([...authors.values()].map((u) => u.parent_id).filter(Boolean).map(Number))];
      if (parentIds.length) {
        const p = inClause(parentIds);
        for (const u of await db.rows(`SELECT id, name FROM users WHERE id IN (${p.sql})`, p.params)) parents.set(Number(u.id), u);
      }
    }
    const leadIds = []; const coldCallIds = [];
    for (const c of comments) {
      const { type, id } = commentEntity(c);
      if (id) (type === 'cold_call' ? coldCallIds : leadIds).push(id);
    }
    const summaries = await loadEntitySummaries(db, schema, { leadIds: [...new Set(leadIds)], coldCallIds: [...new Set(coldCallIds)] });
    const rows = comments.map((c) => {
      const author = authors.get(Number(c.user_id ?? c.createdById)) ?? null;
      const { type, id } = commentEntity(c);
      return buildReportRow({ comment: c, author, teamLeader: teamLeaderOfAuthor(author, author?.parent_id ? parents.get(Number(author.parent_id)) : null), entity: id ? summaries.get(entityKey(type, id)) : null });
    });
    await db.tx(async (tx) => {
      const q = inClause(rows.map((r) => r.comment_id));
      await tx.exec(`DELETE FROM reports WHERE comment_id IN (${q.sql})`, q.params);
      for (let i = 0; i < rows.length; i += 100) {
        const chunk = rows.slice(i, i + 100);
        await tx.exec(
          `INSERT INTO reports (${REPORT_COLUMNS.join(', ')}) VALUES ${chunk.map(() => `(${REPORT_COLUMNS.map(() => '?').join(', ')})`).join(', ')}`,
          chunk.flatMap((r) => REPORT_COLUMNS.map((c) => r[c]))
        );
      }
    });
    lastId = Number(comments[comments.length - 1].id);
    total += comments.length;
  }
  await db.exec('DELETE FROM reports WHERE comment_id NOT IN (SELECT id FROM comments)');
  return total;
}

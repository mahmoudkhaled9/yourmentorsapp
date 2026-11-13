import { badRequest } from '../http/errors.js';

/** Resolves a status from { statusId, statusName }. 0 / missing -> the first status. Unknown positive ids are rejected. */
export function pickStatus(catalog, { statusId, statusName } = {}) {
  if (!catalog.length) throw badRequest('No statuses are configured yet');
  if (statusId && statusId > 0) {
    const byId = catalog.find((s) => Number(s.id) === Number(statusId));
    if (!byId) throw badRequest('Unknown status', [{ field: 'statusId', message: 'does not exist' }]);
    return byId;
  }
  if (statusName) {
    const wanted = String(statusName).trim().toLowerCase();
    const byName = catalog.find((s) => String(s.name).toLowerCase() === wanted);
    if (byName) return byName;
  }
  return catalog[0];
}

export const userBrief = (run, id) => run.one('SELECT id, name, role, parent_id, status FROM users WHERE id = ?', [id]);

/** The team leader a record is attributed to: the assignee when they are a team leader, otherwise their parent. */
export async function teamLeaderFor(run, assignee) {
  if (!assignee) return null;
  if (String(assignee.role).toLowerCase() === 'team_leader') return { id: assignee.id, name: assignee.name };
  if (assignee.parent_id === null || assignee.parent_id === undefined) return null;
  return (await run.one('SELECT id, name FROM users WHERE id = ?', [assignee.parent_id])) ?? null;
}

export const inClause = (values) => ({ sql: values.map(() => '?').join(', '), params: values });

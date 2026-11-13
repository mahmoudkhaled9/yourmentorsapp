import { forbidden } from '../http/errors.js';

/**
 * Roles (the frontend uses the same names):
 *   franchise_owner, admin                  – the whole company ("super" roles)
 *   director, sales_manager, sales_supervisor, team_leader – their own reporting subtree, may assign within it
 *   agent                                   – their own records only
 * What a person may see is decided by the users.parent_id tree, never by data sent from the browser.
 */
export const ROLES = ['admin', 'franchise_owner', 'director', 'sales_manager', 'sales_supervisor', 'team_leader', 'agent'];
export const SUPER_ROLES = new Set(['admin', 'franchise_owner']);
export const ASSIGNER_ROLES = new Set([...SUPER_ROLES, 'director', 'sales_manager', 'sales_supervisor', 'team_leader']);

export const normalizeRole = (value) => String(value ?? 'agent').trim().toLowerCase().replace(/[\s-]+/g, '_');
export const isSuper = (user) => SUPER_ROLES.has(normalizeRole(user?.role));
export const canAssign = (user) => ASSIGNER_ROLES.has(normalizeRole(user?.role));
export const isActiveUser = (user) => Number(user?.status ?? 1) === 1;

export function requireSuper(user, message = 'Only administrators can do this') {
  if (!isSuper(user)) throw forbidden(message);
}
export function requireAssigner(user, message = 'You are not allowed to assign records to other users') {
  if (!canAssign(user)) throw forbidden(message);
}

/** The set of user ids whose records `user` may see: themselves + their active descendants. Super users see everything. */
export class Scope {
  constructor({ all, ids }) {
    this.all = all;
    this.ids = ids ?? new Set();
  }

  has(userId) {
    if (this.all) return true;
    return userId !== null && userId !== undefined && this.ids.has(Number(userId));
  }

  /** SQL fragment restricting `column` to the visible users: { sql, params }. */
  sqlIn(column) {
    if (this.all) return { sql: '1 = 1', params: [] };
    const ids = [...this.ids];
    return { sql: `${column} IN (${ids.map(() => '?').join(', ')})`, params: ids };
  }
}

function childrenMap(rows, { activeOnly }) {
  const children = new Map();
  for (const r of rows) {
    if ((activeOnly && !isActiveUser(r)) || r.parent_id === null || r.parent_id === undefined) continue;
    const parent = Number(r.parent_id);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(Number(r.id));
  }
  return children;
}

function walk(children, rootId) {
  const out = new Set();
  const queue = [Number(rootId)];
  while (queue.length) {
    for (const child of children.get(queue.shift()) ?? []) {
      if (!out.has(child)) { out.add(child); queue.push(child); } // the Set also protects against cycles
    }
  }
  return out;
}

export async function loadScope(db, user) {
  if (isSuper(user)) return new Scope({ all: true });
  const rows = await db.rows('SELECT id, parent_id, status FROM users');
  const ids = walk(childrenMap(rows, { activeOnly: true }), user.id);
  ids.add(Number(user.id));
  return new Scope({ all: false, ids });
}

/** All descendants of `userId` regardless of status (used to prevent reporting loops). */
export async function descendantsOf(db, userId) {
  const rows = await db.rows('SELECT id, parent_id FROM users');
  return walk(childrenMap(rows, { activeOnly: false }), userId);
}

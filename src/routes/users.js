import express from 'express';
import { asyncHandler, badRequest, conflict, notFound } from '../http/errors.js';
import { Validator, bodyOf, parseId } from '../lib/validate.js';
import { nowSql } from '../lib/dates.js';
import { ROLES, requireSuper, descendantsOf, normalizeRole, SUPER_ROLES } from '../auth/policy.js';
import { checkPasswordStrength } from '../auth/passwords.js';
import { insertRow } from '../db.js';
import { serializeUser, DEFAULT_USER_IMAGE } from '../domain/serializers.js';
import { refreshReportsForUser } from '../domain/reports.js';
import { validateAvatar } from './auth.js';

const PUBLIC_COLUMNS = 'id, name, email, phone, role, title, department, department_id, jobtitle_id, parent_id, status, image, created_at, updated_at';

export function userRoutes(ctx) {
  const { db, schema, passwords, audit } = ctx;
  const router = express.Router();
  const loadPublic = (run, id) => run.one(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = ?`, [id]);

  async function assertAnotherSuperRemains(run, excludingId) {
    const row = await run.one(`SELECT COUNT(*) AS cnt FROM users WHERE id <> ? AND LOWER(role) IN ('admin', 'franchise_owner') AND COALESCE(status, 1) = 1`, [excludingId]);
    if (Number(row?.cnt ?? 0) < 1) throw conflict('You cannot remove or disable the last administrator', 'LAST_ADMIN');
  }
  async function assertEmailFree(run, email, exceptId = null) {
    const row = await run.one('SELECT id FROM users WHERE LOWER(email) = ? AND id <> ? LIMIT 1', [String(email).toLowerCase(), exceptId ?? 0]);
    if (row) throw conflict('A user with this email already exists', 'EMAIL_TAKEN', [{ field: 'email', message: 'is already used by another account' }]);
  }
  async function assertParentValid(run, parentId, selfId = null) {
    if (parentId === undefined || parentId === null) return;
    if (selfId !== null) {
      if (Number(parentId) === Number(selfId)) throw badRequest('A user cannot report to themselves');
      if ((await descendantsOf(run, selfId)).has(Number(parentId))) throw badRequest('This would create a reporting loop (the chosen manager already reports to this user)');
    }
    if (!(await run.one('SELECT id FROM users WHERE id = ?', [parentId]))) throw badRequest('The selected team leader / manager does not exist');
  }
  async function assertRefExists(run, table, id, label) {
    if (id === undefined || id === null || !schema.hasTable(table)) return;
    if (!(await run.one(`SELECT id FROM \`${table}\` WHERE id = ?`, [id]))) throw badRequest(`The selected ${label} does not exist`);
  }

  router.get('/users', asyncHandler(async (req, res) => {
    const scope = await ctx.scopeFor(req);
    const f = scope.sqlIn('id');
    res.json((await db.rows(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE ${f.sql} ORDER BY id ASC`, f.params)).map(serializeUser));
  }));

  router.post('/users', asyncHandler(async (req, res) => {
    requireSuper(req.currentUser);
    const body = bodyOf(req);
    const v = new Validator();
    const name = v.string(body.name, 'name', { required: true });
    const email = v.email(body.email, 'email', { required: true });
    const phone = v.egyptianMobile(body.phone, 'phone');
    const role = v.oneOf(normalizeRole(body.role ?? 'agent'), 'role', ROLES, { required: true });
    const password = typeof (body.password ?? body.newPassword) === 'string' ? (body.password ?? body.newPassword) : '';
    if (!password) v.fail('password', 'is required');
    const title = v.string(body.title, 'title');
    const department = v.string(body.department, 'department');
    const departmentId = v.int(body.departmentId ?? body.department_id, 'departmentId', { min: 1 });
    const jobtitleId = v.int(body.jobtitleId ?? body.jobtitle_id, 'jobtitleId', { min: 1 });
    const parentId = v.int(body.teamLeaderId ?? body.parent_id, 'teamLeaderId', { min: 1 });
    const active = v.bool(body.isActive ?? body.status) ?? true;
    const avatar = validateAvatar(body.avatar ?? body.image, v);
    v.assert();
    const problem = checkPasswordStrength(password, { email, name });
    if (problem) throw badRequest(problem, [{ field: 'password', message: problem }]);
    const hash = await passwords.hash(password);
    const now = nowSql();
    const id = await db.tx(async (tx) => {
      await assertEmailFree(tx, email);
      await assertParentValid(tx, parentId);
      await assertRefExists(tx, 'departments', departmentId, 'department');
      await assertRefExists(tx, 'jobtitles', jobtitleId, 'job title');
      return insertRow(tx, 'users', schema.only('users', {
        name, email, phone: phone ?? '', password: hash, role,
        title: title ?? null, department: department ?? null, department_id: departmentId ?? null, jobtitle_id: jobtitleId ?? null,
        parent_id: parentId ?? null, teamLeaderId: parentId ?? null,
        status: active ? 1 : 0, isActive: active ? 1 : 0, is_active: active ? 1 : 0,
        image: avatar ?? DEFAULT_USER_IMAGE, createdAt: now, created_at: now, updated_at: now,
      }));
    }, { tables: ['users'] });
    await audit({ userId: req.currentUser.id, entityType: 'users', entityId: id, action: 'created', summary: `User created: ${name}`, metadata: { email, role } });
    res.json({ ok: true, id, item: serializeUser(await loadPublic(db, id)) });
  }));

  router.put('/users/:id', asyncHandler(async (req, res) => {
    requireSuper(req.currentUser);
    const id = parseId(req.params.id);
    const actor = req.currentUser;
    const body = bodyOf(req);
    const stored = await db.one('SELECT phone FROM users WHERE id = ?', [id]);
    if (!stored) throw notFound('User not found');
    const v = new Validator();
    const name = v.string(body.name, 'name', { min: 1 });
    const email = v.email(body.email, 'email');
    const phone = v.egyptianMobile(body.phone, 'phone', { keep: stored.phone });
    const roleIn = body.role === undefined ? undefined : v.oneOf(normalizeRole(body.role), 'role', ROLES);
    const title = v.string(body.title, 'title');
    const department = v.string(body.department, 'department');
    const departmentId = v.int(body.departmentId ?? body.department_id, 'departmentId', { min: 1 });
    const jobtitleId = v.int(body.jobtitleId ?? body.jobtitle_id, 'jobtitleId', { min: 1 });
    const parentProvided = 'teamLeaderId' in body || 'parent_id' in body;
    const parentId = parentProvided ? v.int(body.teamLeaderId ?? body.parent_id, 'teamLeaderId', { min: 1 }) : undefined;
    const active = v.bool(body.isActive ?? body.status);
    const avatar = validateAvatar(body.avatar ?? body.image, v);
    const newPassword = [body.password, body.newPassword].find((p) => typeof p === 'string' && p !== '') ?? '';
    v.assert();
    let hash = null;
    if (newPassword) {
      const problem = checkPasswordStrength(newPassword, { email: email ?? undefined, name: name ?? undefined });
      if (problem) throw badRequest(problem, [{ field: 'password', message: problem }]);
      hash = await passwords.hash(newPassword);
    }

    const result = await db.tx(async (tx) => {
      const existing = await tx.one('SELECT * FROM users WHERE id = ? FOR UPDATE', [id]);
      if (!existing) throw notFound('User not found');
      const wasSuper = SUPER_ROLES.has(normalizeRole(existing.role)) && Number(existing.status ?? 1) === 1;
      const nextRole = roleIn ?? normalizeRole(existing.role);
      const nextActive = active ?? Number(existing.status ?? 1) === 1;
      const staysSuper = SUPER_ROLES.has(nextRole) && nextActive;
      if (Number(actor.id) === id && wasSuper && !staysSuper) throw conflict('You cannot remove your own administrator access', 'SELF_LOCKOUT');
      if (Number(actor.id) === id && !nextActive) throw conflict('You cannot disable your own account', 'SELF_LOCKOUT');
      if (wasSuper && !staysSuper) await assertAnotherSuperRemains(tx, id);
      if (email !== undefined && email !== String(existing.email).toLowerCase()) await assertEmailFree(tx, email, id);
      if (parentProvided) await assertParentValid(tx, parentId ?? null, id);
      await assertRefExists(tx, 'departments', departmentId, 'department');
      await assertRefExists(tx, 'jobtitles', jobtitleId, 'job title');
      const now = nowSql();
      const nextParent = parentProvided ? parentId ?? null : existing.parent_id ?? null;
      const changes = {
        name: name ?? existing.name, email: email ?? existing.email, phone: phone ?? existing.phone ?? '', role: nextRole,
        title: title ?? existing.title ?? null, department: department ?? existing.department ?? null,
        department_id: departmentId ?? existing.department_id ?? null, jobtitle_id: jobtitleId ?? existing.jobtitle_id ?? null,
        parent_id: nextParent, teamLeaderId: nextParent,
        status: nextActive ? 1 : 0, isActive: nextActive ? 1 : 0, is_active: nextActive ? 1 : 0,
        image: avatar ?? existing.image ?? DEFAULT_USER_IMAGE, updated_at: now,
      };
      if (hash) { changes.password = hash; changes.password_changed_at = now; }
      const filtered = schema.only('users', changes);
      const cols = Object.keys(filtered);
      await tx.exec(`UPDATE users SET ${cols.map((c) => `\`${c}\` = ?`).join(', ')} WHERE id = ?`, [...cols.map((c) => filtered[c]), id]);
      if (changes.name !== existing.name || Number(nextParent ?? 0) !== Number(existing.parent_id ?? 0) || nextRole !== normalizeRole(existing.role)) {
        await refreshReportsForUser(tx, id);
      }
      return { before: existing, passwordChanged: Boolean(hash) };
    }, { tables: ['users'] });

    await audit({
      userId: actor.id, entityType: 'users', entityId: id, action: 'updated', summary: `User updated: ${result.before.name}`,
      metadata: { fields: Object.keys(body).filter((k) => !/pass/i.test(k)), passwordChanged: result.passwordChanged },
    });
    res.json({ ok: true, item: serializeUser(await loadPublic(db, id)) });
  }));

  router.delete('/users/:id', asyncHandler(async (req, res) => {
    requireSuper(req.currentUser);
    const id = parseId(req.params.id);
    if (Number(req.currentUser.id) === id) throw conflict('You cannot delete your own account', 'SELF_LOCKOUT');
    const removed = await db.tx(async (tx) => {
      const existing = await tx.one('SELECT * FROM users WHERE id = ? FOR UPDATE', [id]);
      if (!existing) throw notFound('User not found');
      if (SUPER_ROLES.has(normalizeRole(existing.role)) && Number(existing.status ?? 1) === 1) await assertAnotherSuperRemains(tx, id);
      // The production schema has no foreign keys: emulate ON DELETE SET NULL so nothing points at a missing user.
      const nullify = async (table, setSql, where = 'user_id') => {
        if (schema.hasTable(table) && schema.has(table, where)) await tx.exec(`UPDATE \`${table}\` SET ${setSql} WHERE \`${where}\` = ?`, [id]);
      };
      const leadSets = ['user_id = NULL', ...['assignedToId', 'assignedTo', 'teamLeaderId', 'teamLeader'].filter((c) => schema.has('leads', c)).map((c) => `${c} = NULL`)];
      await nullify('leads', leadSets.join(', '));
      await nullify('cold_calls', 'user_id = NULL');
      await nullify('deals', 'user_id = NULL');
      await nullify('users', `parent_id = NULL${schema.has('users', 'teamLeaderId') ? ', teamLeaderId = NULL' : ''}`, 'parent_id');
      await nullify('tasks', 'assigned_to_id = NULL', 'assigned_to_id');
      await nullify('pipeline', 'owner_id = NULL', 'owner_id');
      await nullify('call_history', 'user_id = NULL');
      await nullify('calendar_events', 'user_id = NULL');
      if (schema.hasTable('notifications')) await tx.exec('DELETE FROM notifications WHERE user_id = ?', [id]);
      await tx.exec('DELETE FROM users WHERE id = ?', [id]);
      return existing;
    });
    await audit({ userId: req.currentUser.id, entityType: 'users', entityId: id, action: 'deleted', summary: `User deleted: ${removed.name}`, metadata: { email: removed.email, role: removed.role } });
    res.json({ ok: true });
  }));

  return router;
}

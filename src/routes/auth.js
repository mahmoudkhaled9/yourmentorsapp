import express from 'express';
import { asyncHandler, AppError, badRequest, conflict, tooMany } from '../http/errors.js';
import { createCounter, rateLimitMiddleware } from '../http/rateLimit.js';
import { smallJsonParser } from '../http/middleware.js';
import { Validator, bodyOf } from '../lib/validate.js';
import { checkPasswordStrength } from '../auth/passwords.js';
import { isActiveUser } from '../auth/policy.js';
import { serializeUser, DEFAULT_USER_IMAGE } from '../domain/serializers.js';
import { refreshReportsForUser } from '../domain/reports.js';
import { nowSql } from '../lib/dates.js';

const LOGIN_COLUMNS = 'id, name, email, phone, password, role, title, department, department_id, jobtitle_id, parent_id, status, image, created_at, updated_at';
const PUBLIC_COLUMNS = 'id, name, email, phone, role, title, department, department_id, jobtitle_id, parent_id, status, image, created_at, updated_at';

/** Accepts '' (reset to default), an http(s) URL, or a small base64 image data-URL. */
export function validateAvatar(value, v, field = 'avatar') {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return v.fail(field, 'must be text');
  const s = value.trim();
  if (!s) return DEFAULT_USER_IMAGE;
  if (/^https?:\/\/[^\s"'<>]{1,500}$/i.test(s)) return s;
  if (/^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(s)) {
    return s.length <= 400000 ? s : v.fail(field, 'image is too large (max ~300 KB)');
  }
  return v.fail(field, 'must be an image (png, jpg, webp, gif) or an http(s) URL');
}

/** Public routes: login only. Mounted BEFORE authentication. */
export function publicAuthRoutes(ctx) {
  const { db, passwords, tokens, config, audit, logger } = ctx;
  const router = express.Router();
  const perIp = createCounter({ windowMs: 60000, max: config.limits.loginPerIpPerMin });
  const failures = createCounter({ windowMs: 15 * 60000, max: config.limits.loginFailuresPer15Min });
  ctx.onClose.push(() => { perIp.stop(); failures.stop(); });

  router.post(
    '/auth/login',
    smallJsonParser(),
    rateLimitMiddleware(perIp, { keyFn: (req) => req.ip, message: 'Too many sign-in attempts from this network, please wait a minute' }),
    asyncHandler(async (req, res) => {
      const body = bodyOf(req);
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      if (!email || !password) throw badRequest('Email and password are required');
      if (email.length > 255 || password.length > 200) throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');

      const key = `${req.ip}|${email}`;
      const state = failures.peek(key);
      if (state.limited) throw tooMany('Too many failed attempts for this account, try again later', state.retryAfterSec);

      const user = await db.one(`SELECT ${LOGIN_COLUMNS} FROM users WHERE LOWER(email) = ? ORDER BY id ASC LIMIT 1`, [email]);
      const valid = await passwords.verify(password, user?.password ?? passwords.dummyHash);
      if (!user || !valid) {
        failures.hit(key);
        logger.warn('failed sign-in', { requestId: req.id, ip: req.ip });
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
      }
      if (!isActiveUser(user)) throw new AppError(403, 'ACCOUNT_DISABLED', 'This account is disabled. Please contact your administrator.');
      failures.reset(key);
      await audit({ userId: user.id, entityType: 'auth', entityId: user.id, action: 'login', summary: `Signed in: ${user.email}` });
      res.json({ token: tokens.issue(user), user: serializeUser(user), expiresIn: config.jwt.expiresIn });
    })
  );
  return router;
}

/** Routes for the signed-in user. Mounted AFTER authentication. */
export function accountRoutes(ctx) {
  const { db, passwords, tokens, audit } = ctx;
  const router = express.Router();
  const pwFailures = createCounter({ windowMs: 15 * 60000, max: 5 });
  ctx.onClose.push(() => pwFailures.stop());

  router.get('/auth/me', (req, res) => res.json({ user: serializeUser(req.currentUser) }));
  router.get('/profile', (req, res) => res.json({ user: serializeUser(req.currentUser) }));

  const updateProfile = asyncHandler(async (req, res) => {
    const body = bodyOf(req);
    const me = req.currentUser;
    const v = new Validator();
    const name = v.string(body.name, 'name', { min: 1, max: 255 });
    const email = v.email(body.email, 'email');
    if (email === '') v.fail('email', 'cannot be empty (it is what you sign in with)');
    const phone = v.egyptianMobile(body.phone, 'phone', { keep: me.phone });
    const image = validateAvatar(body.avatar ?? body.image, v);
    v.assert();
    // Only name, e-mail, phone and picture are self-service. Role, team, status ... are never read from this body, and the
    // account edited is always the one the token belongs to (an id in the body is ignored).
    const next = { name: name ?? me.name, email: email ?? me.email, phone: phone ?? me.phone ?? '', image: image ?? me.image ?? DEFAULT_USER_IMAGE };
    const emailChanged = String(next.email).toLowerCase() !== String(me.email).toLowerCase();
    await db.tx(async (tx) => {
      if (emailChanged) {
        const taken = await tx.one('SELECT id FROM users WHERE LOWER(email) = ? AND id <> ? LIMIT 1', [String(next.email).toLowerCase(), me.id]);
        if (taken) throw conflict('A user with this email already exists', 'EMAIL_TAKEN', [{ field: 'email', message: 'is already used by another account' }]);
      }
      await tx.exec('UPDATE users SET name = ?, email = ?, phone = ?, image = ?, updated_at = ? WHERE id = ?', [next.name, next.email, next.phone, next.image, nowSql(), me.id]);
      if (next.name !== me.name) await refreshReportsForUser(tx, me.id);
    });
    const fresh = await db.one(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = ?`, [me.id]);
    await audit({ userId: me.id, entityType: 'users', entityId: me.id, action: 'updated', summary: emailChanged ? `Profile updated (email changed to ${next.email})` : 'Profile updated' });
    res.json({ user: serializeUser(fresh) });
  });
  router.put('/profile', updateProfile);
  router.patch('/profile', updateProfile);

  router.post('/auth/change-password', asyncHandler(async (req, res) => {
    const body = bodyOf(req);
    const current = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    const next = typeof body.newPassword === 'string' ? body.newPassword : '';
    if (!current || !next) throw badRequest('Current password and new password are required');
    const me = req.currentUser;
    const key = String(me.id);
    const state = pwFailures.peek(key);
    if (state.limited) throw tooMany('Too many failed attempts, try again later', state.retryAfterSec);

    const row = await db.one('SELECT password FROM users WHERE id = ?', [me.id]);
    // 400 (not 401): a 401 makes the frontend sign the person out, which is wrong for a typo in the old password.
    if (!(await passwords.verify(current, row?.password))) {
      pwFailures.hit(key);
      throw new AppError(400, 'INVALID_CURRENT_PASSWORD', 'Current password is incorrect');
    }
    const problem = checkPasswordStrength(next, { email: me.email, name: me.name });
    if (problem) throw badRequest(problem, [{ field: 'newPassword', message: problem }]);
    if (current === next) throw badRequest('The new password must be different from the current one');

    const now = nowSql();
    await db.exec('UPDATE users SET password = ?, password_changed_at = ?, updated_at = ? WHERE id = ?', [await passwords.hash(next), now, now, me.id]);
    pwFailures.reset(key);
    await audit({ userId: me.id, entityType: 'users', entityId: me.id, action: 'password_changed', summary: 'Password changed' });
    // Every older token is now rejected (see authenticate); hand back a fresh one so this session continues.
    res.json({ ok: true, token: tokens.issue({ id: me.id, role: me.role }) });
  }));

  return router;
}

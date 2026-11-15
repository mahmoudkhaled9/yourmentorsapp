import jwt from 'jsonwebtoken';
import { normalizeRole } from './policy.js';

/**
 * Password version of a user: when the password last changed, in whole seconds (0 = never). Stored in every token as
 * `pwv` and compared EXACTLY on each request, so a password change revokes even a token issued in the same second
 * (comparing `iat` alone could not tell them apart). Pass the user row as read from the database.
 */
export const passwordVersion = (user) => {
  const t = user?.password_changed_at ? new Date(user.password_changed_at).getTime() : 0;
  return Number.isFinite(t) && t > 0 ? Math.floor(t / 1000) : 0;
};

export function createTokenService({ secret, expiresIn }) {
  return {
    issue(user) {
      return jwt.sign({ sub: String(user.id), role: normalizeRole(user.role), pwv: passwordVersion(user) }, secret, { algorithm: 'HS256', expiresIn });
    },
    /** Throws when invalid/expired. Pinning the algorithm blocks "alg: none" and algorithm-confusion tokens. */
    verify(token) {
      return jwt.verify(token, secret, { algorithms: ['HS256'] });
    },
  };
}

import jwt from 'jsonwebtoken';
import { normalizeRole } from './policy.js';

export function createTokenService({ secret, expiresIn }) {
  return {
    issue(user) {
      return jwt.sign({ sub: String(user.id), role: normalizeRole(user.role) }, secret, { algorithm: 'HS256', expiresIn });
    },
    /** Throws when invalid/expired. Pinning the algorithm blocks "alg: none" and algorithm-confusion tokens. */
    verify(token) {
      return jwt.verify(token, secret, { algorithms: ['HS256'] });
    },
  };
}

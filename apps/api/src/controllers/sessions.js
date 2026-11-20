import { z } from 'zod';
import { fields, parseInput } from '../http/validate.js';
import { requestContext } from '../http/auth.js';
import { sessionCookieName, sessionCookieOptions, withoutMaxAge } from '../http/cookies.js';
import { getUserProfile } from '../services/accounts.js';
import { listSessions, revokeSession, signOut } from '../services/sessions.js';

const sessionParams = z.strictObject({ sessionId: fields.uuid });

export function createSessionController({ pool, config, notifier }) {
  return {
    /** GET /api/session (browser): who am I? */
    async current(req, res) {
      const { sessionId, userId, expiresAt } = req.browserSession;
      res.json({ user: await getUserProfile(pool, userId), session: { id: sessionId, expiresAt } });
    },

    /** POST /api/session/logout (browser) */
    async logout(req, res) {
      await signOut(pool, notifier, req.sessionToken, requestContext(req));
      res.clearCookie(sessionCookieName(config), withoutMaxAge(sessionCookieOptions(config)));
      res.status(204).end();
    },

    /** GET /api/sessions (phone) */
    async list(req, res) {
      res.json({ sessions: await listSessions(pool, config, req.device.userId) });
    },

    /** DELETE /api/sessions/:sessionId (phone) */
    async revoke(req, res) {
      const { sessionId } = parseInput(sessionParams, req.params);
      await revokeSession(pool, notifier, req.device, sessionId, requestContext(req));
      res.status(204).end();
    },
  };
}

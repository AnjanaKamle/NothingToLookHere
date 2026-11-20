import { authenticateDevice } from '../services/devices.js';
import { authenticateSession } from '../services/sessions.js';
import { sessionCookieName } from './cookies.js';
import { unauthorized } from './errors.js';

/** Request metadata stored with challenges, sessions and audit events. */
export function requestContext(req) {
  const userAgent = req.get('user-agent');
  return { ip: req.ip ?? null, userAgent: userAgent ? userAgent.slice(0, 512) : null };
}

/**
 * Phone authentication: "Authorization: Bearer <deviceToken>" (issued once at enrollment).
 * Sets req.device = { deviceId, userId }.
 */
export function requireDevice({ pool }) {
  return async (req, _res, next) => {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.get('authorization') ?? '');
    const device = match ? await authenticateDevice(pool, match[1]) : null;
    if (!device)
      return next(unauthorized('device_auth_required', 'A valid device token is required'));
    req.device = device;
    next();
  };
}

/** Browser authentication via the session cookie. Sets req.browserSession. */
export function requireBrowserSession({ pool, config }) {
  return async (req, _res, next) => {
    const token = req.cookies[sessionCookieName(config)];
    const session = await authenticateSession(pool, config, token);
    if (!session) return next(unauthorized('session_required', 'Sign in to continue'));
    req.browserSession = session;
    req.sessionToken = token;
    next();
  };
}

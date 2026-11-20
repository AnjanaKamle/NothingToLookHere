import { Router } from 'express';
import { requireBrowserSession, requireDevice } from '../http/auth.js';
import { requireTrustedOrigin } from '../http/middleware.js';
import { createAuthController } from '../controllers/auth.js';
import { createDeviceController } from '../controllers/devices.js';
import { createLoginController } from '../controllers/login.js';
import { createRecoveryController } from '../controllers/recovery.js';
import { createSessionController } from '../controllers/sessions.js';

/**
 * All feature routes. Three kinds of caller:
 *   phone   - Authorization: Bearer <deviceToken>          (requireDevice)
 *   browser - session or binding cookie + trusted Origin   (requireTrustedOrigin, requireBrowserSession)
 *   public  - password login, enrollment, recovery         (rate-limited)
 * Full reference: docs/API.md
 */
export function createApiRouter(deps, limits) {
  const router = Router();
  const device = requireDevice(deps);
  const browserSession = requireBrowserSession(deps);
  const trustedOrigin = requireTrustedOrigin(deps.config.webOrigins);

  const auth = createAuthController(deps);
  const devices = createDeviceController(deps);
  const login = createLoginController(deps);
  const sessions = createSessionController(deps);
  const recovery = createRecoveryController(deps);

  // Account sign-in and phone enrollment
  router.post('/auth/password-login', limits.passwordLogin, auth.passwordLogin);
  router.post('/devices/enroll', limits.enrollment, devices.enroll);
  router.get('/devices', device, devices.list);
  router.post('/devices/me/key-rotation', limits.enrollment, device, devices.startKeyRotation);
  router.post('/devices/me/keys', limits.enrollment, device, devices.rotateKey);
  router.post('/devices/:deviceId/revoke', device, devices.revoke);
  router.get('/activity', device, devices.activity);

  // QR login
  router.post('/login/challenges', limits.createChallenge, trustedOrigin, login.create);
  router.get('/login/challenges/:challengeId', login.status);
  router.post('/login/challenges/:challengeId/inspect', limits.phoneAction, device, login.inspect);
  router.post('/login/challenges/:challengeId/decision', limits.phoneAction, device, login.decide);
  router.post('/login/challenges/:challengeId/complete', trustedOrigin, login.complete);

  // Browser session
  router.get('/session', browserSession, sessions.current);
  router.post('/session/logout', trustedOrigin, browserSession, sessions.logout);

  // Session management from the phone
  router.get('/sessions', device, sessions.list);
  router.delete('/sessions/:sessionId', device, sessions.revoke);

  // Recovery
  router.post('/recovery', limits.recovery, recovery.recover);
  router.get('/recovery/codes', device, recovery.remaining);
  router.post('/recovery/codes', device, recovery.regenerate);

  return router;
}

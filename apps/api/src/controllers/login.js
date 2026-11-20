import { z } from 'zod';
import { Decision } from '@capstone/protocol';
import { fields, parseInput } from '../http/validate.js';
import { requestContext } from '../http/auth.js';
import {
  bindingCookieName,
  bindingCookieOptions,
  sessionCookieName,
  sessionCookieOptions,
  withoutMaxAge,
} from '../http/cookies.js';
import {
  completeLogin,
  createLoginChallenge,
  decideChallenge,
  getChallengeStatusForBrowser,
  inspectChallenge,
} from '../services/login.js';

const challengeParams = z.strictObject({ challengeId: fields.uuid });
const inspectSchema = z.strictObject({ nonce: fields.nonce });
const decisionSchema = z.strictObject({
  nonce: fields.nonce,
  keyId: fields.uuid,
  decision: z.enum([Decision.APPROVED, Decision.DENIED]),
  signature: fields.base64url(100),
});

export function createLoginController({ pool, config, notifier }) {
  const bindingFrom = (req, challengeId) => req.cookies[bindingCookieName(config, challengeId)];

  return {
    /** POST /api/login/challenges (browser) */
    async create(req, res) {
      const challenge = await createLoginChallenge(pool, config, requestContext(req));
      res.cookie(
        bindingCookieName(config, challenge.challengeId),
        challenge.bindingSecret,
        bindingCookieOptions(config, challenge.challengeId),
      );
      res.status(201).json({
        challengeId: challenge.challengeId,
        expiresAt: challenge.expiresAt,
        qrPayload: challenge.qrPayload,
        watchToken: challenge.watchToken,
      });
    },

    /** GET /api/login/challenges/:challengeId (browser, binding cookie) */
    async status(req, res) {
      const { challengeId } = parseInput(challengeParams, req.params);
      res.json(
        await getChallengeStatusForBrowser(
          pool,
          config,
          challengeId,
          bindingFrom(req, challengeId),
        ),
      );
    },

    /** POST /api/login/challenges/:challengeId/inspect (phone) */
    async inspect(req, res) {
      const { challengeId } = parseInput(challengeParams, req.params);
      const { nonce } = parseInput(inspectSchema, req.body);
      res.json(await inspectChallenge(pool, config, challengeId, nonce));
    },

    /** POST /api/login/challenges/:challengeId/decision (phone) */
    async decide(req, res) {
      const { challengeId } = parseInput(challengeParams, req.params);
      const input = parseInput(decisionSchema, req.body);
      res.json(
        await decideChallenge(
          pool,
          config,
          notifier,
          req.device,
          challengeId,
          input,
          requestContext(req),
        ),
      );
    },

    /** POST /api/login/challenges/:challengeId/complete (browser, binding cookie) */
    async complete(req, res) {
      const { challengeId } = parseInput(challengeParams, req.params);
      const result = await completeLogin(
        pool,
        config,
        challengeId,
        bindingFrom(req, challengeId),
        requestContext(req),
      );
      res.clearCookie(
        bindingCookieName(config, challengeId),
        withoutMaxAge(bindingCookieOptions(config, challengeId)),
      );
      res.cookie(sessionCookieName(config), result.sessionToken, sessionCookieOptions(config));
      res.json({ user: result.user, session: result.session });
    },
  };
}

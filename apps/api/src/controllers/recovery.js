import { z } from 'zod';
import { fields, parseInput } from '../http/validate.js';
import { requestContext } from '../http/auth.js';
import {
  countRemainingCodes,
  generateRecoveryCodes,
  recoverAccount,
} from '../services/recovery.js';

const recoverSchema = z.strictObject({
  email: fields.email,
  password: fields.password,
  recoveryCode: z.string().min(1).max(32),
  newPassword: fields.newPassword.optional(),
});

export function createRecoveryController({ pool, config, notifier }) {
  return {
    /** POST /api/recovery: lost phone. Password + recovery code; returns an enrollment challenge. */
    async recover(req, res) {
      const input = parseInput(recoverSchema, req.body);
      res.json(await recoverAccount(pool, config, notifier, input, requestContext(req)));
    },

    /** POST /api/recovery/codes (phone): replace the recovery codes; shown once. */
    async regenerate(req, res) {
      const codes = await generateRecoveryCodes(pool, req.device.userId, requestContext(req));
      res.status(201).json({ recoveryCodes: codes });
    },

    /** GET /api/recovery/codes (phone): how many unused codes remain. */
    async remaining(req, res) {
      res.json({ remaining: await countRemainingCodes(pool, req.device.userId) });
    },
  };
}

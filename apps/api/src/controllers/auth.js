import { z } from 'zod';
import { fields, parseInput } from '../http/validate.js';
import { requestContext } from '../http/auth.js';
import { passwordLogin } from '../services/accounts.js';

const passwordLoginSchema = z.strictObject({ email: fields.email, password: fields.password });

export function createAuthController({ pool, config }) {
  return {
    /** POST /api/auth/password-login: initial phone sign-in; returns an enrollment challenge. */
    async passwordLogin(req, res) {
      const input = parseInput(passwordLoginSchema, req.body);
      res.json(await passwordLogin(pool, config, input, requestContext(req)));
    },
  };
}

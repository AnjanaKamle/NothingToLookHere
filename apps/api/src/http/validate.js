import { z } from 'zod';
import { NONCE_PATTERN, UUID_PATTERN } from '@capstone/protocol';
import { badRequest } from './errors.js';

/** Parses input with a zod schema or throws a 400 listing every problem field. */
export function parseInput(schema, input) {
  const result = schema.safeParse(input ?? {});
  if (result.success) return result.data;
  throw badRequest(
    'invalid_request',
    'The request is missing fields or contains invalid values',
    result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
  );
}

// Reusable field schemas.
export const fields = {
  uuid: z.string().regex(UUID_PATTERN, 'Must be a lower-case UUID'),
  nonce: z.string().regex(NONCE_PATTERN, 'Must be 32 bytes, base64url encoded (43 characters)'),
  email: z.string().trim().toLowerCase().max(254).pipe(z.email('Must be an email address')),
  password: z.string().min(1).max(1024),
  newPassword: z.string().min(12, 'Must be at least 12 characters').max(1024),
  /** DER bytes in unpadded base64url. Length limits are applied after decoding. */
  base64url: (maxChars) =>
    z
      .string()
      .min(1)
      .max(maxChars)
      .regex(/^[A-Za-z0-9_-]+$/, 'Must be base64url without padding'),
};

import { randomInt } from 'node:crypto';

/**
 * Recovery codes: 12 characters from Crockford's base32 alphabet (no I, L, O, U), shown as
 * XXXX-XXXX-XXXX. 12 × 5 = 60 random bits each, drawn with crypto.randomInt (CSPRNG, unbiased).
 * Input is normalised so users can type lower case, spaces, or confuse O/0 and I/L/1.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const RECOVERY_CODES_PER_BATCH = 10;

export function generateRecoveryCode() {
  let code = '';
  for (let i = 0; i < 12; i += 1) code += ALPHABET[randomInt(ALPHABET.length)];
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
}

/** Canonical form that is hashed and compared: 12 upper-case alphabet characters, or null. */
export function normaliseRecoveryCode(input) {
  if (typeof input !== 'string') return null;
  const code = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return /^[0-9A-HJKMNP-TV-Z]{12}$/.test(code) ? code : null;
}

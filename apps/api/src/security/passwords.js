import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

/**
 * Slow, salted hashing for low-entropy secrets (passwords, recovery codes) with scrypt from
 * node:crypto. Stored as a PHC string: $scrypt$ln=<log2 N>,r=<r>,p=<p>$<salt>$<hash>
 * (salt and hash in unpadded standard base64). Parameters are stored with each hash, so they can
 * be raised later without breaking existing hashes.
 *
 * Passwords: N = 2^17, r = 8, p = 1 (OWASP's scrypt recommendation, ~128 MiB per hash).
 * Recovery codes (60 random bits each): N = 2^15.
 */
export const PASSWORD_COST = Object.freeze({ ln: 17, r: 8, p: 1 });
export const RECOVERY_CODE_COST = Object.freeze({ ln: 15, r: 8, p: 1 });

const KEY_LENGTH = 32;
const PHC_PATTERN =
  /^\$scrypt\$ln=(\d{1,2}),r=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

function derive(secret, salt, { ln, r, p }) {
  const N = 2 ** ln;
  // scrypt needs about 128 * N * r bytes; Node's default cap (32 MiB) is too low for N = 2^17.
  return scrypt(secret.normalize('NFC'), salt, KEY_LENGTH, { N, r, p, maxmem: 256 * N * r });
}

export async function hashSecret(secret, cost = PASSWORD_COST) {
  const salt = randomBytes(16);
  const hash = await derive(secret, salt, cost);
  const b64 = (buffer) => buffer.toString('base64').replace(/=+$/, '');
  return `$scrypt$ln=${cost.ln},r=${cost.r},p=${cost.p}$${b64(salt)}$${b64(hash)}`;
}

/** Returns true if `secret` matches the PHC string. Malformed hashes never match. */
export async function verifySecret(secret, phc) {
  const match = PHC_PATTERN.exec(phc ?? '');
  if (!match) return false;
  const [, ln, r, p, saltText, hashText] = match;
  const cost = { ln: Number(ln), r: Number(r), p: Number(p) };
  if (cost.ln < 10 || cost.ln > 20) return false;
  const expected = Buffer.from(hashText, 'base64');
  const actual = await derive(secret, Buffer.from(saltText, 'base64'), cost);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

let dummyHash;

/**
 * Burns the same time as a real password check when the account does not exist, so response
 * timing does not reveal which emails are registered.
 */
export async function verifyAgainstDummy(secret) {
  dummyHash ??= hashSecret('dummy password for timing equalisation');
  await verifySecret(secret, await dummyHash);
  return false;
}

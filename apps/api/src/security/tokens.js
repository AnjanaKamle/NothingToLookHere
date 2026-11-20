import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** SHA-256 digest as a Buffer (the form stored in bytea columns). */
export function sha256(value) {
  return createHash('sha256').update(value).digest();
}

/**
 * A new random secret: 32 bytes from the OS CSPRNG, returned as base64url text (to hand to the
 * client) and as its SHA-256 (to store). The plain value is never stored or logged.
 */
export function newSecret() {
  const value = randomBytes(32).toString('base64url');
  return { value, hash: sha256(value) };
}

/** A new 32-byte nonce as base64url text, plus the SHA-256 of that text for storage. */
export function newNonce() {
  return newSecret();
}

/** Decodes strict, unpadded base64url. Returns null for anything non-canonical. */
export function decodeBase64Url(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const bytes = Buffer.from(text, 'base64url');
  return bytes.toString('base64url') === text ? bytes : null;
}

export function hmacSha256(key, message) {
  return createHmac('sha256', key).update(message).digest();
}

/** Constant-time comparison of two equal-purpose byte strings. */
export function safeEqual(a, b) {
  return a.length === b.length && timingSafeEqual(a, b);
}

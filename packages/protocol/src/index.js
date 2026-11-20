/**
 * @capstone/protocol
 *
 * Values and message formats that the API, the browser, and the phone must agree on exactly.
 *
 * This package contains no cryptography and no I/O. It defines *what bytes are signed*; each
 * runtime signs or verifies them with its own platform crypto:
 *   - phone: ECDSA P-256 / SHA-256 inside the Secure Enclave or Android Keystore (DER signature)
 *   - API:   node:crypto verify('sha256', message, spkiPublicKey, signature)
 * See docs/API.md, "Cryptography", and test-vectors/ for a worked example.
 */

/** Bumped whenever a client-visible message format changes. Reported by GET /api/health. */
export const PROTOCOL_VERSION = 1;

/** Signature algorithm used for every device signature (JOSE name). */
export const SIGNATURE_ALGORITHM = 'ES256';

/** Prefix of the text encoded in the login QR code. The phone ignores QR codes without it. */
export const QR_PAYLOAD_PREFIX = 'capstone-auth:v1:';

/** Socket.IO event names. */
export const SocketEvents = Object.freeze({
  /** Browser -> API: subscribe to one login challenge. Payload { challengeId, watchToken }. */
  WATCH_LOGIN: 'login:watch',
  /** API -> browser: the phone approved; complete sign-in with POST .../complete. */
  LOGIN_APPROVED: 'login:approved',
  /** API -> browser: the phone declined the request. */
  LOGIN_DENIED: 'login:denied',
  /** API -> browser: the challenge expired before a decision. */
  LOGIN_EXPIRED: 'login:expired',
  /** API -> browser: this browser's session was revoked (sign the user out). */
  SESSION_REVOKED: 'session:revoked',
});

/** Bounds for the QR challenge lifetime. The API rejects configuration outside this range. */
export const LOGIN_CHALLENGE_TTL = Object.freeze({ minSeconds: 15, maxSeconds: 300 });

/** Challenge states as reported to clients. "expired" is derived, never stored. */
export const ChallengeStatus = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  DENIED: 'denied',
  CONSUMED: 'consumed',
  EXPIRED: 'expired',
});

export const Decision = Object.freeze({ APPROVED: 'approved', DENIED: 'denied' });

// ---------------------------------------------------------------------------------------------
// Field formats
// ---------------------------------------------------------------------------------------------

/** Lower-case RFC 9562 UUID text form, as PostgreSQL returns it. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** 32 random bytes in unpadded base64url (43 characters). Used for nonces. */
export const NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** Server-configured audience string: lower-case DNS-like label. */
export const AUDIENCE_PATTERN = /^[a-z0-9][a-z0-9.-]{0,62}$/;

function assertField(name, value, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new TypeError(`Invalid ${name} for signed message`);
  }
}

// ---------------------------------------------------------------------------------------------
// Signed messages
//
// Each message is plain ASCII: a fixed first line naming the purpose and version, then
// "name=value" lines in a fixed order, joined by "\n" (LF), with no trailing newline.
// Every field is validated against a pattern that cannot contain "\n" or "=", so the encoding is
// unambiguous. The phone signs the UTF-8 (= ASCII) bytes of this string.
// ---------------------------------------------------------------------------------------------

/**
 * The message a phone signs to approve or deny a QR login.
 * It binds the decision to one specific challenge (id + one-time nonce from the QR code), to this
 * server (audience), and to the key that signs it, so it cannot be reused for anything else.
 */
export function buildLoginDecisionMessage({ audience, challengeId, nonce, keyId, decision }) {
  assertField('audience', audience, AUDIENCE_PATTERN);
  assertField('challengeId', challengeId, UUID_PATTERN);
  assertField('nonce', nonce, NONCE_PATTERN);
  assertField('keyId', keyId, UUID_PATTERN);
  if (decision !== Decision.APPROVED && decision !== Decision.DENIED) {
    throw new TypeError('Invalid decision for signed message');
  }
  return [
    'capstone-auth/login-decision/v1',
    `audience=${audience}`,
    `challenge=${challengeId}`,
    `nonce=${nonce}`,
    `key=${keyId}`,
    `decision=${decision}`,
  ].join('\n');
}

/**
 * The message a phone signs with a newly generated key to prove it holds that key
 * (proof of possession), during enrollment or key rotation.
 */
export function buildEnrollmentMessage({ audience, enrollmentId, nonce }) {
  assertField('audience', audience, AUDIENCE_PATTERN);
  assertField('enrollmentId', enrollmentId, UUID_PATTERN);
  assertField('nonce', nonce, NONCE_PATTERN);
  return [
    'capstone-auth/enroll/v1',
    `audience=${audience}`,
    `enrollment=${enrollmentId}`,
    `nonce=${nonce}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------
// QR payload: "capstone-auth:v1:<challengeId>.<nonce>"
// Contains only the challenge id and its one-time nonce. No credentials, tokens or cookies.
// ---------------------------------------------------------------------------------------------

export function formatQrPayload({ challengeId, nonce }) {
  assertField('challengeId', challengeId, UUID_PATTERN);
  assertField('nonce', nonce, NONCE_PATTERN);
  return `${QR_PAYLOAD_PREFIX}${challengeId}.${nonce}`;
}

/** Returns { challengeId, nonce } or null if the text is not a valid login QR payload. */
export function parseQrPayload(text) {
  if (typeof text !== 'string' || !text.startsWith(QR_PAYLOAD_PREFIX)) return null;
  const [challengeId, nonce, ...rest] = text.slice(QR_PAYLOAD_PREFIX.length).split('.');
  if (rest.length || !UUID_PATTERN.test(challengeId ?? '') || !NONCE_PATTERN.test(nonce ?? '')) {
    return null;
  }
  return { challengeId, nonce };
}

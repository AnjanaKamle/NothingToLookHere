import { buildEnrollmentMessage } from '@capstone/protocol';
import { runOne, withTransaction, isUniqueViolation } from '../db/sql.js';
import { badRequest, conflict, forbidden, unauthorized } from '../http/errors.js';
import { parseEs256PublicKey, verifyEs256 } from '../security/signatures.js';
import { decodeBase64Url, newNonce, newSecret, sha256 } from '../security/tokens.js';
import { recordAudit } from './audit.js';

/** Issues a one-time proof-of-possession nonce for `userId` (Q-ENR-01). */
export async function issueEnrollmentChallenge(db, config, userId) {
  const nonce = newNonce();
  const row = await runOne(db, 'Q-ENR-01', [
    userId,
    nonce.hash,
    config.enrollmentChallengeTtlSeconds,
  ]);
  return {
    enrollmentId: row.id,
    nonce: nonce.value,
    expiresAt: row.expires_at,
    audience: config.authAudience,
  };
}

/**
 * Checks that the submitted public key is a valid P-256 key and that the submitted signature
 * over the enrollment message verifies with it. This proves the phone holds the private key.
 * The private key itself is never sent.
 */
function verifyProofOfPossession(config, { enrollmentId, nonce, publicKey, signature }) {
  const spki = decodeBase64Url(publicKey);
  const parsed = spki && parseEs256PublicKey(spki);
  if (!parsed) {
    throw badRequest(
      'invalid_public_key',
      'publicKey must be a P-256 SubjectPublicKeyInfo (DER, base64url)',
    );
  }
  const signatureDer = decodeBase64Url(signature);
  const message = buildEnrollmentMessage({ audience: config.authAudience, enrollmentId, nonce });
  if (!signatureDer || !verifyEs256({ keyObject: parsed.keyObject, message, signatureDer })) {
    throw unauthorized(
      'invalid_signature',
      'Signature does not verify with the submitted public key',
    );
  }
  return parsed.spki;
}

/** Consumes an enrollment challenge inside the caller's transaction (Q-ENR-02). */
async function consumeEnrollment(client, { enrollmentId, nonce }) {
  const row = await runOne(client, 'Q-ENR-02', [enrollmentId, sha256(nonce)]);
  if (!row) {
    throw conflict(
      'enrollment_unavailable',
      'Enrollment challenge is unknown, expired or already used',
    );
  }
  return row.user_id;
}

function translateKeyConflict(error) {
  if (isUniqueViolation(error, 'device_keys_public_key_spki_key')) {
    return conflict('public_key_already_registered', 'This public key is already registered');
  }
  return error;
}

/**
 * Enrolls a new trusted phone (T-ENROLL). Verification happens first; then one transaction
 * consumes the challenge, creates the device and its key, and records the audit event. If any
 * step fails (e.g. duplicate key), nothing is written and the challenge stays usable.
 */
export async function enrollDevice(pool, config, input, context) {
  const spki = verifyProofOfPossession(config, input);
  const deviceToken = newSecret();

  try {
    return await withTransaction(pool, async (client) => {
      const userId = await consumeEnrollment(client, input);
      const device = await runOne(client, 'Q-DEV-01', [
        userId,
        input.deviceName,
        input.platform,
        deviceToken.hash,
      ]);
      const key = await runOne(client, 'Q-KEY-01', [device.id, 'ES256', spki, input.keyStorage]);
      await recordAudit(
        client,
        {
          type: 'device.enrolled',
          userId,
          deviceId: device.id,
          details: { platform: input.platform, keyStorage: input.keyStorage },
        },
        context,
      );
      return {
        device: { id: device.id, keyId: key.id, name: input.deviceName, platform: input.platform },
        deviceToken: deviceToken.value,
        audience: config.authAudience,
      };
    });
  } catch (error) {
    throw translateKeyConflict(error);
  }
}

/**
 * Replaces the authenticated phone's key (T-KEY-ROTATE), e.g. after Android invalidated a
 * biometric-bound key. Requires a fresh enrollment challenge issued to the same user.
 */
export async function rotateDeviceKey(pool, config, auth, input, context) {
  const spki = verifyProofOfPossession(config, input);
  try {
    return await withTransaction(pool, async (client) => {
      const userId = await consumeEnrollment(client, input);
      if (userId !== auth.userId) {
        throw forbidden('enrollment_not_owned', 'Enrollment challenge belongs to another account');
      }
      const revoked = await runOne(client, 'Q-KEY-02', [auth.deviceId]);
      const key = await runOne(client, 'Q-KEY-01', [
        auth.deviceId,
        'ES256',
        spki,
        input.keyStorage,
      ]);
      await recordAudit(
        client,
        {
          type: 'device.key_rotated',
          userId,
          deviceId: auth.deviceId,
          details: { previousKeyId: revoked?.id ?? null },
        },
        context,
      );
      return { keyId: key.id };
    });
  } catch (error) {
    throw translateKeyConflict(error);
  }
}

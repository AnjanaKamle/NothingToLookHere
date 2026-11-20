import { run, runOne, withTransaction } from '../db/sql.js';
import { forbidden, unauthorized } from '../http/errors.js';
import { hashSecret, RECOVERY_CODE_COST, verifySecret } from '../security/passwords.js';
import {
  generateRecoveryCode,
  normaliseRecoveryCode,
  RECOVERY_CODES_PER_BATCH,
} from '../security/recoveryCodes.js';
import { recordAudit, recordAuditBestEffort } from './audit.js';
import { verifyPassword } from './accounts.js';
import { issueEnrollmentChallenge } from './enrollment.js';

/**
 * Issues a fresh batch of recovery codes, revoking the previous batch (T-RECOVERY-CODES).
 * Returns the plain codes; they are shown once and stored only as scrypt hashes.
 */
export async function generateRecoveryCodes(pool, userId, context) {
  const codes = Array.from({ length: RECOVERY_CODES_PER_BATCH }, generateRecoveryCode);
  // Hash before opening the transaction so the transaction stays short.
  const hashes = await Promise.all(
    codes.map((code) => hashSecret(normaliseRecoveryCode(code), RECOVERY_CODE_COST)),
  );
  await withTransaction(pool, async (client) => {
    await run(client, 'Q-REC-01', [userId]);
    const batch = await runOne(client, 'Q-REC-02', [userId]);
    await run(client, 'Q-REC-03', [batch.id, hashes]);
    await recordAudit(client, { type: 'recovery.codes_generated', userId }, context);
  });
  return codes;
}

export async function countRemainingCodes(db, userId) {
  const row = await runOne(db, 'Q-REC-06', [userId]);
  return row.remaining;
}

const INVALID = () =>
  unauthorized('invalid_credentials', 'Email, password or recovery code is incorrect');

/**
 * Lost-phone recovery (docs/RECOVERY.md). Requires the account password AND one unused recovery
 * code. On success, in one transaction (T-RECOVERY): the code is spent (single use, Q-REC-05),
 * every session, key and device of the account is revoked, the remaining codes are revoked,
 * the password is optionally replaced, and an enrollment challenge for the new phone is issued.
 */
export async function recoverAccount(pool, config, notifier, input, context) {
  const { user, ok } = await verifyPassword(pool, input.email, input.password);
  if (!ok) {
    await recordAuditBestEffort(
      pool,
      {
        type: 'recovery.failed',
        userId: user?.id,
        details: { reason: user ? 'wrong_password' : 'unknown_email' },
      },
      context,
    );
    throw INVALID();
  }
  if (user.disabled_at) throw forbidden('account_disabled', 'This account is disabled');

  const code = normaliseRecoveryCode(input.recoveryCode);
  const { rows: candidates } = await run(pool, 'Q-REC-04', [user.id]);
  let codeId = null;
  for (const candidate of candidates) {
    // Check every candidate so timing does not reveal the code's position.
    if (code && (await verifySecret(code, candidate.code_hash)) && !codeId) codeId = candidate.id;
  }
  if (!codeId) {
    await recordAuditBestEffort(
      pool,
      { type: 'recovery.failed', userId: user.id, details: { reason: 'wrong_code' } },
      context,
    );
    throw INVALID();
  }

  const newPasswordHash = input.newPassword ? await hashSecret(input.newPassword) : null;

  const result = await withTransaction(pool, async (client) => {
    const spent = await runOne(client, 'Q-REC-05', [codeId, user.id]);
    if (!spent) throw INVALID(); // a concurrent attempt spent it first
    await recordAudit(client, { type: 'recovery.code_used', userId: user.id }, context);

    const { rows: sessions } = await run(client, 'Q-SES-07', [user.id]);
    const { rows: keys } = await run(client, 'Q-KEY-04', [user.id]);
    const { rows: devices } = await run(client, 'Q-DEV-06', [user.id]);
    await run(client, 'Q-REC-01', [user.id]);
    if (newPasswordHash) {
      await run(client, 'Q-USR-04', [user.id, newPasswordHash]);
      await recordAudit(
        client,
        { type: 'user.password_changed', userId: user.id, details: { via: 'recovery' } },
        context,
      );
    }
    const enrollment = await issueEnrollmentChallenge(client, config, user.id);
    await recordAudit(
      client,
      {
        type: 'recovery.completed',
        userId: user.id,
        details: {
          devicesRevoked: devices.length,
          keysRevoked: keys.length,
          sessionsRevoked: sessions.length,
        },
      },
      context,
    );
    return { enrollment, sessionIds: sessions.map((s) => s.id), devicesRevoked: devices.length };
  });

  notifier.sessionsRevoked(result.sessionIds);
  return {
    enrollment: result.enrollment,
    revoked: { devices: result.devicesRevoked, sessions: result.sessionIds.length },
    passwordChanged: Boolean(newPasswordHash),
  };
}

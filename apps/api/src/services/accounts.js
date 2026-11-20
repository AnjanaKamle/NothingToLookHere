import { runOne, withTransaction, isUniqueViolation } from '../db/sql.js';
import { conflict, forbidden, unauthorized } from '../http/errors.js';
import { hashSecret, verifyAgainstDummy, verifySecret } from '../security/passwords.js';
import { recordAudit, recordAuditBestEffort } from './audit.js';
import { issueEnrollmentChallenge } from './enrollment.js';
import { generateRecoveryCodes } from './recovery.js';

export const MIN_PASSWORD_LENGTH = 12;

/**
 * Creates an account and its first batch of recovery codes (T-REGISTER, T-RECOVERY-CODES).
 * Used by the development account-setup script; there is no public sign-up endpoint.
 * `email` must already be normalised (trimmed, lower case).
 */
export async function createAccount(pool, { email, password, displayName = null }) {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  const passwordHash = await hashSecret(password);
  let userId;
  try {
    userId = await withTransaction(pool, async (client) => {
      const user = await runOne(client, 'Q-USR-01', [email, displayName, passwordHash]);
      await recordAudit(client, { type: 'user.registered', userId: user.id });
      return user.id;
    });
  } catch (error) {
    if (isUniqueViolation(error, 'users_email_key')) {
      throw conflict('email_taken', 'An account with this email already exists');
    }
    throw error;
  }
  const recoveryCodes = await generateRecoveryCodes(pool, userId, {});
  return { userId, recoveryCodes };
}

/**
 * Checks an email + password pair. Takes the same time whether or not the account exists.
 * Returns the user row on success; throws 401 invalid_credentials otherwise.
 */
export async function verifyPassword(db, email, password) {
  const user = await runOne(db, 'Q-USR-02', [email]);
  const ok = user
    ? await verifySecret(password, user.password_hash)
    : await verifyAgainstDummy(password);
  return { user, ok };
}

/**
 * Initial account sign-in on the phone. The password is used only to obtain a short-lived
 * enrollment challenge; it never yields a browser session or a device credential by itself.
 */
export async function passwordLogin(pool, config, { email, password }, context) {
  const { user, ok } = await verifyPassword(pool, email, password);
  if (!ok) {
    await recordAuditBestEffort(
      pool,
      {
        type: 'user.password_login_failed',
        userId: user?.id,
        details: { reason: user ? 'wrong_password' : 'unknown_email' },
      },
      context,
    );
    throw unauthorized('invalid_credentials', 'Email or password is incorrect');
  }
  if (user.disabled_at) throw forbidden('account_disabled', 'This account is disabled');

  const enrollment = await issueEnrollmentChallenge(pool, config, user.id);
  await recordAuditBestEffort(
    pool,
    { type: 'user.password_login_succeeded', userId: user.id },
    context,
  );
  return { enrollment };
}

export async function getUserProfile(db, userId) {
  const user = await runOne(db, 'Q-USR-03', [userId]);
  return user && { id: user.id, email: user.email, displayName: user.display_name };
}

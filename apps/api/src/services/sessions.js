import { run, runOne, withTransaction } from '../db/sql.js';
import { notFound } from '../http/errors.js';
import { sha256 } from '../security/tokens.js';
import { recordAudit } from './audit.js';

const TOUCH_INTERVAL_SECONDS = 60;

/**
 * Authenticates a browser session cookie (Q-SES-01): checks absolute expiry, idle timeout,
 * revocation, and that the approving device and the account are still active.
 * Returns { sessionId, userId, deviceId, expiresAt } or null.
 */
export async function authenticateSession(db, config, token) {
  if (!token) return null;
  const row = await runOne(db, 'Q-SES-01', [sha256(token), config.sessionIdleTimeoutSeconds]);
  if (!row) return null;
  await run(db, 'Q-SES-02', [row.session_id, TOUCH_INTERVAL_SECONDS]);
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    deviceId: row.device_id,
    expiresAt: row.expires_at,
  };
}

/** Browser signs itself out (Q-SES-05). Idempotent. */
export async function signOut(pool, notifier, token, context) {
  const revokedId = await withTransaction(pool, async (client) => {
    const row = await runOne(client, 'Q-SES-05', [sha256(token)]);
    if (row) await recordAudit(client, { type: 'session.signed_out', sessionId: row.id }, context);
    return row?.id;
  });
  if (revokedId) notifier.sessionsRevoked([revokedId]);
}

/** The user's active browser sessions, for the phone (Q-SES-03). */
export async function listSessions(db, config, userId) {
  const { rows } = await run(db, 'Q-SES-03', [userId, config.sessionIdleTimeoutSeconds]);
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    ip: row.ip,
    userAgent: row.user_agent,
    approvedBy: { deviceId: row.approved_by_device_id, deviceName: row.approved_by_device_name },
  }));
}

/** Phone revokes one of the user's sessions (Q-SES-04); 404 if it is not theirs or not active. */
export async function revokeSession(pool, notifier, auth, sessionId, context) {
  await withTransaction(pool, async (client) => {
    const row = await runOne(client, 'Q-SES-04', [sessionId, auth.userId]);
    if (!row) throw notFound('session_not_found', 'No active session with this id');
    await recordAudit(
      client,
      { type: 'session.revoked', userId: auth.userId, deviceId: auth.deviceId, sessionId },
      context,
    );
  });
  notifier.sessionsRevoked([sessionId]);
}

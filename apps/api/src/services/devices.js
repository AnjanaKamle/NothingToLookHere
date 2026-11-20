import { run, runOne, withTransaction } from '../db/sql.js';
import { notFound } from '../http/errors.js';
import { decodeBase64Url, sha256 } from '../security/tokens.js';
import { recordAudit } from './audit.js';

const TOUCH_INTERVAL_SECONDS = 300;

/**
 * Authenticates a phone's bearer token (Q-DEV-03). Tokens are 32 random bytes; only their
 * SHA-256 is stored. Returns { deviceId, userId } or null.
 */
export async function authenticateDevice(db, token) {
  if (!token || !decodeBase64Url(token)) return null;
  const row = await runOne(db, 'Q-DEV-03', [sha256(token)]);
  if (!row) return null;
  await run(db, 'Q-DEV-04', [row.device_id, TOUCH_INTERVAL_SECONDS]);
  return { deviceId: row.device_id, userId: row.user_id };
}

/** The user's active trusted phones (Q-DEV-02). */
export async function listDevices(db, auth) {
  const { rows } = await run(db, 'Q-DEV-02', [auth.userId]);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    platform: row.platform,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    current: row.id === auth.deviceId,
    key: row.key_id && { id: row.key_id, storage: row.key_storage, createdAt: row.key_created_at },
  }));
}

/**
 * Revokes one of the user's devices (T-DEVICE-REVOKE): the device, its keys and every session it
 * approved, atomically. A phone may revoke itself or another of the user's phones.
 */
export async function revokeDevice(pool, notifier, auth, deviceId, reason, context) {
  const sessionIds = await withTransaction(pool, async (client) => {
    const device = await runOne(client, 'Q-DEV-05', [deviceId, auth.userId, reason]);
    if (!device) throw notFound('device_not_found', 'No active device with this id');
    await run(client, 'Q-KEY-03', [deviceId]);
    const { rows } = await run(client, 'Q-SES-06', [deviceId]);
    await recordAudit(
      client,
      {
        type: 'device.revoked',
        userId: auth.userId,
        deviceId,
        details: { reason, revokedBy: auth.deviceId, sessionsRevoked: rows.length },
      },
      context,
    );
    return rows.map((row) => row.id);
  });
  notifier.sessionsRevoked(sessionIds);
  return { revokedSessions: sessionIds.length };
}

/** The user's security activity, newest first, keyset-paginated (Q-AUD-02). */
export async function listActivity(db, auth, { before, beforeId, limit }) {
  const { rows } = await run(db, 'Q-AUD-02', [
    auth.userId,
    before ?? null,
    beforeId ?? null,
    limit,
  ]);
  const events = rows.map((row) => ({
    id: row.id,
    occurredAt: row.occurred_at,
    type: row.event_type,
    deviceId: row.device_id,
    sessionId: row.session_id,
    ip: row.ip,
    userAgent: row.user_agent,
    details: row.details,
  }));
  const last = events.at(-1);
  return {
    events,
    nextCursor:
      events.length === limit && last ? { before: last.occurredAt, beforeId: last.id } : null,
  };
}

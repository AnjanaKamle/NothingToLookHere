import { run } from '../db/sql.js';

/**
 * Appends an audit event (Q-AUD-01). `details` must never contain secrets: no passwords, tokens,
 * nonces, signatures or recovery codes.
 */
export function recordAudit(db, event, context = {}) {
  return run(db, 'Q-AUD-01', [
    event.type,
    event.userId ?? null,
    event.deviceId ?? null,
    event.sessionId ?? null,
    event.challengeId ?? null,
    context.ip ?? null,
    context.userAgent ?? null,
    event.details ?? null,
  ]);
}

/** Records an audit event outside any transaction; failures are logged, never thrown. */
export async function recordAuditBestEffort(db, event, context) {
  try {
    await recordAudit(db, event, context);
  } catch (error) {
    console.error(`[audit] failed to record ${event.type}: ${error.message}`);
  }
}

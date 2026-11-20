import { run } from '../db/sql.js';

/**
 * Periodic cleanup. Correctness never depends on it (every guarded query checks expiry itself);
 * it only keeps tables small and enforces retention.
 */
export async function runMaintenance(db, config) {
  const enrollments = await run(db, 'Q-ENR-03', [config.challengeRetentionSeconds]);
  const challenges = await run(db, 'Q-LCH-06', [config.challengeRetentionSeconds]);
  const sessions = await run(db, 'Q-SES-08', [config.sessionRetentionSeconds]);
  const audit = await run(db, 'Q-AUD-03', [config.auditRetentionSeconds]);
  return {
    enrollmentChallenges: enrollments.rowCount,
    loginChallenges: challenges.rowCount,
    sessions: sessions.rowCount,
    auditEvents: audit.rowCount,
  };
}

export function scheduleMaintenance(db, config) {
  const tick = () =>
    runMaintenance(db, config)
      .then((counts) => {
        const total = Object.values(counts).reduce((a, b) => a + b, 0);
        if (total) console.log('[maintenance] purged', counts);
      })
      .catch((error) => console.error(`[maintenance] failed: ${error.message}`));
  const timer = setInterval(tick, config.maintenanceIntervalSeconds * 1000);
  timer.unref();
  return () => clearInterval(timer);
}

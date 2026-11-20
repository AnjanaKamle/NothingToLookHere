import pg from 'pg';

/**
 * Creates the shared PostgreSQL connection pool.
 * Feature modules receive this pool (or a client from it) rather than creating their own.
 */
export function createPool(databaseUrl) {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
  });

  // An idle client erroring (e.g. the database restarted) must not crash the process.
  pool.on('error', (error) => {
    console.error('[db] idle client error:', error.message);
  });

  return pool;
}

/** Returns true when the database answers a trivial query. */
export async function checkDatabase(pool) {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

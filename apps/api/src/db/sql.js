import { getQuery } from '@capstone/db';

/**
 * Runs a catalogued statement from db/queries.sql by its ID, always with bound parameters.
 * The statement is prepared once per connection under its ID.
 */
export function run(db, id, params = []) {
  return db.query({ name: id.toLowerCase(), text: getQuery(id), values: params });
}

/** Runs a catalogued statement and returns its first row, or null. */
export async function runOne(db, id, params) {
  const { rows } = await run(db, id, params);
  return rows[0] ?? null;
}

/**
 * Runs `work(client)` inside BEGIN … COMMIT on one pooled connection (READ COMMITTED).
 * Any thrown error, including an ApiError raised when a guarded statement matches no row,
 * rolls the whole transaction back.
 */
export async function withTransaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export function isUniqueViolation(error, constraint) {
  return error?.code === '23505' && (!constraint || error.constraint === constraint);
}

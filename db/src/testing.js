import pg from 'pg';
import { migrateUp } from './migrations.js';

/**
 * Drops and recreates the public schema of a TEST database, then applies all migrations.
 * Refuses to touch any database whose name does not end in "_test".
 */
export async function resetTestDatabase(connectionString) {
  const name = new URL(connectionString).pathname.slice(1);
  if (!name.endsWith('_test')) {
    throw new Error(`Refusing to reset "${name}": test database names must end in _test`);
  }
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrateUp(client);
  } finally {
    await client.end();
  }
}

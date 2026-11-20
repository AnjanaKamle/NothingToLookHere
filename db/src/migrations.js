import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { paths } from './paths.js';

const FILE_PATTERN = /^(\d{3})_([a-z0-9_]+)\.sql$/;
// Arbitrary constant so two migration runs cannot interleave.
const ADVISORY_LOCK_KEY = 4_206_310_001;

/**
 * Lists migration files in version order with their contents and checksums.
 * Every .sql file in the folder must follow NNN_snake_case_name.sql, and versions must be unique.
 */
export function listMigrations(dir = paths.migrationsDir) {
  const files = readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .sort();
  const seen = new Set();

  return files.map((file) => {
    const match = FILE_PATTERN.exec(file);
    if (!match) throw new Error(`Migration file name must look like 001_name.sql: ${file}`);
    const [, version, name] = match;
    if (seen.has(version)) throw new Error(`Duplicate migration version ${version}`);
    seen.add(version);

    const sql = readFileSync(path.join(dir, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    return { version, name, file, sql, checksum };
  });
}

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text        PRIMARY KEY,
      name       text        NOT NULL,
      checksum   text        NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
}

async function appliedMigrations(client) {
  const { rows } = await client.query('SELECT version, name, checksum FROM schema_migrations');
  return new Map(rows.map((row) => [row.version, row]));
}

function assertUnchanged(migration, applied) {
  if (applied && applied.checksum !== migration.checksum) {
    throw new Error(
      `Migration ${migration.file} was edited after it was applied. ` +
        'Applied migrations are immutable: add a new migration instead.',
    );
  }
}

/**
 * Applies pending migrations in order. Each file runs in its own transaction together with its
 * schema_migrations row, so a failure leaves the database at the previous version.
 * Returns the list of files applied.
 */
export async function migrateUp(client, { dir, log = () => {} } = {}) {
  const migrations = listMigrations(dir);
  await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
  try {
    await ensureMigrationsTable(client);
    const applied = await appliedMigrations(client);
    const done = [];

    for (const migration of migrations) {
      const existing = applied.get(migration.version);
      assertUnchanged(migration, existing);
      if (existing) continue;

      log(`applying ${migration.file}`);
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
          [migration.version, migration.name, migration.checksum],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${migration.file} failed: ${error.message}`, { cause: error });
      }
      done.push(migration.file);
    }
    return done;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
  }
}

/** Reports each migration file as applied or pending. */
export async function migrationStatus(client, { dir } = {}) {
  await ensureMigrationsTable(client);
  const applied = await appliedMigrations(client);
  return listMigrations(dir).map((migration) => {
    const existing = applied.get(migration.version);
    assertUnchanged(migration, existing);
    return { file: migration.file, applied: Boolean(existing) };
  });
}

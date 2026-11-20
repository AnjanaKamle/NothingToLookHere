import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { loadQueries } from '../src/queries.js';
import { migrateUp, migrationStatus } from '../src/migrations.js';
import { resetTestDatabase, skipWithoutDatabase, testDatabaseUrl } from './helpers.js';

let client;

before(async () => {
  if (skipWithoutDatabase) return;
  await resetTestDatabase();
  client = new pg.Client({ connectionString: testDatabaseUrl });
  await client.connect();
});

after(async () => {
  await client?.end();
});

test(
  'migrations create every table and record their version',
  { skip: skipWithoutDatabase },
  async () => {
    const { rows } = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    );
    assert.deepEqual(
      rows.map((r) => r.table_name),
      [
        'audit_events',
        'browser_sessions',
        'device_keys',
        'devices',
        'enrollment_challenges',
        'login_challenges',
        'recovery_code_batches',
        'recovery_codes',
        'schema_migrations',
        'users',
      ],
    );
    const status = await migrationStatus(client);
    assert.ok(status.every((m) => m.applied));
  },
);

test('running migrations again applies nothing', { skip: skipWithoutDatabase }, async () => {
  assert.deepEqual(await migrateUp(client), []);
});

test(
  'an applied migration that was edited is rejected',
  { skip: skipWithoutDatabase },
  async () => {
    await client.query("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = '001'");
    try {
      await assert.rejects(migrateUp(client), /edited after it was applied/);
    } finally {
      await client.query('DELETE FROM schema_migrations');
      await resetTestDatabase();
    }
  },
);

test(
  'every catalogued query is valid against the schema (PREPARE)',
  { skip: skipWithoutDatabase },
  async () => {
    // PREPARE parses, resolves every table/column/type and plans the statement without running it.
    const failures = [];
    for (const { id, sql } of loadQueries().values()) {
      const name = id.toLowerCase().replaceAll('-', '_');
      try {
        await client.query(`PREPARE ${name} AS ${sql}`);
        await client.query(`DEALLOCATE ${name}`);
      } catch (error) {
        failures.push(`${id}: ${error.message}`);
      }
    }
    assert.deepEqual(failures, []);
  },
);

test('the indexes the design relies on exist', { skip: skipWithoutDatabase }, async () => {
  const { rows } = await client.query(
    "SELECT indexname FROM pg_indexes WHERE schemaname = 'public'",
  );
  const names = new Set(rows.map((r) => r.indexname));
  for (const expected of [
    'users_email_key',
    'devices_user_id_idx',
    'devices_api_token_hash_key',
    'device_keys_public_key_spki_key',
    'device_keys_one_active_per_device',
    'device_keys_device_id_idx',
    'enrollment_challenges_expires_at_idx',
    'login_challenges_expires_at_idx',
    'browser_sessions_token_hash_key',
    'browser_sessions_login_challenge_id_key',
    'browser_sessions_device_idx',
    'browser_sessions_ended_at_idx',
    'recovery_code_batches_one_active_per_user',
    'recovery_codes_batch_id_idx',
    'audit_events_user_time_idx',
    'audit_events_occurred_at_brin',
  ]) {
    assert.ok(names.has(expected), `missing index ${expected}`);
  }
});

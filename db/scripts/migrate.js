#!/usr/bin/env node
// Usage: node scripts/migrate.js <up|status> [--test]
//   up      apply pending migrations from db/migrations
//   status  list applied and pending migrations
//   --test  use TEST_DATABASE_URL instead of DATABASE_URL
import pg from 'pg';
import { migrateUp, migrationStatus } from '../src/migrations.js';

const command = process.argv[2];
const variable = process.argv.includes('--test') ? 'TEST_DATABASE_URL' : 'DATABASE_URL';
const connectionString = process.env[variable];

if (!['up', 'status'].includes(command)) {
  console.error('Usage: migrate.js <up|status> [--test]');
  process.exit(2);
}
if (!connectionString) {
  console.error(`${variable} is not set. Copy .env.example to .env at the repository root.`);
  process.exit(2);
}

const client = new pg.Client({ connectionString });
try {
  await client.connect();
  if (command === 'up') {
    const applied = await migrateUp(client, { log: (line) => console.log(`[migrate] ${line}`) });
    console.log(
      applied.length ? `[migrate] applied ${applied.length} migration(s)` : '[migrate] up to date',
    );
  } else {
    for (const { file, applied } of await migrationStatus(client)) {
      console.log(`${applied ? 'applied' : 'pending'}  ${file}`);
    }
  }
} catch (error) {
  console.error(`[migrate] ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}

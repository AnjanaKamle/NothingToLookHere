#!/usr/bin/env node
// Generates the AP submission files from the canonical sources:
//   db/migrations/*.sql  ->  dbms/03_schema.sql
//   db/queries.sql       ->  dbms/04_queries.sql
// Usage: node scripts/build-ap.js [--check]
//   --check  do not write; exit 1 if the generated files are missing or out of date
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listMigrations } from '../src/migrations.js';
import { loadQueries } from '../src/queries.js';
import { paths } from '../src/paths.js';

export function buildApFiles() {
  const migrations = listMigrations();
  const schema = [
    '-- dbms/03_schema.sql: final schema for the AP submission.',
    '--',
    '-- GENERATED FILE. Do not edit. Canonical source: db/migrations/*.sql',
    '-- Regenerate with: npm run db:ap:build',
    `-- Migrations included: ${migrations.map((m) => m.file).join(', ')}`,
    '--',
    '-- Run against an empty database: psql -v ON_ERROR_STOP=1 -f dbms/03_schema.sql',
    '',
    'BEGIN;',
    '',
    ...migrations.flatMap((m) => [
      `-- >>> ${m.file}`,
      '',
      m.sql.trimEnd(),
      '',
      `-- <<< ${m.file}`,
      '',
    ]),
    'COMMIT;',
    '',
  ].join('\n');

  const queries = loadQueries();
  const counts = { READ: 0, WRITE: 0 };
  for (const query of queries.values()) counts[query.kind] += 1;
  const queriesFile = [
    '-- dbms/04_queries.sql: every SQL query the application uses, for the AP submission.',
    '--',
    '-- GENERATED FILE. Do not edit. Canonical source: db/queries.sql',
    '-- Regenerate with: npm run db:ap:build',
    `-- ${queries.size} queries: ${counts.READ} READ, ${counts.WRITE} WRITE.`,
    '',
    readFileSync(paths.queriesFile, 'utf8').trimEnd(),
    '',
  ].join('\n');

  return {
    [path.join(paths.apDir, '03_schema.sql')]: schema,
    [path.join(paths.apDir, '04_queries.sql')]: queriesFile,
  };
}

/** Returns the generated paths whose on-disk content differs from what would be generated. */
export function findStaleApFiles() {
  return Object.entries(buildApFiles())
    .filter(([file, content]) => !existsSync(file) || readFileSync(file, 'utf8') !== content)
    .map(([file]) => path.relative(path.join(paths.dbDir, '..'), file));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) {
    const stale = findStaleApFiles();
    if (stale.length) {
      console.error(`Out of date: ${stale.join(', ')}. Run: npm run db:ap:build`);
      process.exit(1);
    }
    console.log('AP files are in sync with db/migrations and db/queries.sql');
  } else {
    mkdirSync(paths.apDir, { recursive: true });
    for (const [file, content] of Object.entries(buildApFiles())) {
      writeFileSync(file, content);
      console.log(`wrote ${path.relative(process.cwd(), file)}`);
    }
  }
}

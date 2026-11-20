import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { loadQueries, parseQueryCatalogue, getQuery } from '../src/queries.js';
import { listMigrations } from '../src/migrations.js';
import { findStaleApFiles } from '../scripts/build-ap.js';
import { paths } from '../src/paths.js';

test('db/queries.sql parses, with unique ids and READ/WRITE matching each statement', () => {
  const queries = loadQueries();
  assert.ok(queries.size >= 40, `expected the full catalogue, found ${queries.size}`);
  for (const query of queries.values()) {
    assert.ok(query.description.length > 0, `${query.id} needs a description`);
  }
});

test('the parser rejects a READ entry that modifies data', () => {
  const text = '-- @id Q-BAD-01\n-- READ\n-- nope\nDELETE FROM users;\n';
  assert.throws(() => parseQueryCatalogue(text), /marked READ/);
});

test('the parser rejects duplicate ids', () => {
  const entry = '-- @id Q-DUP-01\n-- READ\n-- x\nSELECT 1;\n';
  assert.throws(() => parseQueryCatalogue(entry + entry), /Duplicate/);
});

test('unknown query ids throw instead of returning undefined', () => {
  assert.throws(() => getQuery('Q-NOP-99'), /Unknown query id/);
});

test('every transaction listed in the catalogue header names existing queries', () => {
  const queries = loadQueries();
  const header = getHeader();
  const referenced = [...header.matchAll(/Q-[A-Z]{3}-\d{2}/g)].map((m) => m[0]);
  for (const id of referenced) {
    if (id === 'Q-XXX-NN') continue;
    assert.ok(queries.has(id), `transaction list references unknown query ${id}`);
  }
});

test('migration files are well formed and start at 001', () => {
  const migrations = listMigrations();
  assert.equal(migrations[0].file, '001_initial_schema.sql');
  for (const m of migrations) {
    assert.doesNotMatch(
      m.sql,
      /^\s*(BEGIN|COMMIT)\s*;/im,
      `${m.file} must not manage its own transaction`,
    );
  }
});

test('dbms/03_schema.sql and dbms/04_queries.sql are in sync with their canonical sources', () => {
  assert.deepEqual(findStaleApFiles(), [], 'run: npm run db:ap:build');
});

function getHeader() {
  return loadQueriesText().split('-- @id ')[0];
}

function loadQueriesText() {
  // Re-read the raw file for the header; the parser only keeps entries.
  return readFileSync(paths.queriesFile, 'utf8');
}

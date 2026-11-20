import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadQueries } from '@capstone/db';

const apiDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? sourceFiles(full) : full.endsWith('.js') ? [full] : [];
  });
}

const referenced = new Set(
  [...sourceFiles(path.join(apiDir, 'src')), ...sourceFiles(path.join(apiDir, 'scripts'))].flatMap(
    (file) => [...readFileSync(file, 'utf8').matchAll(/'(Q-[A-Z]{3}-\d{2})'/g)].map((m) => m[1]),
  ),
);

test('every query id used by the API exists in db/queries.sql', () => {
  const catalogue = loadQueries();
  const unknown = [...referenced].filter((id) => !catalogue.has(id));
  assert.deepEqual(unknown, []);
});

test('every query in db/queries.sql is used by the API (the inventory has no dead entries)', () => {
  const unused = [...loadQueries().keys()].filter((id) => !referenced.has(id));
  assert.deepEqual(unused, []);
});

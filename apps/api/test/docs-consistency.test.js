import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Keeps the written documentation honest: fails when a route or environment variable is added
 * or removed in code without updating docs/API.md or .env.example (and vice versa).
 */
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const routesSource = read('../src/routes/index.js');
const configSource = read('../src/config.js');
const apiDoc = read('../../../docs/API.md');
const envExample = read('../../../.env.example');

const codeRoutes = new Set(
  [...routesSource.matchAll(/router\.(get|post|put|patch|delete)\('([^']+)'/g)].map(
    ([, method, path]) => `${method.toUpperCase()} ${path}`,
  ),
);
const documentedRoutes = new Set(
  [...apiDoc.matchAll(/\*\*`(GET|POST|PUT|PATCH|DELETE) (\/[^`?\s]*)[^`]*`\*\*/g)].map(
    ([, method, path]) => `${method} ${path}`,
  ),
);

test('every API route is documented in docs/API.md', () => {
  assert.ok(codeRoutes.size >= 19);
  assert.deepEqual(
    [...codeRoutes].filter((r) => !documentedRoutes.has(r)),
    [],
  );
});

test('every endpoint documented in docs/API.md exists in the code', () => {
  assert.deepEqual(
    [...documentedRoutes].filter((r) => !codeRoutes.has(r)),
    [],
  );
});

test('every environment variable the API reads is listed in .env.example', () => {
  const variables = [...configSource.matchAll(/(?:read|required|integer)\('([A-Z_]+)'/g)].map(
    (m) => m[1],
  );
  assert.ok(variables.length >= 15);
  const missing = [...new Set(variables)].filter(
    (name) => !new RegExp(`^#?\\s*${name}=`, 'm').test(envExample),
  );
  assert.deepEqual(missing, []);
});

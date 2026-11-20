import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createNotifier } from '../src/realtime/notifier.js';
import { testConfig } from './support.js';

// These tests need no database: only the health and fallback routes are exercised.
function appWith(checkDatabase) {
  return createApp(
    { config: testConfig(), pool: null, notifier: createNotifier(), checkDatabase },
    { rateLimit: false, logRequests: false },
  );
}

async function withServer(app, run) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('GET /api/health returns 200 when the database is reachable', async () => {
  await withServer(
    appWith(async () => true),
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/health`);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).status, 'ok');
      assert.equal(response.headers.get('cache-control'), 'no-store');
    },
  );
});

test('GET /api/health returns 503 when the database is unreachable', async () => {
  await withServer(
    appWith(async () => false),
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/health`);
      assert.equal(response.status, 503);
      assert.equal((await response.json()).database, 'unreachable');
    },
  );
});

test('unknown /api routes return the standard JSON error', async () => {
  await withServer(
    appWith(async () => true),
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/does-not-exist`);
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), {
        error: { code: 'not_found', message: 'No such endpoint' },
      });
    },
  );
});

test('configuration refuses insecure production settings', () => {
  assert.throws(
    () => testConfig({ NODE_ENV: 'production', COOKIE_SECURE: 'false' }),
    /COOKIE_SECURE/,
  );
  assert.equal(testConfig({ NODE_ENV: 'production' }).cookieSecure, true);
  assert.throws(() => testConfig({ WATCH_TOKEN_SECRET: 'c2hvcnQ' }), /WATCH_TOKEN_SECRET/);
  assert.throws(
    () => testConfig({ LOGIN_CHALLENGE_TTL_SECONDS: '3600' }),
    /LOGIN_CHALLENGE_TTL_SECONDS/,
  );
});

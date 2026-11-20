import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  complete,
  createChallenge,
  createPool,
  createUserWithDevice,
  decide,
  random32,
  resetTestDatabase,
  run,
  sha256,
  skipWithoutDatabase,
} from './helpers.js';

let pool;

before(async () => {
  if (skipWithoutDatabase) return;
  await resetTestDatabase();
  pool = createPool();
});

after(async () => {
  await pool?.end();
});

const options = { skip: skipWithoutDatabase };

describe('QR login: one-time approval', options, () => {
  test('approve then complete creates exactly one session', async () => {
    const device = await createUserWithDevice(pool);
    const challenge = await createChallenge(pool);

    const approved = await decide(pool, challenge, device);
    assert.equal(approved.rowCount, 1);
    assert.equal(approved.rows[0].user_id, device.userId);

    const session = await complete(pool, challenge);
    assert.equal(session.rowCount, 1);
    assert.equal(session.rows[0].user_id, device.userId);
    assert.equal(session.rows[0].approved_by_device_id, device.deviceId);
  });

  test('completing the same challenge again creates nothing (replay)', async () => {
    const device = await createUserWithDevice(pool);
    const challenge = await createChallenge(pool);
    await decide(pool, challenge, device);
    assert.equal((await complete(pool, challenge)).rowCount, 1);
    assert.equal((await complete(pool, challenge)).rowCount, 0);
  });

  test('a challenge can be decided only once', async () => {
    const device = await createUserWithDevice(pool);
    const challenge = await createChallenge(pool);
    assert.equal((await decide(pool, challenge, device)).rowCount, 1);
    assert.equal((await decide(pool, challenge, device, 'denied')).rowCount, 0);
  });

  test('concurrent completions serialize: the second waits, then finds nothing', async () => {
    const device = await createUserWithDevice(pool);
    const challenge = await createChallenge(pool);
    await decide(pool, challenge, device);

    const first = await pool.connect();
    const second = await pool.connect();
    try {
      await first.query('BEGIN');
      await second.query('BEGIN');
      assert.equal((await complete(first, challenge)).rowCount, 1);

      // The second attempt must block on the challenge row lock held by the first transaction.
      const {
        rows: [{ pid: secondPid }],
      } = await second.query('SELECT pg_backend_pid() AS pid');
      const pending = complete(second, challenge);
      await waitUntilBlocked(secondPid);

      await first.query('COMMIT');
      const result = await pending;
      assert.equal(result.rowCount, 0, 'second completion must not create a session');
      await second.query('COMMIT');
    } finally {
      first.release();
      second.release();
    }

    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM browser_sessions WHERE login_challenge_id = $1',
      [challenge.id],
    );
    assert.equal(rows[0].n, 1);
  });

  test('concurrent approvals from two devices: only one decision is recorded', async () => {
    const phoneA = await createUserWithDevice(pool);
    const phoneB = await createUserWithDevice(pool);
    const challenge = await createChallenge(pool);
    const results = await Promise.all([
      decide(pool, challenge, phoneA),
      decide(pool, challenge, phoneB),
    ]);
    assert.deepEqual(results.map((r) => r.rowCount).sort(), [0, 1]);
  });

  test('an expired challenge cannot be approved or viewed by the phone', async () => {
    const device = await createUserWithDevice(pool);
    const nonce = random32();
    const {
      rows: [row],
    } = await pool.query(
      `INSERT INTO login_challenges (nonce_hash, browser_binding_hash, created_at, expires_at)
       VALUES ($1, $2, now() - interval '2 minutes', now() - interval '1 minute') RETURNING id`,
      [sha256(nonce), sha256(random32())],
    );
    const challenge = { id: row.id, nonce };
    assert.equal((await run(pool, 'Q-LCH-02', [challenge.id, sha256(nonce)])).rowCount, 0);
    assert.equal((await decide(pool, challenge, device)).rowCount, 0);
  });

  test('the phone needs the QR nonce: a wrong nonce cannot approve', async () => {
    const device = await createUserWithDevice(pool);
    const challenge = await createChallenge(pool);
    const forged = { ...challenge, nonce: random32() };
    assert.equal((await decide(pool, forged, device)).rowCount, 0);
  });

  test('only the browser that created the challenge can complete it', async () => {
    const device = await createUserWithDevice(pool);
    const challenge = await createChallenge(pool);
    await decide(pool, challenge, device);
    assert.equal((await complete(pool, challenge, { binding: random32() })).rowCount, 0);
    assert.equal((await complete(pool, challenge)).rowCount, 1);
  });

  test('a denied challenge cannot be completed', async () => {
    const device = await createUserWithDevice(pool);
    const challenge = await createChallenge(pool);
    await decide(pool, challenge, device, 'denied');
    assert.equal((await complete(pool, challenge)).rowCount, 0);
  });

  test('an approval older than the completion window cannot be completed', async () => {
    const device = await createUserWithDevice(pool);
    const challenge = await createChallenge(pool);
    await decide(pool, challenge, device);
    // A zero-second window means the approval is already too old.
    assert.equal((await complete(pool, challenge, { windowSeconds: 0 })).rowCount, 0);
  });

  test('revoking the device between approval and completion blocks the session', async () => {
    const device = await createUserWithDevice(pool);
    const challenge = await createChallenge(pool);
    await decide(pool, challenge, device);
    await run(pool, 'Q-DEV-05', [device.deviceId, device.userId, 'lost']);
    assert.equal((await complete(pool, challenge)).rowCount, 0);
  });

  test('a revoked key cannot approve', async () => {
    const device = await createUserWithDevice(pool);
    await run(pool, 'Q-KEY-03', [device.deviceId]);
    const challenge = await createChallenge(pool);
    assert.equal((await decide(pool, challenge, device)).rowCount, 0);
    assert.equal((await run(pool, 'Q-KEY-06', [device.keyId])).rowCount, 0);
  });
});

describe('database-enforced invariants', options, () => {
  test('illegal status transitions are rejected by the trigger', async () => {
    const device = await createUserWithDevice(pool);
    const challenge = await createChallenge(pool);
    await decide(pool, challenge, device);
    await complete(pool, challenge);
    await assert.rejects(
      pool.query(
        `UPDATE login_challenges SET status = 'approved', consumed_at = NULL WHERE id = $1`,
        [challenge.id],
      ),
      /illegal transition consumed -> approved/,
    );
  });

  test('a challenge row must have the columns its status requires', async () => {
    await assert.rejects(
      pool.query(
        `INSERT INTO login_challenges (nonce_hash, browser_binding_hash, expires_at, status)
         VALUES ($1, $2, now() + interval '1 minute', 'approved')`,
        [sha256('a'), sha256('b')],
      ),
      /login_challenges_state_columns/,
    );
  });

  test('challenge lifetime is capped at five minutes', async () => {
    await assert.rejects(createChallenge(pool, 301), /login_challenges_expiry_window/);
  });

  test('a session cannot reuse a challenge (UNIQUE backstop)', async () => {
    const device = await createUserWithDevice(pool);
    const challenge = await createChallenge(pool);
    await decide(pool, challenge, device);
    await complete(pool, challenge);
    await assert.rejects(
      pool.query(
        `INSERT INTO browser_sessions (login_challenge_id, approved_by_device_id, token_hash, expires_at)
         VALUES ($1, $2, $3, now() + interval '1 hour')`,
        [challenge.id, device.deviceId, sha256(random32())],
      ),
      /browser_sessions_login_challenge_id_key/,
    );
  });

  test('revocation is permanent (write-once revoked_at)', async () => {
    const device = await createUserWithDevice(pool);
    await run(pool, 'Q-DEV-05', [device.deviceId, device.userId, 'user']);
    await assert.rejects(
      pool.query('UPDATE devices SET revoked_at = NULL, revoked_reason = NULL WHERE id = $1', [
        device.deviceId,
      ]),
      /write-once/,
    );
  });

  test('a device has at most one active key', async () => {
    const device = await createUserWithDevice(pool);
    const { newDeviceKeyPair } = await import('./helpers.js');
    await assert.rejects(
      run(pool, 'Q-KEY-01', [device.deviceId, 'ES256', newDeviceKeyPair().spki, 'secure_enclave']),
      /device_keys_one_active_per_device/,
    );
  });

  test('audit events are append-only', async () => {
    const {
      rows: [event],
    } = await run(pool, 'Q-AUD-01', [
      'login.approved',
      null,
      null,
      null,
      null,
      null,
      null,
      { test: true },
    ]);
    await assert.rejects(
      pool.query("UPDATE audit_events SET event_type = 'login.denied' WHERE id = $1", [event.id]),
      /append-only/,
    );
  });

  test('emails must be stored normalised', async () => {
    await assert.rejects(
      run(pool, 'Q-USR-01', ['Mixed@Example.test', null, '$scrypt$x']),
      /users_email_normalised/,
    );
  });
});

describe('sessions, enrollment and recovery', options, () => {
  test('a session authenticates until it is revoked from the phone', async () => {
    const device = await createUserWithDevice(pool);
    const challenge = await createChallenge(pool);
    await decide(pool, challenge, device);
    const token = random32();
    const {
      rows: [session],
    } = await run(pool, 'Q-LCH-05', [
      challenge.id,
      sha256(challenge.binding),
      sha256(token),
      3600,
      null,
      null,
      60,
    ]);

    assert.equal((await run(pool, 'Q-SES-01', [sha256(token), 1800])).rowCount, 1);
    const listed = await run(pool, 'Q-SES-03', [device.userId, 1800]);
    assert.deepEqual(
      listed.rows.map((r) => r.id),
      [session.id],
    );

    const other = await createUserWithDevice(pool);
    assert.equal(
      (await run(pool, 'Q-SES-04', [session.id, other.userId])).rowCount,
      0,
      "cannot revoke another user's session",
    );
    assert.equal((await run(pool, 'Q-SES-04', [session.id, device.userId])).rowCount, 1);
    assert.equal((await run(pool, 'Q-SES-01', [sha256(token), 1800])).rowCount, 0);
  });

  test('an enrollment challenge can be consumed once', async () => {
    const { userId } = await createUserWithDevice(pool);
    const nonce = random32();
    const {
      rows: [enrollment],
    } = await run(pool, 'Q-ENR-01', [userId, sha256(nonce), 300]);
    assert.equal(
      (await run(pool, 'Q-ENR-02', [enrollment.id, sha256(random32())])).rowCount,
      0,
      'wrong nonce',
    );
    assert.equal((await run(pool, 'Q-ENR-02', [enrollment.id, sha256(nonce)])).rowCount, 1);
    assert.equal(
      (await run(pool, 'Q-ENR-02', [enrollment.id, sha256(nonce)])).rowCount,
      0,
      'replay',
    );
  });

  test('a recovery code can be spent once, and only by its owner', async () => {
    const owner = await createUserWithDevice(pool);
    const other = await createUserWithDevice(pool);
    const {
      rows: [batch],
    } = await run(pool, 'Q-REC-02', [owner.userId]);
    await run(pool, 'Q-REC-03', [batch.id, ['$scrypt$a', '$scrypt$b']]);
    const { rows: codes } = await run(pool, 'Q-REC-04', [owner.userId]);
    assert.equal(codes.length, 2);

    assert.equal((await run(pool, 'Q-REC-05', [codes[0].id, other.userId])).rowCount, 0);
    assert.equal((await run(pool, 'Q-REC-05', [codes[0].id, owner.userId])).rowCount, 1);
    assert.equal((await run(pool, 'Q-REC-05', [codes[0].id, owner.userId])).rowCount, 0);
    assert.equal((await run(pool, 'Q-REC-06', [owner.userId])).rows[0].remaining, 1);
  });

  test('recovery revokes every device, key and session of the user in one transaction', async () => {
    const device = await createUserWithDevice(pool);
    const challenge = await createChallenge(pool);
    await decide(pool, challenge, device);
    await complete(pool, challenge);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await run(client, 'Q-SES-07', [device.userId]);
      await run(client, 'Q-KEY-04', [device.userId]);
      await run(client, 'Q-DEV-06', [device.userId]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    assert.equal((await run(pool, 'Q-SES-03', [device.userId, 1800])).rowCount, 0);
    assert.equal((await run(pool, 'Q-DEV-02', [device.userId])).rowCount, 0);
    assert.equal((await run(pool, 'Q-DEV-03', [sha256(device.deviceToken)])).rowCount, 0);
  });
});

/** Polls pg_stat_activity until the given backend is waiting on a lock. */
async function waitUntilBlocked(pid) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { rows } = await pool.query(
      'SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1',
      [pid],
    );
    if (rows[0]?.wait_event_type === 'Lock') return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`backend ${pid} never blocked on a lock`);
}

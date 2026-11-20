import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { SocketEvents } from '@capstone/protocol';
import {
  Browser,
  Phone,
  connected,
  createUser,
  emitWithAck,
  nextEvent,
  skipWithoutDatabase,
  startServer,
} from './support.js';

let server;
before(async () => {
  if (!skipWithoutDatabase) server = await startServer();
});
after(async () => {
  await server?.close();
});

async function enrolledPhone() {
  const user = await createUser(server);
  const phone = new Phone(server);
  await phone.enroll(user);
  return { user, phone };
}

describe('QR login: happy path', { skip: skipWithoutDatabase }, () => {
  test('browser -> QR -> phone approves -> real-time event -> session cookie', async () => {
    const { user, phone } = await enrolledPhone();
    const browser = new Browser(server);
    const challenge = await browser.startLogin();
    assert.match(challenge.qrPayload, /^capstone-auth:v1:[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);

    // The browser subscribes to its challenge only.
    const socket = browser.socket();
    await connected(socket);
    const ack = await emitWithAck(socket, SocketEvents.WATCH_LOGIN, {
      challengeId: challenge.challengeId,
      watchToken: challenge.watchToken,
    });
    assert.equal(ack.ok, true);
    assert.equal(ack.status, 'pending');

    // The phone scans the QR, inspects the request, and approves.
    const inspect = await phone.call(
      'POST',
      `/api/login/challenges/${challenge.challengeId}/inspect`,
      {
        body: { nonce: challenge.nonce },
      },
    );
    assert.equal(inspect.status, 200);
    assert.equal(inspect.body.audience, 'capstone-test');
    assert.ok(inspect.body.requester.userAgent !== undefined);

    const approved = nextEvent(socket, SocketEvents.LOGIN_APPROVED);
    const decision = await phone.decide(challenge, 'approved');
    assert.equal(decision.status, 200);
    assert.deepEqual(decision.body, { challengeId: challenge.challengeId, status: 'approved' });
    assert.deepEqual(await approved, { challengeId: challenge.challengeId });
    socket.close();

    // The browser exchanges the approval for a session.
    const complete = await browser.call(
      'POST',
      `/api/login/challenges/${challenge.challengeId}/complete`,
    );
    assert.equal(complete.status, 200);
    assert.equal(complete.body.user.email, user.email);
    const sessionCookie = complete.setCookies.find((c) => c.startsWith('capstone_session='));
    assert.ok(sessionCookie, 'session cookie set');
    assert.match(sessionCookie, /HttpOnly/);
    assert.match(sessionCookie, /SameSite=Lax/);
    assert.match(sessionCookie, /Path=\//);
    assert.ok(
      complete.setCookies.some((c) => c.startsWith(`capstone_login_${challenge.challengeId}=;`)),
      'binding cookie cleared',
    );

    const me = await browser.call('GET', '/api/session');
    assert.equal(me.status, 200);
    assert.equal(me.body.user.id, user.userId);
  });

  test('a browser that reconnects after missing the event learns the outcome from the ack', async () => {
    const { phone } = await enrolledPhone();
    const browser = new Browser(server);
    const challenge = await browser.startLogin();
    await phone.decide(challenge, 'approved');

    const socket = browser.socket();
    await connected(socket);
    const ack = await emitWithAck(socket, SocketEvents.WATCH_LOGIN, {
      challengeId: challenge.challengeId,
      watchToken: challenge.watchToken,
    });
    socket.close();
    assert.equal(ack.status, 'approved');
    // HTTP polling fallback reports the same state.
    const polled = await browser.call('GET', `/api/login/challenges/${challenge.challengeId}`);
    assert.equal(polled.body.status, 'approved');
  });

  test('a denial reaches the browser and cannot be completed', async () => {
    const { phone } = await enrolledPhone();
    const browser = new Browser(server);
    const challenge = await browser.startLogin();
    const socket = browser.socket();
    await connected(socket);
    await emitWithAck(socket, SocketEvents.WATCH_LOGIN, {
      challengeId: challenge.challengeId,
      watchToken: challenge.watchToken,
    });
    const denied = nextEvent(socket, SocketEvents.LOGIN_DENIED);
    assert.equal((await phone.decide(challenge, 'denied')).status, 200);
    await denied;
    socket.close();
    const complete = await browser.call(
      'POST',
      `/api/login/challenges/${challenge.challengeId}/complete`,
    );
    assert.equal(complete.status, 409);
    assert.equal(complete.body.error.code, 'challenge_not_approved');
  });
});

describe('real-time isolation', { skip: skipWithoutDatabase }, () => {
  test('a watch token for one challenge cannot subscribe to another', async () => {
    const browser = new Browser(server);
    const mine = await browser.startLogin();
    const other = await new Browser(server).startLogin();
    const socket = browser.socket();
    await connected(socket);
    const ack = await emitWithAck(socket, SocketEvents.WATCH_LOGIN, {
      challengeId: other.challengeId,
      watchToken: mine.watchToken,
    });
    socket.close();
    assert.deepEqual(ack, { ok: false, error: 'invalid_watch_token' });
  });

  test('only the watching browser receives the approval', async () => {
    const { phone } = await enrolledPhone();
    const waiting = new Browser(server);
    const bystander = new Browser(server);
    const challenge = await waiting.startLogin();
    const bystanderChallenge = await bystander.startLogin();

    const socketA = waiting.socket();
    const socketB = bystander.socket();
    await Promise.all([connected(socketA), connected(socketB)]);
    await emitWithAck(socketA, SocketEvents.WATCH_LOGIN, {
      challengeId: challenge.challengeId,
      watchToken: challenge.watchToken,
    });
    await emitWithAck(socketB, SocketEvents.WATCH_LOGIN, {
      challengeId: bystanderChallenge.challengeId,
      watchToken: bystanderChallenge.watchToken,
    });

    let bystanderHeard = false;
    socketB.on(SocketEvents.LOGIN_APPROVED, () => {
      bystanderHeard = true;
    });
    const heard = nextEvent(socketA, SocketEvents.LOGIN_APPROVED);
    await phone.decide(challenge, 'approved');
    await heard;
    await new Promise((resolve) => setTimeout(resolve, 200));
    socketA.close();
    socketB.close();
    assert.equal(bystanderHeard, false);
  });

  test('connections from an untrusted Origin are refused', async () => {
    const socket = new Browser(server, { origin: 'https://evil.example' }).socket();
    await assert.rejects(connected(socket));
    socket.close();
  });
});

describe('signature verification', { skip: skipWithoutDatabase }, () => {
  test('a signature over a different decision is rejected', async () => {
    const { phone } = await enrolledPhone();
    const challenge = await new Browser(server).startLogin();
    const signedDeny = phone.decisionBody(challenge, 'denied');
    const result = await phone.decide(challenge, 'approved', { signature: signedDeny.signature });
    assert.equal(result.status, 401);
    assert.equal(result.body.error.code, 'invalid_signature');
  });

  test('a signature from an unregistered key is rejected even with a valid key id', async () => {
    const { phone } = await enrolledPhone();
    const challenge = await new Browser(server).startLogin();
    const impostor = new Phone(server); // different private key, never enrolled
    impostor.audience = phone.audience;
    impostor.keyId = phone.keyId;
    const forged = impostor.decisionBody(challenge, 'approved');
    const result = await phone.decide(challenge, 'approved', { signature: forged.signature });
    assert.equal(result.status, 401);
    assert.equal(result.body.error.code, 'invalid_signature');
  });

  test("a phone cannot sign with another phone's key id", async () => {
    const { phone } = await enrolledPhone();
    const { phone: other } = await enrolledPhone();
    const challenge = await new Browser(server).startLogin();
    const result = await phone.decide(challenge, 'approved', { keyId: other.keyId });
    assert.equal(result.status, 403);
    assert.equal(result.body.error.code, 'key_not_owned');
  });

  test('a validly signed decision for the wrong nonce does not match the challenge', async () => {
    const { phone } = await enrolledPhone();
    const challenge = await new Browser(server).startLogin();
    const wrong = { ...challenge, nonce: randomBytes(32).toString('base64url') };
    const result = await phone.decide(wrong, 'approved');
    assert.equal(result.status, 409);
    assert.equal(result.body.error.code, 'challenge_unavailable');
  });

  test('malformed signatures are rejected', async () => {
    const { phone } = await enrolledPhone();
    const challenge = await new Browser(server).startLogin();
    const result = await phone.decide(challenge, 'approved', { signature: 'AAAA' });
    assert.equal(result.status, 401);
  });

  test('requests without a device token are rejected', async () => {
    const challenge = await new Browser(server).startLogin();
    const anonymous = new Phone(server);
    const result = await anonymous.call(
      'POST',
      `/api/login/challenges/${challenge.challengeId}/inspect`,
      {
        body: { nonce: challenge.nonce },
      },
    );
    assert.equal(result.status, 401);
    assert.equal(result.body.error.code, 'device_auth_required');
  });
});

describe('one-time use and expiry', { skip: skipWithoutDatabase }, () => {
  test('a decision cannot be submitted twice', async () => {
    const { phone } = await enrolledPhone();
    const challenge = await new Browser(server).startLogin();
    assert.equal((await phone.decide(challenge)).status, 200);
    const replay = await phone.decide(challenge);
    assert.equal(replay.status, 409);
    assert.equal(replay.body.error.code, 'challenge_unavailable');
  });

  test('concurrent approvals: exactly one succeeds', async () => {
    const { phone } = await enrolledPhone();
    const challenge = await new Browser(server).startLogin();
    const results = await Promise.all(Array.from({ length: 5 }, () => phone.decide(challenge)));
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 409, 409, 409, 409]);
  });

  test('concurrent completions: exactly one session is issued', async () => {
    const { phone } = await enrolledPhone();
    const browser = new Browser(server);
    const challenge = await browser.startLogin();
    await phone.decide(challenge);
    const path = `/api/login/challenges/${challenge.challengeId}/complete`;
    const results = await Promise.all(Array.from({ length: 5 }, () => browser.call('POST', path)));
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409, 409, 409]);
    const { rows } = await server.pool.query(
      'SELECT count(*)::int AS n FROM browser_sessions WHERE login_challenge_id = $1',
      [challenge.challengeId],
    );
    assert.equal(rows[0].n, 1);
  });

  test('another browser cannot complete or read a challenge it did not create', async () => {
    const { phone } = await enrolledPhone();
    const challenge = await new Browser(server).startLogin();
    await phone.decide(challenge);
    const attacker = new Browser(server);
    const status = await attacker.call('GET', `/api/login/challenges/${challenge.challengeId}`);
    assert.equal(status.status, 404);
    const complete = await attacker.call(
      'POST',
      `/api/login/challenges/${challenge.challengeId}/complete`,
    );
    assert.equal(complete.status, 404);
  });

  test('state-changing browser requests from a foreign Origin are rejected', async () => {
    const { phone } = await enrolledPhone();
    const browser = new Browser(server);
    const challenge = await browser.startLogin();
    await phone.decide(challenge);
    browser.origin = 'https://evil.example';
    const result = await browser.call(
      'POST',
      `/api/login/challenges/${challenge.challengeId}/complete`,
    );
    assert.equal(result.status, 403);
    assert.equal(result.body.error.code, 'untrusted_origin');
  });

  test('an expired challenge reports "expired" and cannot be approved', async () => {
    const { phone } = await enrolledPhone();
    const nonce = randomBytes(32).toString('base64url');
    const binding = randomBytes(32).toString('base64url');
    const sha = (v) => createHash('sha256').update(v).digest();
    const { rows } = await server.pool.query(
      `INSERT INTO login_challenges (nonce_hash, browser_binding_hash, created_at, expires_at)
       VALUES ($1, $2, now() - interval '2 minutes', now() - interval '1 minute') RETURNING id`,
      [sha(nonce), sha(binding)],
    );
    const challenge = { challengeId: rows[0].id, nonce };
    const browser = new Browser(server);
    browser.cookies.set(`capstone_login_${challenge.challengeId}`, binding);
    const status = await browser.call('GET', `/api/login/challenges/${challenge.challengeId}`);
    assert.equal(status.body.status, 'expired');
    assert.equal((await phone.decide(challenge)).status, 409);
  });
});

describe('sessions', { skip: skipWithoutDatabase }, () => {
  async function signedInBrowser(phone) {
    const browser = new Browser(server);
    const challenge = await browser.startLogin();
    await phone.decide(challenge);
    await browser.call('POST', `/api/login/challenges/${challenge.challengeId}/complete`);
    return browser;
  }

  test('the phone lists sessions and revokes one; the browser is notified and signed out', async () => {
    const { phone } = await enrolledPhone();
    const browser = await signedInBrowser(phone);
    const socket = browser.socket(); // handshake carries the session cookie
    await connected(socket);

    const list = await phone.call('GET', '/api/sessions');
    assert.equal(list.status, 200);
    assert.equal(list.body.sessions.length, 1);
    const [session] = list.body.sessions;
    assert.equal(session.approvedBy.deviceId, phone.deviceId);

    const revoked = nextEvent(socket, SocketEvents.SESSION_REVOKED);
    assert.equal((await phone.call('DELETE', `/api/sessions/${session.id}`)).status, 204);
    assert.deepEqual(await revoked, { sessionId: session.id });
    socket.close();

    const me = await browser.call('GET', '/api/session');
    assert.equal(me.status, 401);
    assert.equal(me.body.error.code, 'session_required');
  });

  test("a user cannot revoke another user's session", async () => {
    const { phone } = await enrolledPhone();
    const { phone: other } = await enrolledPhone();
    await signedInBrowser(phone);
    const [session] = (await phone.call('GET', '/api/sessions')).body.sessions;
    const result = await other.call('DELETE', `/api/sessions/${session.id}`);
    assert.equal(result.status, 404);
  });

  test('logout revokes the session and clears the cookie', async () => {
    const { phone } = await enrolledPhone();
    const browser = await signedInBrowser(phone);
    assert.equal((await browser.call('POST', '/api/session/logout')).status, 204);
    assert.equal(browser.cookies.has('capstone_session'), false);
    assert.equal((await phone.call('GET', '/api/sessions')).body.sessions.length, 0);
  });

  test('revoking a device ends its sessions and invalidates its token', async () => {
    const { user, phone } = await enrolledPhone();
    const browser = await signedInBrowser(phone);
    const second = new Phone(server);
    await second.enroll(user);

    const result = await second.call('POST', `/api/devices/${phone.deviceId}/revoke`, {
      body: { reason: 'lost' },
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.revokedSessions, 1);
    assert.equal((await browser.call('GET', '/api/session')).status, 401);
    assert.equal((await phone.call('GET', '/api/sessions')).status, 401);
    const devices = await second.call('GET', '/api/devices');
    assert.deepEqual(
      devices.body.devices.map((d) => d.id),
      [second.deviceId],
    );
  });
});

describe('consistent errors', { skip: skipWithoutDatabase }, () => {
  test('unknown routes, bad JSON and invalid fields share one error shape', async () => {
    const browser = new Browser(server);
    const missing = await browser.call('GET', '/api/nope');
    assert.deepEqual(missing.body.error.code, 'not_found');

    const badJson = await fetch(`${server.baseUrl}/api/auth/password-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(badJson.status, 400);
    assert.equal((await badJson.json()).error.code, 'invalid_json');

    const invalid = await new Phone(server).call('POST', '/api/auth/password-login', {
      body: { email: 'x', password: 'y', extra: true },
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, 'invalid_request');
    assert.ok(invalid.body.error.details.some((d) => d.path === 'email'));
  });

  test('bad path parameters are rejected before reaching the database', async () => {
    const result = await new Browser(server).call('GET', '/api/login/challenges/not-a-uuid');
    assert.equal(result.status, 400);
  });
});

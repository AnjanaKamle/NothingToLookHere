#!/usr/bin/env node
/**
 * DEVELOPMENT-ONLY end-to-end smoke check against a RUNNING stack (npm run dev:api + PostgreSQL).
 *
 *   npm run smoke                 full run (includes a ~65 s wait for challenge expiry)
 *   SMOKE_SKIP_EXPIRY=1 npm run smoke
 *
 * Unlike the test suite (which starts its own server), this talks to the real dev API over HTTP and
 * Socket.IO exactly as the browser and phone do. The "phone" holds a real P-256 key and signs
 * like the native module (ECDSA-SHA256, DER). It creates a throwaway account directly in the dev
 * database, walks the whole flow and its failure cases, prints PASS/FAIL per step, and deletes the
 * account at the end (audit events are kept by design).
 *
 * The dev API has rate limits on. Each run uses 3 password sign-ins, 4 enrollments and 2 recovery
 * attempts, so a few runs per 15 minutes are fine.
 */
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import pg from 'pg';
import { io } from 'socket.io-client';
import {
  SocketEvents,
  buildEnrollmentMessage,
  buildLoginDecisionMessage,
  parseQrPayload,
} from '@capstone/protocol';
import { createAccount } from '../src/services/accounts.js';

if (process.env.NODE_ENV === 'production') {
  console.error('smoke-test is a development tool and refuses to run with NODE_ENV=production.');
  process.exit(1);
}

const API = `http://localhost:${process.env.API_PORT || 4000}`;
const ORIGIN = (process.env.WEB_ORIGIN || 'http://localhost:5173').split(',')[0].trim();
const SKIP_EXPIRY = process.env.SMOKE_SKIP_EXPIRY === '1';

// ------------------------------------------------------------------------------------------------
const results = [];
async function step(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name}\n      ${error.message}`);
  }
}
function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(method, path, { body, headers = {} } = {}) {
  const res = await fetch(API + '/api' + path, {
    method,
    headers: { ...(body !== undefined && { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: text ? JSON.parse(text) : null,
    setCookies: res.headers.getSetCookie(),
  };
}

class Browser {
  cookies = new Map();
  async call(method, path) {
    const headers = { origin: ORIGIN };
    if (this.cookies.size)
      headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const r = await request(method, path, { headers });
    for (const line of r.setCookies) {
      const [pair] = line.split(';');
      const [name, value] = pair.split('=');
      if (!value || /max-age=0|expires=thu, 01 jan 1970/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return r;
  }
  socket() {
    const headers = { origin: ORIGIN };
    if (this.cookies.size)
      headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    return io(API, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      extraHeaders: headers,
    });
  }
}

class Phone {
  constructor() {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.publicKey = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
    this.privateKey = privateKey;
  }
  sign(message) {
    return sign('sha256', Buffer.from(message), this.privateKey).toString('base64url');
  }
  call(method, path, body) {
    return request(method, path, {
      body,
      headers: this.token ? { authorization: `Bearer ${this.token}` } : {},
    });
  }
  async enroll(enrollment) {
    const r = await this.call('POST', '/devices/enroll', {
      enrollmentId: enrollment.enrollmentId,
      nonce: enrollment.nonce,
      publicKey: this.publicKey,
      signature: this.sign(buildEnrollmentMessage(enrollment)),
      keyStorage: 'software',
      deviceName: 'Smoke-test phone',
      platform: 'android',
    });
    expect(r.status === 201, `enroll returned ${r.status} ${JSON.stringify(r.body)}`);
    Object.assign(this, {
      token: r.body.deviceToken,
      deviceId: r.body.device.id,
      keyId: r.body.device.keyId,
      audience: r.body.audience,
    });
  }
  decide({ challengeId, nonce }, decision, overrides = {}) {
    const keyId = overrides.keyId ?? this.keyId;
    const message = buildLoginDecisionMessage({
      audience: this.audience,
      challengeId,
      nonce,
      keyId,
      decision,
    });
    return this.call('POST', `/login/challenges/${challengeId}/decision`, {
      nonce,
      keyId,
      decision,
      signature: overrides.signature ?? this.sign(message),
    });
  }
}

const connected = (s) =>
  new Promise((ok, fail) => {
    s.once('connect', ok);
    s.once('connect_error', fail);
  });
const nextEvent = (s, event, ms = 5000) =>
  new Promise((ok, fail) => {
    const t = setTimeout(() => fail(new Error(`no ${event} within ${ms} ms`)), ms);
    s.once(event, (p) => {
      clearTimeout(t);
      ok(p);
    });
  });
const watch = (s, c) =>
  s.timeout(5000).emitWithAck(SocketEvents.WATCH_LOGIN, {
    challengeId: c.challengeId,
    watchToken: c.watchToken,
  });

async function newChallenge(browser) {
  const r = await browser.call('POST', '/login/challenges');
  expect(r.status === 201, `create challenge returned ${r.status}`);
  return { ...r.body, ...parseQrPayload(r.body.qrPayload) };
}

// ------------------------------------------------------------------------------------------------
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const email = `smoke-${randomBytes(4).toString('hex')}@example.test`;
const password = randomBytes(18).toString('base64url');
let recoveryCodes = [];
let userId;

const phone = new Phone();
const browser = new Browser();
let challenge;

console.log(`Smoke test against ${API} (origin ${ORIGIN})\n`);

await step('API is up and connected to PostgreSQL', async () => {
  const r = await request('GET', '/health');
  expect(
    r.status === 200 && r.body.database === 'ok',
    `health: ${r.status} ${JSON.stringify(r.body)}`,
  );
});

await step('Account created (dev-only path) with recovery codes', async () => {
  ({ userId, recoveryCodes } = await createAccount(pool, { email, password }));
  expect(recoveryCodes.length === 10, 'expected 10 recovery codes');
});

await step('Enrollment: password sign-in yields only an enrollment challenge', async () => {
  const r = await phone.call('POST', '/auth/password-login', { email, password });
  expect(r.status === 200 && r.body.enrollment && r.setCookies.length === 0, `got ${r.status}`);
  await phone.enroll(r.body.enrollment);
});

await step(
  'Browser creates challenge: HttpOnly binding cookie, QR holds only id + nonce',
  async () => {
    challenge = await newChallenge(browser);
    expect(challenge.challengeId && challenge.nonce, 'QR payload did not parse');
    const binding = [...browser.cookies.values()][0];
    expect(binding && !challenge.qrPayload.includes(binding), 'binding secret leaked into QR');
    expect(!challenge.qrPayload.includes(challenge.watchToken), 'watch token leaked into QR');
  },
);

const socket = browser.socket();
await step('Browser subscribes over Socket.IO and sees "pending"', async () => {
  await connected(socket);
  const ack = await watch(socket, challenge);
  expect(ack.ok && ack.status === 'pending', `ack ${JSON.stringify(ack)}`);
});

await step('Phone "scans" the QR and sees the requesting browser', async () => {
  const r = await phone.call('POST', `/login/challenges/${challenge.challengeId}/inspect`, {
    nonce: challenge.nonce,
  });
  expect(r.status === 200 && 'userAgent' in r.body.requester, `inspect ${r.status}`);
});

await step('Invalid signature is rejected (401 invalid_signature)', async () => {
  const forged = new Phone().sign('not the right message');
  const r = await phone.decide(challenge, 'approved', { signature: forged });
  expect(
    r.status === 401 && r.body.error.code === 'invalid_signature',
    `got ${r.status} ${r.body?.error?.code}`,
  );
});

await step('Unknown key id is rejected (401 key_not_active)', async () => {
  const r = await phone.decide(challenge, 'approved', {
    keyId: '00000000-0000-4000-8000-000000000000',
  });
  expect(
    r.status === 401 && r.body.error.code === 'key_not_active',
    `got ${r.status} ${r.body?.error?.code}`,
  );
});

await step('Phone approves; browser receives login:approved in real time', async () => {
  const event = nextEvent(socket, SocketEvents.LOGIN_APPROVED);
  const r = await phone.decide(challenge, 'approved');
  expect(r.status === 200 && r.body.status === 'approved', `decision ${r.status}`);
  await event;
});

await step('Duplicate approval is rejected (409)', async () => {
  const r = await phone.decide(challenge, 'approved');
  expect(r.status === 409, `got ${r.status}`);
});

let capturedBindingCookie;
await step('Browser completes: HttpOnly session cookie, GET /session works', async () => {
  // Keep a copy of the binding cookie to replay later, as an attacker who captured the request would.
  capturedBindingCookie = [...browser.cookies].find(([name]) =>
    name.includes(challenge.challengeId),
  );
  const r = await browser.call('POST', `/login/challenges/${challenge.challengeId}/complete`);
  expect(r.status === 200 && r.body.user.email === email, `complete ${r.status}`);
  const cookie = r.setCookies.find((c) => /capstone_session=/.test(c));
  expect(
    cookie && /HttpOnly/i.test(cookie) && /SameSite=Lax/i.test(cookie),
    'session cookie flags',
  );
  expect((await browser.call('GET', '/session')).status === 200, 'GET /session failed');
});
socket.close();

await step(
  'Replayed completion is rejected (binding cookie cleared → 404; replayed with it → 409)',
  async () => {
    const path = `/login/challenges/${challenge.challengeId}/complete`;
    const normal = await browser.call('POST', path);
    expect(normal.status === 404, `browser retry got ${normal.status}`);
    expect(capturedBindingCookie, 'binding cookie was not captured');
    const replay = await request('POST', path, {
      headers: {
        origin: ORIGIN,
        cookie: `${capturedBindingCookie[0]}=${capturedBindingCookie[1]}`,
      },
    });
    expect(
      replay.status === 409 && replay.body.error.code === 'challenge_not_approved',
      `replay got ${replay.status}`,
    );
  },
);

await step('Phone lists the session and revokes it; browser gets session:revoked', async () => {
  const list = await phone.call('GET', '/sessions');
  const session = list.body.sessions.find((s) => s.approvedBy.deviceId === phone.deviceId);
  expect(session, 'session not listed');
  const s = browser.socket();
  await connected(s);
  const event = nextEvent(s, SocketEvents.SESSION_REVOKED);
  expect((await phone.call('DELETE', `/sessions/${session.id}`)).status === 204, 'revoke failed');
  await event;
  s.close();
  expect((await browser.call('GET', '/session')).status === 401, 'session still valid');
});

await step('Network loss: approval while browser offline is recovered on reconnect', async () => {
  const b = new Browser();
  const c = await newChallenge(b);
  const first = b.socket();
  await connected(first);
  await watch(first, c);
  first.close(); // connection lost
  expect((await phone.decide(c, 'approved')).status === 200, 'approve failed');
  const second = b.socket(); // reconnect
  await connected(second);
  const ack = await watch(second, c);
  second.close();
  expect(ack.status === 'approved', `ack after reconnect: ${ack.status}`);
  expect(
    (await b.call('POST', `/login/challenges/${c.challengeId}/complete`)).status === 200,
    'complete failed',
  );
});

await step('Rejection: browser receives login:denied and cannot complete', async () => {
  const b = new Browser();
  const c = await newChallenge(b);
  const s = b.socket();
  await connected(s);
  await watch(s, c);
  const event = nextEvent(s, SocketEvents.LOGIN_DENIED);
  expect((await phone.decide(c, 'denied')).status === 200, 'deny failed');
  await event;
  s.close();
  expect(
    (await b.call('POST', `/login/challenges/${c.challengeId}/complete`)).status === 409,
    'denied challenge completed',
  );
});

if (SKIP_EXPIRY) {
  console.log('SKIP  Challenge expiry (SMOKE_SKIP_EXPIRY=1)');
} else {
  await step(
    'Expiry: login:expired arrives, status "expired", late approval rejected',
    async () => {
      const b = new Browser();
      const c = await newChallenge(b);
      const s = b.socket();
      await connected(s);
      await watch(s, c);
      const waitMs = Date.parse(c.expiresAt) - Date.now() + 5000;
      console.log(`      waiting ${Math.round(waitMs / 1000)} s for expiry…`);
      await nextEvent(s, SocketEvents.LOGIN_EXPIRED, waitMs);
      s.close();
      expect(
        (await b.call('GET', `/login/challenges/${c.challengeId}`)).body.status === 'expired',
        'status not expired',
      );
      expect((await phone.decide(c, 'approved')).status === 409, 'late approval accepted');
    },
  );
}

const second = new Phone();
await step('Revoked device: a phone revoked by another phone can no longer act', async () => {
  const login = await second.call('POST', '/auth/password-login', { email, password });
  await second.enroll(login.body.enrollment);
  const r = await second.call('POST', `/devices/${phone.deviceId}/revoke`, { reason: 'lost' });
  expect(r.status === 200, `revoke ${r.status}`);
  const c = await newChallenge(new Browser());
  const d = await phone.decide(c, 'approved');
  expect(
    d.status === 401 && d.body.error.code === 'device_auth_required',
    `revoked phone got ${d.status}`,
  );
});

await step(
  'Lost-device recovery: wrong code rejected, right code revokes all and re-enrolls',
  async () => {
    const fresh = new Phone();
    const wrong = await fresh.call('POST', '/recovery', {
      email,
      password,
      recoveryCode: 'AAAA-BBBB-CCCC',
    });
    expect(wrong.status === 401, `wrong code got ${wrong.status}`);
    const ok = await fresh.call('POST', '/recovery', {
      email,
      password,
      recoveryCode: recoveryCodes[0],
    });
    expect(ok.status === 200 && ok.body.revoked.devices >= 1, `recovery ${ok.status}`);
    expect((await second.call('GET', '/sessions')).status === 401, 'old phone still trusted');
    await fresh.enroll(ok.body.enrollment);
    expect(
      (await fresh.call('GET', '/devices')).body.devices.length === 1,
      'expected only the new phone',
    );
  },
);

// ------------------------------------------------------------------------------------------------
if (userId) await pool.query('DELETE FROM users WHERE id = $1', [userId]);
await pool.end();

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} checks passed${failed.length ? '' : ' ✔'}`,
);
process.exit(failed.length ? 1 : 0);

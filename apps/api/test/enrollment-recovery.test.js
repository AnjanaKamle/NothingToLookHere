import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { Browser, Phone, createUser, skipWithoutDatabase, startServer } from './support.js';

let server;
before(async () => {
  if (!skipWithoutDatabase) server = await startServer();
});
after(async () => {
  await server?.close();
});

describe('password sign-in', { skip: skipWithoutDatabase }, () => {
  test('wrong password and unknown email give the same error', async () => {
    const user = await createUser(server);
    const phone = new Phone(server);
    const wrong = await phone.passwordLogin({ ...user, password: 'not the password!' });
    const unknown = await phone.passwordLogin({
      email: 'nobody@example.test',
      password: 'whatever12345',
    });
    assert.equal(wrong.status, 401);
    assert.deepEqual(wrong.body, unknown.body);
  });

  test('a correct password yields only an enrollment challenge, not a session', async () => {
    const user = await createUser(server);
    const result = await new Phone(server).passwordLogin(user);
    assert.equal(result.status, 200);
    assert.deepEqual(Object.keys(result.body), ['enrollment']);
    assert.deepEqual(Object.keys(result.body.enrollment).sort(), [
      'audience',
      'enrollmentId',
      'expiresAt',
      'nonce',
    ]);
    assert.equal(result.setCookies.length, 0);
  });
});

describe('enrollment', { skip: skipWithoutDatabase }, () => {
  test('an enrollment challenge can be used once', async () => {
    const user = await createUser(server);
    const phone = new Phone(server);
    const { enrollment } = (await phone.passwordLogin(user)).body;
    assert.equal(
      (await phone.call('POST', '/api/devices/enroll', { body: phone.enrollmentBody(enrollment) }))
        .status,
      201,
    );
    const second = new Phone(server);
    const replay = await second.call('POST', '/api/devices/enroll', {
      body: second.enrollmentBody(enrollment),
    });
    assert.equal(replay.status, 409);
    assert.equal(replay.body.error.code, 'enrollment_unavailable');
  });

  test('proof of possession: a signature by a different key is rejected', async () => {
    const user = await createUser(server);
    const phone = new Phone(server);
    const { enrollment } = (await phone.passwordLogin(user)).body;
    const other = new Phone(server);
    const body = phone.enrollmentBody(enrollment, {
      signature: other.enrollmentBody(enrollment).signature,
    });
    const result = await phone.call('POST', '/api/devices/enroll', { body });
    assert.equal(result.status, 401);
    assert.equal(result.body.error.code, 'invalid_signature');
  });

  test('only P-256 public keys are accepted', async () => {
    const user = await createUser(server);
    const phone = new Phone(server);
    const { enrollment } = (await phone.passwordLogin(user)).body;
    const p384 = generateKeyPairSync('ec', { namedCurve: 'P-384' }).publicKey.export({
      type: 'spki',
      format: 'der',
    });
    const result = await phone.call('POST', '/api/devices/enroll', {
      body: phone.enrollmentBody(enrollment, { publicKey: p384.toString('base64url') }),
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, 'invalid_public_key');
  });

  test('a public key cannot be registered twice, and the failed attempt does not burn the challenge', async () => {
    const user = await createUser(server);
    const first = new Phone(server);
    await first.enroll(user);

    const copycat = new Phone(server);
    copycat.publicKey = first.publicKey;
    copycat.privateKey = first.privateKey;
    const { enrollment } = (await copycat.passwordLogin(user)).body;
    const duplicate = await copycat.call('POST', '/api/devices/enroll', {
      body: copycat.enrollmentBody(enrollment),
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'public_key_already_registered');

    copycat.newKey();
    const retry = await copycat.call('POST', '/api/devices/enroll', {
      body: copycat.enrollmentBody(enrollment),
    });
    assert.equal(retry.status, 201);
  });

  test('key rotation replaces the active key; the old key stops working', async () => {
    const user = await createUser(server);
    const phone = new Phone(server);
    await phone.enroll(user);
    const oldKeyId = phone.keyId;
    const oldPrivateKey = phone.privateKey;

    const start = await phone.call('POST', '/api/devices/me/key-rotation');
    phone.newKey();
    const { enrollmentId, nonce } = start.body.enrollment;
    const body = phone.enrollmentBody(start.body.enrollment);
    const rotated = await phone.call('POST', '/api/devices/me/keys', {
      body: {
        enrollmentId,
        nonce,
        publicKey: body.publicKey,
        signature: body.signature,
        keyStorage: 'strongbox',
      },
    });
    assert.equal(rotated.status, 201);
    phone.keyId = rotated.body.keyId;

    const challenge = await new Browser(server).startLogin();
    const stale = new Phone(server);
    Object.assign(stale, {
      privateKey: oldPrivateKey,
      keyId: oldKeyId,
      audience: phone.audience,
      deviceToken: phone.deviceToken,
    });
    const staleResult = await stale.decide(challenge);
    assert.equal(staleResult.status, 401);
    assert.equal(staleResult.body.error.code, 'key_not_active');
    assert.equal((await phone.decide(challenge)).status, 200);
  });
});

describe('recovery', { skip: skipWithoutDatabase }, () => {
  test('lost phone: password + recovery code revokes everything and allows re-enrollment', async () => {
    const user = await createUser(server);
    const lostPhone = new Phone(server);
    await lostPhone.enroll(user);
    const browser = new Browser(server);
    const challenge = await browser.startLogin();
    await lostPhone.decide(challenge);
    await browser.call('POST', `/api/login/challenges/${challenge.challengeId}/complete`);

    const newPhone = new Phone(server);
    const recover = (code, extra = {}) =>
      newPhone.call('POST', '/api/recovery', {
        body: { email: user.email, password: user.password, recoveryCode: code, ...extra },
      });

    const wrongCode = await recover('AAAA-BBBB-CCCC');
    assert.equal(wrongCode.status, 401);
    assert.equal(wrongCode.body.error.code, 'invalid_credentials');

    // Codes are accepted case-insensitively and without dashes.
    const code = user.recoveryCodes[0].toLowerCase().replaceAll('-', ' ');
    const result = await recover(code, { newPassword: 'a brand new long password' });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.revoked, { devices: 1, sessions: 1 });
    assert.equal(result.body.passwordChanged, true);

    // Everything tied to the lost phone is dead.
    assert.equal((await lostPhone.call('GET', '/api/sessions')).status, 401);
    assert.equal((await browser.call('GET', '/api/session')).status, 401);

    // The returned enrollment challenge enrolls the new phone.
    const enrolled = await newPhone.call('POST', '/api/devices/enroll', {
      body: newPhone.enrollmentBody(result.body.enrollment),
    });
    assert.equal(enrolled.status, 201);
    newPhone.deviceToken = enrolled.body.deviceToken;

    // The old code batch was revoked: no codes remain until new ones are generated.
    assert.equal((await newPhone.call('GET', '/api/recovery/codes')).body.remaining, 0);
    const regenerated = await newPhone.call('POST', '/api/recovery/codes');
    assert.equal(regenerated.status, 201);
    assert.equal(regenerated.body.recoveryCodes.length, 10);
    assert.equal((await newPhone.call('GET', '/api/recovery/codes')).body.remaining, 10);

    // The old password no longer works; the spent code cannot be reused.
    const reuse = await recover(user.recoveryCodes[0], { password: 'a brand new long password' });
    assert.equal(reuse.status, 401);
    assert.equal((await newPhone.passwordLogin(user)).status, 401);
  });

  test('concurrent recovery attempts with the same code: only one succeeds', async () => {
    const user = await createUser(server);
    const phone = new Phone(server);
    const attempt = () =>
      phone.call('POST', '/api/recovery', {
        body: { email: user.email, password: user.password, recoveryCode: user.recoveryCodes[1] },
      });
    const results = await Promise.all([attempt(), attempt(), attempt()]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 401, 401]);
  });
});

describe('activity', { skip: skipWithoutDatabase }, () => {
  test('the phone sees its security events, newest first, with pagination', async () => {
    const user = await createUser(server);
    const phone = new Phone(server);
    await phone.enroll(user);
    const first = await phone.call('GET', '/api/activity?limit=2');
    assert.equal(first.status, 200);
    assert.equal(first.body.events.length, 2);
    assert.equal(first.body.events[0].type, 'device.enrolled');
    const { before, beforeId } = first.body.nextCursor;
    const next = await phone.call(
      'GET',
      `/api/activity?limit=2&before=${encodeURIComponent(before)}&beforeId=${beforeId}`,
    );
    assert.equal(next.status, 200);
    assert.ok(next.body.events.every((e) => e.id < beforeId));
  });
});

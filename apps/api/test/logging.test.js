import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Browser, Phone, createUser, skipWithoutDatabase, startServer } from './support.js';

test(
  'request logs never contain passwords, tokens, nonces, signatures or QR payloads',
  { skip: skipWithoutDatabase },
  async () => {
    const lines = [];
    const original = { log: console.log, error: console.error };
    console.log = (...args) => lines.push(args.join(' '));
    console.error = (...args) => lines.push(args.join(' '));

    const server = await startServer({ logRequests: true });
    const secrets = [];
    try {
      const user = await createUser(server);
      secrets.push(user.password, ...user.recoveryCodes);
      const phone = new Phone(server);
      await phone.enroll(user);
      secrets.push(phone.deviceToken);

      const browser = new Browser(server);
      const challenge = await browser.startLogin();
      secrets.push(
        challenge.nonce,
        challenge.qrPayload,
        challenge.watchToken,
        ...browser.cookies.values(),
      );

      const body = phone.decisionBody(challenge);
      secrets.push(body.signature);
      await phone.call('POST', `/api/login/challenges/${challenge.challengeId}/decision`, { body });
      await phone.decide(challenge); // replay, logged as 409
      await browser.call('POST', `/api/login/challenges/${challenge.challengeId}/complete`);
      secrets.push(...browser.cookies.values());
      await phone.call('POST', '/api/recovery', {
        body: { email: user.email, password: user.password, recoveryCode: user.recoveryCodes[0] },
      });
    } finally {
      await server.close();
      Object.assign(console, original);
    }

    assert.ok(lines.length > 5, 'requests were logged');
    const logText = lines.join('\n');
    for (const secret of secrets) {
      assert.equal(
        logText.includes(secret),
        false,
        `log output contains a secret (${secret.slice(0, 6)}…)`,
      );
    }
  },
);

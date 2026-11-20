import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SocketEvents,
  QR_PAYLOAD_PREFIX,
  PROTOCOL_VERSION,
  buildLoginDecisionMessage,
  buildEnrollmentMessage,
  formatQrPayload,
  parseQrPayload,
} from '../src/index.js';

const vector = JSON.parse(
  readFileSync(new URL('../test-vectors/es256.json', import.meta.url), 'utf8'),
);

test('socket event names are unique', () => {
  const names = Object.values(SocketEvents);
  assert.equal(new Set(names).size, names.length);
});

test('QR prefix carries the protocol version', () => {
  assert.ok(QR_PAYLOAD_PREFIX.includes(`v${PROTOCOL_VERSION}`));
});

test('shared constants cannot be mutated at runtime', () => {
  assert.ok(Object.isFrozen(SocketEvents));
});

test('login decision message matches the test vector byte for byte', () => {
  assert.equal(
    buildLoginDecisionMessage(vector.loginDecision.fields),
    vector.loginDecision.message,
  );
});

test('enrollment message matches the test vector byte for byte', () => {
  assert.equal(buildEnrollmentMessage(vector.enrollment.fields), vector.enrollment.message);
});

test('message builders reject values that could make the encoding ambiguous', () => {
  const fields = vector.loginDecision.fields;
  assert.throws(() => buildLoginDecisionMessage({ ...fields, audience: 'a\nkey=x' }), TypeError);
  assert.throws(() => buildLoginDecisionMessage({ ...fields, nonce: 'short' }), TypeError);
  assert.throws(() => buildLoginDecisionMessage({ ...fields, decision: 'maybe' }), TypeError);
  assert.throws(
    () => buildLoginDecisionMessage({ ...fields, challengeId: fields.challengeId.toUpperCase() }),
    TypeError,
  );
});

test('a different decision produces a different message', () => {
  const fields = vector.loginDecision.fields;
  assert.notEqual(
    buildLoginDecisionMessage({ ...fields, decision: 'approved' }),
    buildLoginDecisionMessage({ ...fields, decision: 'denied' }),
  );
});

test('QR payload round-trips and rejects malformed input', () => {
  const { challengeId, nonce } = vector.loginDecision.fields;
  const payload = formatQrPayload({ challengeId, nonce });
  assert.deepEqual(parseQrPayload(payload), { challengeId, nonce });
  assert.equal(parseQrPayload('https://evil.example/' + payload), null);
  assert.equal(parseQrPayload(`${payload}.extra`), null);
  assert.equal(parseQrPayload(`${QR_PAYLOAD_PREFIX}not-a-uuid.${nonce}`), null);
  assert.equal(parseQrPayload(null), null);
});

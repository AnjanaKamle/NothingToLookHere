import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { generateKeyPairSync } from 'node:crypto';
import { buildEnrollmentMessage, buildLoginDecisionMessage } from '@capstone/protocol';
import { derSignatureToRaw, parseEs256PublicKey, verifyEs256 } from '../src/security/signatures.js';
import { hashSecret, verifySecret, RECOVERY_CODE_COST } from '../src/security/passwords.js';
import { generateRecoveryCode, normaliseRecoveryCode } from '../src/security/recoveryCodes.js';
import { decodeBase64Url } from '../src/security/tokens.js';

const vector = createRequire(import.meta.url)('@capstone/protocol/test-vectors/es256.json');
const bytes = (b64url) => Buffer.from(b64url, 'base64url');

test('the shared ES256 test vector verifies (DER signatures, SPKI key)', () => {
  const key = parseEs256PublicKey(bytes(vector.publicKeySpkiDer));
  assert.ok(key);
  for (const item of [vector.loginDecision, vector.enrollment]) {
    const message =
      item === vector.loginDecision
        ? buildLoginDecisionMessage(item.fields)
        : buildEnrollmentMessage(item.fields);
    assert.equal(message, item.message);
    const raw = verifyEs256({
      keyObject: key.keyObject,
      message,
      signatureDer: bytes(item.signatureDer),
    });
    assert.ok(raw, 'signature verifies');
    assert.equal(raw.length, 64);
  }
});

test('changing one character of the message breaks the signature', () => {
  const key = parseEs256PublicKey(bytes(vector.publicKeySpkiDer));
  const tampered = vector.loginDecision.message.replace('decision=approved', 'decision=denied');
  assert.equal(
    verifyEs256({
      keyObject: key.keyObject,
      message: tampered,
      signatureDer: bytes(vector.loginDecision.signatureDer),
    }),
    null,
  );
});

test('strict DER parsing rejects non-canonical encodings', () => {
  const good = bytes(vector.loginDecision.signatureDer);
  assert.ok(derSignatureToRaw(good));
  assert.equal(derSignatureToRaw(Buffer.concat([good, Buffer.from([0])])), null, 'trailing byte');
  const badLength = Buffer.from(good);
  badLength[1] += 1;
  assert.equal(derSignatureToRaw(badLength), null, 'wrong sequence length');
  // INTEGER with a redundant leading zero: 30 08 02 02 00 01 02 02 00 01
  assert.equal(
    derSignatureToRaw(Buffer.from('3008020200010202 0001'.replace(/ /g, ''), 'hex')),
    null,
  );
  // Negative INTEGER: 30 06 02 01 80 02 01 01
  assert.equal(derSignatureToRaw(Buffer.from('300602018002010 1'.replace(/ /g, ''), 'hex')), null);
  assert.equal(derSignatureToRaw(Buffer.alloc(64)), null, 'raw r||s is not DER');
});

test('only canonical uncompressed P-256 SPKI keys are accepted', () => {
  const p384 = generateKeyPairSync('ec', { namedCurve: 'P-384' }).publicKey.export({
    type: 'spki',
    format: 'der',
  });
  const ed25519 = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' });
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({
    type: 'spki',
    format: 'der',
  });
  for (const key of [p384, ed25519, rsa, Buffer.alloc(91)])
    assert.equal(parseEs256PublicKey(key), null);
});

test('base64url decoding is strict', () => {
  assert.equal(decodeBase64Url('abc='), null);
  assert.equal(decodeBase64Url('ab+c'), null);
  assert.ok(decodeBase64Url('AQID'));
});

test('scrypt hashes verify, embed their parameters, and reject wrong secrets', async () => {
  const hash = await hashSecret('ABCDEFGH1234', RECOVERY_CODE_COST);
  assert.match(hash, /^\$scrypt\$ln=15,r=8,p=1\$/);
  assert.equal(await verifySecret('ABCDEFGH1234', hash), true);
  assert.equal(await verifySecret('ABCDEFGH1235', hash), false);
  assert.equal(await verifySecret('x', 'not a phc string'), false);
});

test('recovery codes have 60 bits of entropy and normalise forgivingly', () => {
  const code = generateRecoveryCode();
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(
    normaliseRecoveryCode(code.toLowerCase().replaceAll('-', ' ')),
    code.replaceAll('-', ''),
  );
  assert.equal(normaliseRecoveryCode('O0IL-1111-2222'), '001111112222');
  assert.equal(normaliseRecoveryCode('UUUU-UUUU-UUUU'), null);
});

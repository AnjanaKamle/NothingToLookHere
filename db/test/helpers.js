import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import pg from 'pg';
import { getQuery } from '../src/queries.js';
import { resetTestDatabase as resetDatabase } from '../src/testing.js';

export const testDatabaseUrl = process.env.TEST_DATABASE_URL;
export const skipWithoutDatabase = testDatabaseUrl
  ? false
  : 'TEST_DATABASE_URL is not set (copy .env.example to .env and run npm run db:up)';

/** Drops and recreates the TEST database schema (guarded: name must end in _test). */
export function resetTestDatabase() {
  return resetDatabase(testDatabaseUrl);
}

export function createPool() {
  return new pg.Pool({ connectionString: testDatabaseUrl, max: 5 });
}

/** Runs a catalogued query by id. */
export function run(db, id, params = []) {
  return db.query(getQuery(id), params);
}

export const sha256 = (value) => createHash('sha256').update(value).digest();
export const random32 = () => randomBytes(32);

/** A real P-256 key pair, as the phone's Secure Enclave / Keystore would produce. */
export function newDeviceKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    spki: publicKey.export({ type: 'spki', format: 'der' }),
    signRaw: (data) => sign('sha256', data, { key: privateKey, dsaEncoding: 'ieee-p1363' }),
  };
}

let userCounter = 0;

/** Creates a user with one enrolled device and an active key. */
export async function createUserWithDevice(db) {
  userCounter += 1;
  const email = `user${userCounter}-${randomBytes(4).toString('hex')}@example.test`;
  const {
    rows: [user],
  } = await run(db, 'Q-USR-01', [email, null, '$scrypt$ln=17,r=8,p=1$c2FsdA$aGFzaA']);
  const deviceToken = random32();
  const {
    rows: [device],
  } = await run(db, 'Q-DEV-01', [user.id, 'Test phone', 'ios', sha256(deviceToken)]);
  const keyPair = newDeviceKeyPair();
  const {
    rows: [key],
  } = await run(db, 'Q-KEY-01', [device.id, 'ES256', keyPair.spki, 'secure_enclave']);
  return { userId: user.id, deviceId: device.id, keyId: key.id, deviceToken, keyPair };
}

/** Creates a pending login challenge and returns the secrets the browser and QR code would hold. */
export async function createChallenge(db, ttlSeconds = 60) {
  const nonce = random32();
  const binding = random32();
  const {
    rows: [challenge],
  } = await run(db, 'Q-LCH-01', [
    sha256(nonce),
    sha256(binding),
    ttlSeconds,
    '203.0.113.7',
    'Mozilla/5.0 (test)',
  ]);
  return { id: challenge.id, nonce, binding };
}

/** Approves (or denies) a challenge the way the API will: verify-then-guarded-UPDATE. */
export function decide(db, challenge, device, decision = 'approved') {
  const signature = device.keyPair.signRaw(
    Buffer.concat([Buffer.from(challenge.id), challenge.nonce]),
  );
  return run(db, 'Q-LCH-03', [
    challenge.id,
    decision,
    device.keyId,
    signature,
    sha256(challenge.nonce),
  ]);
}

/** Browser completes sign-in: consume the approval and create a session. */
export function complete(db, challenge, { binding = challenge.binding, windowSeconds = 60 } = {}) {
  return run(db, 'Q-LCH-05', [
    challenge.id,
    sha256(binding),
    sha256(random32()),
    12 * 3600,
    '203.0.113.7',
    'Mozilla/5.0 (test)',
    windowSeconds,
  ]);
}

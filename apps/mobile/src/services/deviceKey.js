import { buildEnrollmentMessage, buildLoginDecisionMessage } from '@capstone/protocol';
import DeviceKey, { DeviceKeyErrors } from '../../modules/device-key';
import { DEVICE_KEY_ALIAS } from '../config';

/**
 * Wrapper around the native device-key module. The private key is generated and used inside
 * the Secure Enclave / Android Keystore; this file only ever sees the public key and signatures.
 */

/** Allows Android keys whose security level is "software" (emulators). Development only. */
const ALLOW_SOFTWARE_KEYS = __DEV__ && process.env.EXPO_PUBLIC_ALLOW_SOFTWARE_KEYS === 'true';

export class DeviceKeyUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DeviceKeyUnavailableError';
  }
}

export function isDeviceKeyModuleAvailable() {
  return DeviceKey != null;
}

function requireModule() {
  if (!DeviceKey) {
    throw new DeviceKeyUnavailableError(
      'This build does not include the secure key module. Run the app as a development build ' +
        '(npx expo run:ios / run:android), not in Expo Go.',
    );
  }
  return DeviceKey;
}

/**
 * Creates a new hardware-backed key pair, replacing any previous one.
 * Refuses (and deletes) keys that are exportable, and software-only keys unless explicitly
 * allowed for development. Returns { publicKey, securityLevel }.
 */
export async function createDeviceKey() {
  const module = requireModule();
  const result = await module.generateKey(DEVICE_KEY_ALIAS);
  if (result.privateKeyExportable) {
    await module.deleteKey(DEVICE_KEY_ALIAS);
    throw new DeviceKeyUnavailableError(
      'The platform created an exportable key, which is not allowed.',
    );
  }
  if (result.securityLevel === 'software' && !ALLOW_SOFTWARE_KEYS) {
    await module.deleteKey(DEVICE_KEY_ALIAS);
    throw new DeviceKeyUnavailableError(
      "This device can only create a software-protected key, not one held in secure hardware, so it can't be used as a trusted phone.",
    );
  }
  return { publicKey: result.publicKey, securityLevel: result.securityLevel };
}

export function deleteDeviceKey() {
  return DeviceKey ? DeviceKey.deleteKey(DEVICE_KEY_ALIAS) : Promise.resolve();
}

export function hasDeviceKey() {
  return DeviceKey ? DeviceKey.hasKey(DEVICE_KEY_ALIAS) : Promise.resolve(false);
}

/** Proof of possession for enrollment / key rotation. Prompts for biometrics or passcode. */
export function signEnrollment({ audience, enrollmentId, nonce }) {
  const message = buildEnrollmentMessage({ audience, enrollmentId, nonce });
  return requireModule().sign(DEVICE_KEY_ALIAS, message, 'Confirm to register this phone');
}

/**
 * Signs an approve/deny decision for exactly one challenge. The message is built from the
 * scanned challenge id and nonce, the server audience and this phone's key id.
 */
export function signLoginDecision({ audience, challengeId, nonce, keyId, decision }) {
  const message = buildLoginDecisionMessage({ audience, challengeId, nonce, keyId, decision });
  const reason =
    decision === 'approved' ? 'Confirm to approve this sign-in' : 'Confirm to reject this sign-in';
  return requireModule().sign(DEVICE_KEY_ALIAS, message, reason);
}

export { DeviceKeyErrors };

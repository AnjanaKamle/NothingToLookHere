import { requireOptionalNativeModule } from 'expo';

/**
 * JavaScript face of the native DeviceKey module (ios/DeviceKeyModule.swift,
 * android/.../DeviceKeyModule.kt).
 *
 * The private key is created inside the Secure Enclave (iOS) or Android Keystore (StrongBox or
 * TEE), is non-exportable, and never crosses into JavaScript. JavaScript only ever receives the
 * public key and signatures.
 *
 * `null` when the native code is not in the binary, e.g. in Expo Go. The app then refuses to
 * enroll instead of falling back to a software key.
 */
const DeviceKey = requireOptionalNativeModule('DeviceKey');

export default DeviceKey;

/**
 * Error codes rejected by the native module (error.code):
 *   ERR_HARDWARE_UNAVAILABLE  no Secure Enclave / Keystore available
 *   ERR_NO_PASSCODE           the device has no screen lock, so user presence cannot be enforced
 *   ERR_KEY_EXPORTABLE        the platform returned an exportable private key (refused)
 *   ERR_KEY_NOT_FOUND         no key under this alias
 *   ERR_KEY_INVALIDATED       Android invalidated the key (e.g. biometrics changed)
 *   ERR_USER_CANCELLED        the user dismissed the biometric/passcode prompt
 *   ERR_AUTH_FAILED           biometric/passcode authentication failed or is locked out
 *   ERR_GENERATION_FAILED, ERR_SIGNING_FAILED, ERR_NO_ACTIVITY
 */
export const DeviceKeyErrors = Object.freeze({
  HARDWARE_UNAVAILABLE: 'ERR_HARDWARE_UNAVAILABLE',
  NO_PASSCODE: 'ERR_NO_PASSCODE',
  KEY_EXPORTABLE: 'ERR_KEY_EXPORTABLE',
  KEY_NOT_FOUND: 'ERR_KEY_NOT_FOUND',
  KEY_INVALIDATED: 'ERR_KEY_INVALIDATED',
  USER_CANCELLED: 'ERR_USER_CANCELLED',
  AUTH_FAILED: 'ERR_AUTH_FAILED',
});

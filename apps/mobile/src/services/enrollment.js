import { Platform } from 'react-native';
import * as api from './api';
import { saveEnrollment } from './credentials';
import { createDeviceKey, deleteDeviceKey, signEnrollment } from './deviceKey';

/**
 * Full enrollment: create the hardware key, prove possession by signing the server's nonce,
 * register the public key, and store the returned device token securely.
 * `challenge` comes from password sign-in or account recovery.
 */
export async function enrollThisPhone(challenge, deviceName) {
  const key = await createDeviceKey();
  try {
    const signature = await signEnrollment(challenge);
    const result = await api.enrollDevice({
      enrollmentId: challenge.enrollmentId,
      nonce: challenge.nonce,
      publicKey: key.publicKey,
      signature,
      keyStorage: key.securityLevel,
      deviceName,
      platform: Platform.OS === 'ios' ? 'ios' : 'android',
    });
    const enrollment = {
      deviceId: result.device.id,
      keyId: result.device.keyId,
      deviceToken: result.deviceToken,
      audience: result.audience,
      deviceName: result.device.name,
      keyStorage: key.securityLevel,
    };
    await saveEnrollment(enrollment);
    return enrollment;
  } catch (error) {
    // Do not leave an orphaned key behind if registration failed.
    await deleteDeviceKey().catch(() => {});
    throw error;
  }
}

/** Replaces this phone's key (e.g. after Android invalidated it) and updates the stored key id. */
export async function rotateThisPhoneKey(enrollment) {
  const challenge = await api.startKeyRotation(enrollment.deviceToken);
  const key = await createDeviceKey();
  const signature = await signEnrollment(challenge);
  const keyId = await api.rotateKey(enrollment.deviceToken, {
    enrollmentId: challenge.enrollmentId,
    nonce: challenge.nonce,
    publicKey: key.publicKey,
    signature,
    keyStorage: key.securityLevel,
  });
  const updated = { ...enrollment, keyId, keyStorage: key.securityLevel };
  await saveEnrollment(updated);
  return updated;
}

export function defaultDeviceName() {
  return Platform.OS === 'ios' ? 'My iPhone' : 'My Android phone';
}

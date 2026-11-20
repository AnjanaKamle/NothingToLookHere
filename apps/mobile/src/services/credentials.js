import * as SecureStore from 'expo-secure-store';

/**
 * The phone's enrollment record: { deviceId, keyId, deviceToken, audience, deviceName }.
 *
 * Stored with expo-secure-store (iOS Keychain / Android Keystore-encrypted storage), readable
 * only while the device is unlocked and never migrated to another device by backup.
 * The device token is the only secret here. The signing key itself is NOT stored here or
 * anywhere in JavaScript: it lives in the Secure Enclave / Keystore (modules/device-key).
 */
const KEY = 'enrollment.v1';
const OPTIONS = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

export async function loadEnrollment() {
  const raw = await SecureStore.getItemAsync(KEY, OPTIONS);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return value?.deviceToken && value?.keyId ? value : null;
  } catch {
    return null;
  }
}

export function saveEnrollment(enrollment) {
  return SecureStore.setItemAsync(KEY, JSON.stringify(enrollment), OPTIONS);
}

export function clearEnrollment() {
  return SecureStore.deleteItemAsync(KEY, OPTIONS);
}

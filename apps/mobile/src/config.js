/**
 * Runtime configuration for the phone app.
 * Expo inlines EXPO_PUBLIC_* variables at build time from apps/mobile/.env.
 * These values are public by definition: never put secrets in EXPO_PUBLIC_* variables.
 */
export const API_URL = process.env.EXPO_PUBLIC_API_URL?.replace(/\/+$/, '') || null;

/** Keychain / Keystore alias of this app's device key. One key per installation. */
export const DEVICE_KEY_ALIAS = 'trusted-phone-key';

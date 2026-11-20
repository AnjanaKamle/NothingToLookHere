import { ApiError, NetworkError } from '../services/http';
import { DeviceKeyErrors, DeviceKeyUnavailableError } from '../services/deviceKey';

/** Plain-language text for any error a screen may receive. Never includes secrets. */
export function describeError(error) {
  if (error instanceof NetworkError) return error.message;
  if (error instanceof DeviceKeyUnavailableError) return error.message;

  if (error instanceof ApiError) {
    switch (error.code) {
      case 'invalid_credentials':
        return 'Those details are not correct.';
      case 'account_disabled':
        return 'This account is disabled.';
      case 'rate_limited':
        return 'Too many attempts. Wait a few minutes and try again.';
      case 'enrollment_unavailable':
        return 'That registration request expired. Sign in again to restart.';
      case 'public_key_already_registered':
        return 'This key is already registered. Try enrolling again.';
      case 'challenge_unavailable':
        return 'This sign-in request has expired or was already answered. Ask for a new QR code in the browser.';
      case 'invalid_signature':
        return 'The server could not verify this phone’s signature. Nothing was approved.';
      case 'key_not_active':
      case 'device_auth_required':
        return 'This phone is no longer trusted for this account. Enroll it again.';
      case 'session_not_found':
        return 'That session has already ended.';
      case 'invalid_request':
        return error.details?.[0]?.message ?? 'Some details are missing or invalid.';
      default:
        return error.message || 'Something went wrong. Try again.';
    }
  }

  switch (error?.code) {
    case DeviceKeyErrors.USER_CANCELLED:
      return 'You cancelled the confirmation. Nothing was sent.';
    case DeviceKeyErrors.AUTH_FAILED:
      return 'Your identity could not be confirmed. Try again.';
    case DeviceKeyErrors.NO_PASSCODE:
      return 'Set a screen lock (passcode, PIN or pattern) on this phone first. The secure key requires it.';
    case DeviceKeyErrors.HARDWARE_UNAVAILABLE:
      return 'This phone has no secure hardware for the key, so it can’t be used as a trusted phone.';
    case DeviceKeyErrors.KEY_EXPORTABLE:
      return 'The phone could not create a protected key. It can’t be used as a trusted phone.';
    case DeviceKeyErrors.KEY_NOT_FOUND:
      return 'This phone’s secure key is missing. Enroll the phone again.';
    case DeviceKeyErrors.KEY_INVALIDATED:
      return 'A security change on this phone (for example new fingerprints) disabled its key. Create a new key to continue.';
    default:
      return 'Something went wrong. Try again.';
  }
}

/** True when the phone itself is no longer trusted and should be enrolled again. */
export function isEnrollmentLost(error) {
  return (
    (error instanceof ApiError &&
      ['key_not_active', 'device_auth_required'].includes(error.code)) ||
    error?.code === DeviceKeyErrors.KEY_NOT_FOUND
  );
}

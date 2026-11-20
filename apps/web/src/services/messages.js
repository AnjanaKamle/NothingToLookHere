import { ApiError, NetworkError } from './http';

/** Plain-language text for errors shown in the browser. */
export function describeError(error) {
  if (error instanceof NetworkError) return error.message;
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'challenge_not_approved':
        return 'The approval could not be used. It may have expired, or the phone was signed out meanwhile. Get a new QR code and try again.';
      case 'challenge_not_found':
        return 'This sign-in attempt is no longer valid in this browser. Get a new QR code.';
      case 'rate_limited':
        return 'Too many attempts. Wait a minute and try again.';
      case 'untrusted_origin':
        return 'This page is not allowed to sign in to the service. Open the official sign-in page.';
      default:
        return 'Something went wrong on the server. Try again.';
    }
  }
  return 'Something went wrong. Try again.';
}

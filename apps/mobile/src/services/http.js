import { API_URL } from '../config';

/** An error response from the API, carrying its stable `code` (see docs/API.md). */
export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** The request never reached the API or got no usable response. */
export class NetworkError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NetworkError';
  }
}

const TIMEOUT_MS = 15000;

/**
 * Calls the API. All API traffic from the phone goes through here.
 * Returns { body, serverTime } where serverTime (ms) comes from the Date header, so countdowns
 * can correct for a wrong phone clock.
 */
export async function apiRequest(path, { method = 'GET', body, deviceToken } = {}) {
  if (!API_URL) throw new NetworkError('The API address is not configured (EXPO_PUBLIC_API_URL).');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${API_URL}/api${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
        ...(deviceToken && { Authorization: `Bearer ${deviceToken}` }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    throw new NetworkError("Can't reach the sign-in server. Check your connection and try again.");
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new NetworkError('The server sent an unexpected response.');
  }
  if (!response.ok) {
    const error = data?.error ?? {};
    throw new ApiError(
      response.status,
      error.code ?? 'unknown_error',
      error.message ?? 'Request failed',
      error.details,
    );
  }
  const dateHeader = response.headers.get('date');
  return { body: data, serverTime: dateHeader ? Date.parse(dateHeader) : Date.now() };
}

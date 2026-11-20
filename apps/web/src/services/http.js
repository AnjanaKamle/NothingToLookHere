/**
 * The only place the browser calls the API. Paths are relative (/api/...): the dev server proxies
 * them (vite.config.js) and production serves web and API from one origin, so cookies stay
 * first-party. Authentication is entirely cookie-based (HttpOnly cookies set by the API);
 * nothing sensitive is stored in localStorage or readable by JavaScript.
 */
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export class NetworkError extends Error {
  constructor() {
    super("Can't reach the server. Check your connection and try again.");
    this.name = 'NetworkError';
  }
}

export async function apiFetch(path, { method = 'GET' } = {}) {
  let response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
  } catch {
    throw new NetworkError();
  }

  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new NetworkError();
  }
  if (!response.ok) {
    throw new ApiError(
      response.status,
      body?.error?.code ?? 'unknown_error',
      body?.error?.message ?? 'Request failed',
    );
  }
  const date = response.headers.get('date');
  return { body, serverTime: date ? Date.parse(date) : Date.now() };
}

/**
 * Cookie names and options for browser authentication.
 *
 *  - Session cookie: random 256-bit token; only its SHA-256 is stored. HttpOnly, SameSite=Lax,
 *    Path=/, Secure when COOKIE_SECURE (always in production). With Secure, the "__Host-" prefix
 *    makes the browser refuse it unless it is Secure, host-only and Path=/.
 *  - Login binding cookie: one per challenge, proves "this browser created the challenge".
 *    HttpOnly, SameSite=Strict (never sent on cross-site requests), scoped to the challenge
 *    endpoints, and it lives only as long as the challenge plus the completion window.
 */
export function sessionCookieName(config) {
  return config.cookieSecure ? '__Host-capstone_session' : 'capstone_session';
}

export function sessionCookieOptions(config) {
  return {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    path: '/',
    maxAge: config.sessionTtlSeconds * 1000,
  };
}

export function bindingCookieName(config, challengeId) {
  return `${config.cookieSecure ? '__Secure-' : ''}capstone_login_${challengeId}`;
}

export function bindingCookieOptions(config, challengeId) {
  return {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'strict',
    path: `/api/login/challenges/${challengeId}`,
    maxAge: (config.loginChallengeTtlSeconds + config.loginCompletionWindowSeconds) * 1000,
  };
}

/** Clearing a cookie requires the same path/flags it was set with, minus maxAge. */
export function withoutMaxAge({ maxAge: _maxAge, ...options }) {
  return options;
}

/**
 * Minimal Cookie header parser. Our cookie values are base64url, so no decoding is needed;
 * values with other characters are ignored rather than guessed at.
 */
export function parseCookieHeader(header) {
  const cookies = Object.create(null);
  if (typeof header !== 'string') return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (/^[A-Za-z0-9_-]+$/.test(value) && !(name in cookies)) cookies[name] = value;
  }
  return cookies;
}

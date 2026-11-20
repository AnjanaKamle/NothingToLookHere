import { rateLimit } from 'express-rate-limit';
import { ApiError, forbidden, sendError } from './errors.js';
import { parseCookieHeader } from './cookies.js';

/** Attaches parsed cookies as req.cookies. */
export function cookies(req, _res, next) {
  req.cookies = parseCookieHeader(req.headers.cookie);
  next();
}

/**
 * CSRF defence for cookie-authenticated, state-changing browser endpoints: the request must carry
 * an Origin header naming one of the configured web origins. Browsers always send Origin on
 * cross-origin requests and on same-origin POST/DELETE, so a missing Origin is rejected too.
 * (SameSite cookies are the first line of defence; this is the second.)
 */
export function requireTrustedOrigin(webOrigins) {
  const allowed = new Set(webOrigins);
  return (req, _res, next) => {
    const origin = req.get('origin');
    if (!origin || !allowed.has(origin)) {
      return next(forbidden('untrusted_origin', 'Request origin is not allowed'));
    }
    next();
  };
}

/**
 * Logs method, path (without query string), status and duration. Never logs bodies, headers,
 * cookies, tokens or query strings.
 */
export function requestLogger(req, res, next) {
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const path = req.originalUrl.split('?')[0];
    console.log(`[api] ${req.method} ${path} ${res.statusCode} ${ms.toFixed(0)}ms`);
  });
  next();
}

/**
 * Per-IP rate limits (in-memory store: correct for a single API process only).
 * Pass `false` to disable all limits (used by tests).
 */
export function createRateLimiters(enabled = true) {
  const make = (windowMs, limit) =>
    enabled
      ? rateLimit({
          windowMs,
          limit,
          standardHeaders: 'draft-8',
          legacyHeaders: false,
          handler: (_req, res) =>
            sendError(res, new ApiError(429, 'rate_limited', 'Too many requests, try again later')),
        })
      : (_req, _res, next) => next();

  const minute = 60 * 1000;
  return {
    passwordLogin: make(15 * minute, 10),
    recovery: make(15 * minute, 5),
    enrollment: make(15 * minute, 20),
    createChallenge: make(minute, 30),
    phoneAction: make(minute, 120),
  };
}

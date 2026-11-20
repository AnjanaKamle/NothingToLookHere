import { AUDIENCE_PATTERN, LOGIN_CHALLENGE_TTL } from '@capstone/protocol';

/**
 * Reads and validates configuration from environment variables once at startup.
 * The rest of the API receives this object instead of reading process.env directly.
 * Every variable is documented in .env.example.
 */
export function loadConfig(env = process.env) {
  const read = (name, fallback) => {
    const value = env[name];
    return value === undefined || value === '' ? fallback : value;
  };
  const required = (name) => {
    const value = read(name);
    if (value === undefined) throw new Error(`Missing required environment variable: ${name}`);
    return value;
  };
  const integer = (name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) => {
    const raw = read(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`${name} must be an integer between ${min} and ${max}, got "${raw}"`);
    }
    return value;
  };

  const nodeEnv = read('NODE_ENV', 'development');
  const isProduction = nodeEnv === 'production';

  const audience = read('AUTH_AUDIENCE', 'capstone-local');
  if (!AUDIENCE_PATTERN.test(audience)) {
    throw new Error('AUTH_AUDIENCE must be a lower-case label such as "capstone-local"');
  }

  const watchTokenSecret = Buffer.from(required('WATCH_TOKEN_SECRET'), 'base64url');
  if (watchTokenSecret.length < 32) {
    throw new Error('WATCH_TOKEN_SECRET must be at least 32 random bytes, base64url encoded');
  }

  const cookieSecureSetting = read('COOKIE_SECURE', isProduction ? 'true' : 'false');
  if (!['true', 'false'].includes(cookieSecureSetting)) {
    throw new Error('COOKIE_SECURE must be "true" or "false"');
  }
  if (isProduction && cookieSecureSetting !== 'true') {
    throw new Error('COOKIE_SECURE cannot be disabled when NODE_ENV=production');
  }

  const day = 24 * 60 * 60;

  return Object.freeze({
    nodeEnv,
    isProduction,
    host: read('API_HOST', '0.0.0.0'),
    port: integer('API_PORT', 4000, { max: 65535 }),
    databaseUrl: required('DATABASE_URL'),
    webOrigins: read('WEB_ORIGIN', 'http://localhost:5173')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    // Express "trust proxy" setting: which proxy hops may set X-Forwarded-For.
    // A number means "trust that many hops"; otherwise a comma-separated list of addresses,
    // subnets or presets such as "loopback".
    trustProxy: /^\d+$/.test(read('TRUST_PROXY', 'loopback'))
      ? Number(read('TRUST_PROXY'))
      : read('TRUST_PROXY', 'loopback'),
    cookieSecure: cookieSecureSetting === 'true',

    authAudience: audience,
    watchTokenSecret,

    loginChallengeTtlSeconds: integer('LOGIN_CHALLENGE_TTL_SECONDS', 60, {
      min: LOGIN_CHALLENGE_TTL.minSeconds,
      max: LOGIN_CHALLENGE_TTL.maxSeconds,
    }),
    loginCompletionWindowSeconds: integer('LOGIN_COMPLETION_WINDOW_SECONDS', 60, { max: 300 }),
    enrollmentChallengeTtlSeconds: integer('ENROLLMENT_CHALLENGE_TTL_SECONDS', 300, { max: 600 }),
    sessionTtlSeconds: integer('SESSION_TTL_SECONDS', 12 * 60 * 60, { min: 300, max: 30 * day }),
    sessionIdleTimeoutSeconds: integer('SESSION_IDLE_TIMEOUT_SECONDS', 2 * 60 * 60, { min: 60 }),

    maintenanceIntervalSeconds: integer('MAINTENANCE_INTERVAL_SECONDS', 60 * 60, { min: 60 }),
    challengeRetentionSeconds: integer('CHALLENGE_RETENTION_SECONDS', day),
    sessionRetentionSeconds: integer('SESSION_RETENTION_SECONDS', 30 * day),
    auditRetentionSeconds: integer('AUDIT_RETENTION_SECONDS', 365 * day),
  });
}

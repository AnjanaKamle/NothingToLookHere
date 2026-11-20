/**
 * Turns a User-Agent string into "Chrome on macOS" style text for people.
 * A best-effort description: user agents can be spoofed, so the UI also shows the raw IP.
 */
export function describeUserAgent(userAgent) {
  if (!userAgent) return 'Unknown browser';
  const browser =
    (/Edg\//.test(userAgent) && 'Edge') ||
    (/OPR\//.test(userAgent) && 'Opera') ||
    (/Firefox\//.test(userAgent) && 'Firefox') ||
    (/Chrome\//.test(userAgent) && 'Chrome') ||
    (/Safari\//.test(userAgent) && 'Safari') ||
    'Unknown browser';
  const os =
    (/Windows NT/.test(userAgent) && 'Windows') ||
    (/iPhone|iPad/.test(userAgent) && 'iOS') ||
    (/Mac OS X/.test(userAgent) && 'macOS') ||
    (/Android/.test(userAgent) && 'Android') ||
    (/CrOS/.test(userAgent) && 'ChromeOS') ||
    (/Linux/.test(userAgent) && 'Linux') ||
    null;
  return os ? `${browser} on ${os}` : browser;
}

export function formatDateTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

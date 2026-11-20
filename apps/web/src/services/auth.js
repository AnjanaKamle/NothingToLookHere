import { ApiError, apiFetch } from './http';

/** Returns { user, session } if this browser has a valid session cookie, otherwise null. */
export async function getCurrentSession() {
  try {
    const { body } = await apiFetch('/session');
    return body;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

/**
 * Starts a QR login. The API sets an HttpOnly binding cookie for this challenge; the response
 * contains only what the page needs: the QR text (challenge id + one-time nonce), the expiry,
 * and a watch token for real-time updates.
 * `deadline` is the expiry converted to this computer's clock (corrects a wrong local clock).
 */
export async function createLoginChallenge() {
  const { body, serverTime } = await apiFetch('/login/challenges', { method: 'POST' });
  const lifetimeMs = Date.parse(body.expiresAt) - serverTime;
  return {
    ...body,
    deadline: Date.now() + lifetimeMs,
    lifetimeSeconds: Math.max(1, Math.round(lifetimeMs / 1000)),
  };
}

/** HTTP fallback when the real-time connection is down. Returns the challenge status string. */
export async function getChallengeStatus(challengeId) {
  const { body } = await apiFetch(`/login/challenges/${challengeId}`);
  return body.status;
}

/** Exchanges an approved challenge for a session cookie. Resolves with { user, session }. */
export async function completeLogin(challengeId) {
  const { body } = await apiFetch(`/login/challenges/${challengeId}/complete`, { method: 'POST' });
  return body;
}

export async function signOut() {
  await apiFetch('/session/logout', { method: 'POST' });
}

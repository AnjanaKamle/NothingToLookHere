import { apiRequest } from './http';

/**
 * One function per API endpoint used by the phone (see docs/API.md).
 * Screens call these; they never call fetch directly.
 */

// --- Account and enrollment -----------------------------------------------------------------

export async function passwordLogin(email, password) {
  const { body } = await apiRequest('/auth/password-login', {
    method: 'POST',
    body: { email, password },
  });
  return body.enrollment;
}

export async function enrollDevice(payload) {
  const { body } = await apiRequest('/devices/enroll', { method: 'POST', body: payload });
  return body;
}

export async function startKeyRotation(deviceToken) {
  const { body } = await apiRequest('/devices/me/key-rotation', { method: 'POST', deviceToken });
  return body.enrollment;
}

export async function rotateKey(deviceToken, payload) {
  const { body } = await apiRequest('/devices/me/keys', {
    method: 'POST',
    body: payload,
    deviceToken,
  });
  return body.keyId;
}

export async function recoverAccount(payload) {
  const { body } = await apiRequest('/recovery', { method: 'POST', body: payload });
  return body;
}

// --- QR approvals ---------------------------------------------------------------------------

export async function inspectChallenge(deviceToken, challengeId, nonce) {
  const { body, serverTime } = await apiRequest(`/login/challenges/${challengeId}/inspect`, {
    method: 'POST',
    body: { nonce },
    deviceToken,
  });
  return { ...body, serverTime };
}

export async function submitDecision(deviceToken, challengeId, payload) {
  const { body } = await apiRequest(`/login/challenges/${challengeId}/decision`, {
    method: 'POST',
    body: payload,
    deviceToken,
  });
  return body;
}

// --- Sessions and devices -------------------------------------------------------------------

export async function listSessions(deviceToken) {
  const { body } = await apiRequest('/sessions', { deviceToken });
  return body.sessions;
}

export async function revokeSession(deviceToken, sessionId) {
  await apiRequest(`/sessions/${sessionId}`, { method: 'DELETE', deviceToken });
}

export async function listDevices(deviceToken) {
  const { body } = await apiRequest('/devices', { deviceToken });
  return body.devices;
}

export async function revokeDevice(deviceToken, deviceId, reason) {
  const { body } = await apiRequest(`/devices/${deviceId}/revoke`, {
    method: 'POST',
    body: { reason },
    deviceToken,
  });
  return body;
}

// --- Recovery codes -------------------------------------------------------------------------

export async function remainingRecoveryCodes(deviceToken) {
  const { body } = await apiRequest('/recovery/codes', { deviceToken });
  return body.remaining;
}

export async function regenerateRecoveryCodes(deviceToken) {
  const { body } = await apiRequest('/recovery/codes', { method: 'POST', deviceToken });
  return body.recoveryCodes;
}

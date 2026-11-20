import http from 'node:http';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import pg from 'pg';
import { io as connectSocket } from 'socket.io-client';
import { resetTestDatabase } from '@capstone/db';
import {
  buildEnrollmentMessage,
  buildLoginDecisionMessage,
  parseQrPayload,
} from '@capstone/protocol';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { createNotifier } from '../src/realtime/notifier.js';
import { createRealtimeServer } from '../src/realtime/socket.js';
import { createAccount } from '../src/services/accounts.js';

export const WEB_ORIGIN = 'http://localhost:5173';
export const testDatabaseUrl = process.env.TEST_DATABASE_URL;
export const skipWithoutDatabase = testDatabaseUrl
  ? false
  : 'TEST_DATABASE_URL is not set (copy .env.example to .env and run npm run db:up)';

export function testConfig(overrides = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: testDatabaseUrl ?? 'postgres://unused@localhost/unused_test',
    WATCH_TOKEN_SECRET: randomBytes(32).toString('base64url'),
    AUTH_AUDIENCE: 'capstone-test',
    WEB_ORIGIN,
    ...overrides,
  });
}

/** Starts the real app + Socket.IO on an ephemeral port against the test database. */
export async function startServer({ reset = true, logRequests = false, env } = {}) {
  if (reset) await resetTestDatabase(testDatabaseUrl);
  const config = testConfig(env);
  const pool = new pg.Pool({ connectionString: testDatabaseUrl, max: 10 });
  const notifier = createNotifier();
  const app = createApp(
    { config, pool, notifier, checkDatabase: async () => true },
    { rateLimit: false, logRequests },
  );
  const httpServer = http.createServer(app);
  const io = createRealtimeServer(httpServer, { config, pool, notifier });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  return {
    baseUrl,
    config,
    pool,
    async close() {
      await new Promise((resolve) => io.close(() => resolve()));
      await pool.end();
    },
  };
}

let counter = 0;
export async function createUser(server, password = 'correct horse battery staple') {
  counter += 1;
  const email = `user${counter}-${randomBytes(3).toString('hex')}@example.test`;
  const { userId, recoveryCodes } = await createAccount(server.pool, { email, password });
  return { userId, email, password, recoveryCodes };
}

async function request(baseUrl, method, path, { body, headers = {} } = {}) {
  const response = await fetch(baseUrl + path, {
    method,
    headers: { ...(body !== undefined && { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
    setCookies: response.headers.getSetCookie(),
  };
}

/** A browser: keeps cookies and always sends the trusted Origin (unless overridden). */
export class Browser {
  constructor(server, { origin = WEB_ORIGIN } = {}) {
    this.server = server;
    this.origin = origin;
    this.cookies = new Map();
  }

  cookieHeader() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  async call(method, path, options = {}) {
    const headers = { ...(this.origin && { origin: this.origin }), ...options.headers };
    if (this.cookies.size) headers.cookie = this.cookieHeader();
    const result = await request(this.server.baseUrl, method, path, { ...options, headers });
    for (const line of result.setCookies) {
      const [pair, ...attributes] = line.split(';').map((part) => part.trim());
      const [name, value] = pair.split('=');
      const expired = attributes.some(
        (a) => /^max-age=0$/i.test(a) || /^expires=Thu, 01 Jan 1970/i.test(a),
      );
      if (expired || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return result;
  }

  async startLogin() {
    const result = await this.call('POST', '/api/login/challenges');
    if (result.status !== 201) throw new Error(`startLogin failed: ${JSON.stringify(result.body)}`);
    return { ...result.body, ...parseQrPayload(result.body.qrPayload) };
  }

  socket() {
    return connectSocket(this.server.baseUrl, {
      transports: ['websocket'],
      forceNew: true,
      extraHeaders: {
        origin: this.origin,
        ...(this.cookies.size && { cookie: this.cookieHeader() }),
      },
    });
  }
}

const b64 = (bytes) => Buffer.from(bytes).toString('base64url');

/**
 * A trusted phone. Holds a real P-256 private key (standing in for the Secure Enclave /
 * Keystore) and signs exactly as the native module will: ECDSA-SHA256, DER signature.
 * The private key never leaves this object; only the public key and signatures are sent.
 */
export class Phone {
  constructor(server) {
    this.server = server;
    this.newKey();
  }

  newKey() {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.publicKey = b64(publicKey.export({ type: 'spki', format: 'der' }));
    this.privateKey = privateKey;
  }

  sign(message) {
    return b64(sign('sha256', Buffer.from(message, 'utf8'), this.privateKey));
  }

  call(method, path, options = {}) {
    const headers = {
      ...(this.deviceToken && { authorization: `Bearer ${this.deviceToken}` }),
      ...options.headers,
    };
    return request(this.server.baseUrl, method, path, { ...options, headers });
  }

  passwordLogin(user) {
    return this.call('POST', '/api/auth/password-login', {
      body: { email: user.email, password: user.password },
    });
  }

  enrollmentBody(enrollment, overrides = {}) {
    return {
      enrollmentId: enrollment.enrollmentId,
      nonce: enrollment.nonce,
      publicKey: this.publicKey,
      signature: this.sign(
        buildEnrollmentMessage({
          audience: enrollment.audience,
          enrollmentId: enrollment.enrollmentId,
          nonce: enrollment.nonce,
        }),
      ),
      keyStorage: 'secure_enclave',
      deviceName: 'Test iPhone',
      platform: 'ios',
      ...overrides,
    };
  }

  async enroll(user) {
    const login = await this.passwordLogin(user);
    if (login.status !== 200)
      throw new Error(`password login failed: ${JSON.stringify(login.body)}`);
    const result = await this.call('POST', '/api/devices/enroll', {
      body: this.enrollmentBody(login.body.enrollment),
    });
    if (result.status !== 201) throw new Error(`enroll failed: ${JSON.stringify(result.body)}`);
    this.deviceToken = result.body.deviceToken;
    this.deviceId = result.body.device.id;
    this.keyId = result.body.device.keyId;
    this.audience = result.body.audience;
    return result.body;
  }

  decisionBody(challenge, decision = 'approved', overrides = {}) {
    const keyId = overrides.keyId ?? this.keyId;
    const message = buildLoginDecisionMessage({
      audience: this.audience,
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      keyId,
      decision,
    });
    return { nonce: challenge.nonce, keyId, decision, signature: this.sign(message), ...overrides };
  }

  decide(challenge, decision = 'approved', overrides = {}) {
    return this.call('POST', `/api/login/challenges/${challenge.challengeId}/decision`, {
      body: this.decisionBody(challenge, decision, overrides),
    });
  }
}

/** Waits for one Socket.IO event (or rejects after a timeout). */
export function nextEvent(socket, event, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeoutMs);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

export function emitWithAck(socket, event, payload) {
  return socket.timeout(3000).emitWithAck(event, payload);
}

export function connected(socket) {
  return new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
}

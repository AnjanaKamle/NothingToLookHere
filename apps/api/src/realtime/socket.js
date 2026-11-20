import { Server } from 'socket.io';
import { z } from 'zod';
import { ChallengeStatus, SocketEvents, NONCE_PATTERN, UUID_PATTERN } from '@capstone/protocol';
import { parseCookieHeader, sessionCookieName } from '../http/cookies.js';
import { getChallengeStatus, verifyWatchToken } from '../services/login.js';
import { authenticateSession } from '../services/sessions.js';
import { loginRoom, sessionRoom } from './notifier.js';

const MAX_WATCHES_PER_SOCKET = 5;
const watchSchema = z.strictObject({
  challengeId: z.string().regex(UUID_PATTERN),
  watchToken: z.string().regex(NONCE_PATTERN),
});

/**
 * Socket.IO server for real-time approval.
 *
 * Login watch: the browser emits WATCH_LOGIN { challengeId, watchToken } with an acknowledgement
 * callback. The token (from POST /api/login/challenges) is checked, the socket joins only that
 * challenge's room, and the ack returns the current status. A browser that reconnects after a
 * dropped connection simply emits WATCH_LOGIN again and learns the outcome from the ack, so no
 * event is lost. If the challenge is still pending, a timer emits LOGIN_EXPIRED at expiry.
 *
 * Session room: if the handshake carries a valid session cookie, the socket joins that session's
 * room and receives SESSION_REVOKED when the phone revokes it.
 */
export function createRealtimeServer(httpServer, { config, pool, notifier }) {
  const allowedOrigins = new Set(config.webOrigins);
  const io = new Server(httpServer, {
    cors: { origin: config.webOrigins, credentials: true },
    serveClient: false,
    // WebSocket upgrades are not covered by CORS, so check Origin for every connection.
    allowRequest: (req, callback) => callback(null, allowedOrigins.has(req.headers.origin)),
  });

  io.on('connection', async (socket) => {
    const timers = new Map();
    socket.on('disconnect', () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    });

    socket.on(SocketEvents.WATCH_LOGIN, async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        const parsed = watchSchema.safeParse(payload);
        if (!parsed.success) return reply({ ok: false, error: 'invalid_request' });
        const { challengeId, watchToken } = parsed.data;
        if (!verifyWatchToken(config, challengeId, watchToken)) {
          return reply({ ok: false, error: 'invalid_watch_token' });
        }
        if (!timers.has(challengeId) && timers.size >= MAX_WATCHES_PER_SOCKET) {
          return reply({ ok: false, error: 'too_many_watches' });
        }

        // Join before reading the status: a decision committed after the join arrives as an
        // event; one committed before the read is reported in the ack. Nothing falls in between.
        socket.join(loginRoom(challengeId));
        const state = await getChallengeStatus(pool, config, challengeId);
        if (!state) {
          socket.leave(loginRoom(challengeId));
          return reply({ ok: false, error: 'challenge_not_found' });
        }
        reply({ ok: true, ...state });

        clearTimeout(timers.get(challengeId));
        if (state.status === ChallengeStatus.PENDING) {
          const delay = Math.max(0, new Date(state.expiresAt).getTime() - Date.now()) + 250;
          timers.set(
            challengeId,
            setTimeout(async () => {
              timers.delete(challengeId);
              const latest = await getChallengeStatus(pool, config, challengeId).catch(() => null);
              if (latest?.status === ChallengeStatus.EXPIRED) {
                socket.emit(SocketEvents.LOGIN_EXPIRED, { challengeId });
              }
            }, delay),
          );
        } else {
          timers.set(challengeId, null);
        }
      } catch (error) {
        console.error(`[realtime] watch failed: ${error.message}`);
        reply({ ok: false, error: 'internal_error' });
      }
    });

    try {
      const token = parseCookieHeader(socket.handshake.headers.cookie)[sessionCookieName(config)];
      const session = token && (await authenticateSession(pool, config, token));
      if (session) socket.join(sessionRoom(session.sessionId));
    } catch (error) {
      console.error(`[realtime] session lookup failed: ${error.message}`);
    }
  });

  notifier.attach(io);
  return io;
}

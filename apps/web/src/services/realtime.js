import { io } from 'socket.io-client';
import { SocketEvents } from '@capstone/protocol';

/**
 * Real-time connection to the API (Socket.IO over the same origin).
 *
 * watchChallenge() subscribes to one login challenge. After every (re)connect it subscribes
 * again and reports the status from the acknowledgement, so an approval that arrived while the
 * connection was down is not missed.
 *
 * A new socket is opened for each use so the handshake carries the current cookies (the session
 * cookie, once signed in, is what lets the server send session:revoked to this browser).
 */
export function openRealtime() {
  const socket = io({
    path: '/socket.io',
    withCredentials: true,
    transports: ['websocket', 'polling'],
  });
  return {
    socket,
    close: () => socket.close(),
  };
}

/**
 * @param handlers {
 *   onStatus(status)        status from a (re)subscription ack: pending|approved|denied|consumed|expired
 *   onApproved(), onDenied(), onExpired()
 *   onConnectionChange(connected)
 *   onError(code)           subscription refused (e.g. invalid_watch_token)
 * }
 * Returns a function that stops watching.
 */
export function watchChallenge(realtime, { challengeId, watchToken }, handlers) {
  const { socket } = realtime;

  const subscribe = async () => {
    try {
      const ack = await socket
        .timeout(5000)
        .emitWithAck(SocketEvents.WATCH_LOGIN, { challengeId, watchToken });
      if (ack?.ok) handlers.onStatus(ack.status);
      else handlers.onError(ack?.error ?? 'watch_failed');
    } catch {
      // Ack timed out; the HTTP fallback in the hook keeps the page correct.
    }
  };

  const onConnect = () => {
    handlers.onConnectionChange(true);
    subscribe();
  };
  const onDisconnect = () => handlers.onConnectionChange(false);
  const onConnectError = () => handlers.onConnectionChange(false);
  const matches = (payload) => payload?.challengeId === challengeId;
  const onApproved = (payload) => matches(payload) && handlers.onApproved();
  const onDenied = (payload) => matches(payload) && handlers.onDenied();
  const onExpired = (payload) => matches(payload) && handlers.onExpired();

  socket.on('connect', onConnect);
  socket.on('disconnect', onDisconnect);
  socket.on('connect_error', onConnectError);
  socket.on(SocketEvents.LOGIN_APPROVED, onApproved);
  socket.on(SocketEvents.LOGIN_DENIED, onDenied);
  socket.on(SocketEvents.LOGIN_EXPIRED, onExpired);
  if (socket.connected) onConnect();

  return () => {
    socket.off('connect', onConnect);
    socket.off('disconnect', onDisconnect);
    socket.off('connect_error', onConnectError);
    socket.off(SocketEvents.LOGIN_APPROVED, onApproved);
    socket.off(SocketEvents.LOGIN_DENIED, onDenied);
    socket.off(SocketEvents.LOGIN_EXPIRED, onExpired);
  };
}

/** Calls onRevoked when the phone signs this browser's session out. Returns an unsubscribe. */
export function watchSessionRevocation(realtime, onRevoked) {
  realtime.socket.on(SocketEvents.SESSION_REVOKED, onRevoked);
  return () => realtime.socket.off(SocketEvents.SESSION_REVOKED, onRevoked);
}

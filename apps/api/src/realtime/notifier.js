import { SocketEvents } from '@capstone/protocol';

export const loginRoom = (challengeId) => `login:${challengeId}`;
export const sessionRoom = (sessionId) => `session:${sessionId}`;

/**
 * Pushes events to exactly the sockets entitled to them. Services call this after their
 * transaction commits. Created before Socket.IO exists; attach() wires it up.
 * Event payloads carry identifiers only, never secrets.
 */
export function createNotifier() {
  let io = null;
  return {
    attach(server) {
      io = server;
    },
    loginDecided(challengeId, decision) {
      const event =
        decision === 'approved' ? SocketEvents.LOGIN_APPROVED : SocketEvents.LOGIN_DENIED;
      io?.to(loginRoom(challengeId)).emit(event, { challengeId });
    },
    sessionsRevoked(sessionIds) {
      for (const sessionId of sessionIds) {
        io?.to(sessionRoom(sessionId)).emit(SocketEvents.SESSION_REVOKED, { sessionId });
      }
    },
  };
}

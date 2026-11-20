import { useCallback, useEffect, useRef, useState } from 'react';
import { completeLogin, createLoginChallenge, getChallengeStatus } from '../services/auth';
import { openRealtime, watchChallenge } from '../services/realtime';
import { describeError } from '../services/messages';

export const EXPIRY_WARNING_SECONDS = 10;
const POLL_INTERVAL_MS = 3000;

/**
 * QR login state machine.
 *
 *   requesting ─► waiting ─► completing ─► (onSignedIn)
 *                   │  ├──► denied
 *                   │  ├──► expired
 *                   │  └──► cancelled (user)
 *                   └─────► failed (network / server error)
 *
 * Sign-in is reported only after the API has issued the session cookie (completeLogin
 * resolved). Approval events alone never mark the browser as signed in.
 *
 * Every attempt gets a generation number; callbacks from an older attempt (a previous QR code)
 * are ignored, so a late event cannot affect a newer code.
 */
export function useQrLogin({ onSignedIn }) {
  const [state, setState] = useState({ phase: 'requesting' });
  const [connected, setConnected] = useState(true);
  const [secondsLeft, setSecondsLeft] = useState(null);

  const generation = useRef(0);
  const phase = useRef('requesting');
  const realtime = useRef(null);
  const unwatch = useRef(null);
  const onSignedInRef = useRef(onSignedIn);
  onSignedInRef.current = onSignedIn;

  const stopWatching = useCallback(() => {
    unwatch.current?.();
    unwatch.current = null;
    realtime.current?.close();
    realtime.current = null;
  }, []);

  const transition = useCallback((gen, next) => {
    if (gen !== generation.current) return false;
    phase.current = next.phase;
    setState(next);
    return true;
  }, []);

  const finish = useCallback(
    (gen, next) => {
      if (gen !== generation.current) return;
      stopWatching();
      transition(gen, next);
    },
    [stopWatching, transition],
  );

  const complete = useCallback(
    async (gen, challenge) => {
      // Only one completion attempt per challenge, whichever signal (event, ack, poll) arrives first.
      if (gen !== generation.current || phase.current !== 'waiting') return;
      transition(gen, { phase: 'completing', challenge });
      try {
        const result = await completeLogin(challenge.challengeId);
        if (gen !== generation.current) return;
        stopWatching();
        onSignedInRef.current(result);
      } catch (error) {
        finish(gen, { phase: 'failed', reason: describeError(error) });
      }
    },
    [finish, stopWatching, transition],
  );

  const applyStatus = useCallback(
    (gen, challenge, status) => {
      if (gen !== generation.current || phase.current !== 'waiting') return;
      if (status === 'approved') complete(gen, challenge);
      else if (status === 'denied') finish(gen, { phase: 'denied' });
      else if (status === 'expired') finish(gen, { phase: 'expired' });
      else if (status === 'consumed') {
        finish(gen, {
          phase: 'failed',
          reason: 'This QR code has already been used. Get a new one.',
        });
      }
    },
    [complete, finish],
  );

  const start = useCallback(async () => {
    const gen = ++generation.current;
    stopWatching();
    transition(gen, { phase: 'requesting' });
    setConnected(true);

    let challenge;
    try {
      challenge = await createLoginChallenge();
    } catch (error) {
      transition(gen, { phase: 'failed', reason: describeError(error) });
      return;
    }
    if (!transition(gen, { phase: 'waiting', challenge })) return;

    realtime.current = openRealtime();
    unwatch.current = watchChallenge(realtime.current, challenge, {
      onStatus: (status) => applyStatus(gen, challenge, status),
      onApproved: () => complete(gen, challenge),
      onDenied: () => finish(gen, { phase: 'denied' }),
      onExpired: () => finish(gen, { phase: 'expired' }),
      onConnectionChange: (isConnected) => gen === generation.current && setConnected(isConnected),
      onError: () => gen === generation.current && setConnected(false),
    });
  }, [applyStatus, complete, finish, stopWatching, transition]);

  const cancel = useCallback(() => {
    if (phase.current === 'waiting') finish(generation.current, { phase: 'cancelled' });
  }, [finish]);

  // Start on mount; stop everything on unmount.
  useEffect(() => {
    start();
    return () => {
      generation.current += 1;
      stopWatching();
    };
  }, [start, stopWatching]);

  // Countdown. At zero, ask the server once before declaring expiry, in case an approval landed
  // in the last moment.
  useEffect(() => {
    if (state.phase !== 'waiting') {
      setSecondsLeft(null);
      return undefined;
    }
    const gen = generation.current;
    const { challenge } = state;
    let finalCheckDone = false;
    const tick = async () => {
      // Clamped to the code's lifetime: the Date header has 1 s resolution, which could show "61 s".
      const left = Math.min(
        challenge.lifetimeSeconds,
        Math.max(0, Math.ceil((challenge.deadline - Date.now()) / 1000)),
      );
      setSecondsLeft(left);
      if (left === 0 && !finalCheckDone) {
        finalCheckDone = true;
        try {
          const status = await getChallengeStatus(challenge.challengeId);
          applyStatus(gen, challenge, status === 'pending' ? 'expired' : status);
        } catch {
          finish(gen, { phase: 'expired' });
        }
      }
    };
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [state, applyStatus, finish]);

  // HTTP fallback: poll while the real-time connection is down, and whenever the tab becomes
  // visible again (timers may have been throttled in the background).
  useEffect(() => {
    if (state.phase !== 'waiting') return undefined;
    const gen = generation.current;
    const { challenge } = state;
    const check = () =>
      getChallengeStatus(challenge.challengeId)
        .then((status) => applyStatus(gen, challenge, status))
        .catch(() => {});
    const timer = connected ? null : setInterval(check, POLL_INTERVAL_MS);
    const onVisible = () => document.visibilityState === 'visible' && check();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      if (timer) clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [state, connected, applyStatus]);

  return { state, connected, secondsLeft, start, cancel };
}

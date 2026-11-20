import { useEffect, useState } from 'react';
import { signOut } from '../services/auth';
import { openRealtime, watchSessionRevocation } from '../services/realtime';
import { describeError } from '../services/messages';

/**
 * Shown only after the API confirmed the session (GET /api/session or a completed login).
 * Listens for session:revoked so a sign-out from the phone takes effect here immediately.
 */
export default function SignedIn({ user, session, onSignedOut }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    const realtime = openRealtime(); // handshake carries the new session cookie
    const stop = watchSessionRevocation(realtime, ({ sessionId }) => {
      if (sessionId === session.id) onSignedOut('revoked');
    });
    return () => {
      stop();
      realtime.close();
    };
  }, [session.id, onSignedOut]);

  async function handleSignOut() {
    setBusy(true);
    setError(null);
    try {
      await signOut();
      onSignedOut('signed_out');
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  }

  return (
    <section className="panel signed-in" aria-labelledby="signed-in-heading">
      <h2 id="signed-in-heading">You&apos;re signed in</h2>
      <p>
        Signed in as <strong>{user.displayName || user.email}</strong>
        {user.displayName ? <> ({user.email})</> : null}, approved with your trusted phone.
      </p>
      <dl className="facts">
        <dt>Session ends</dt>
        <dd>{new Date(session.expiresAt).toLocaleString()}</dd>
      </dl>
      <p className="hint">
        On a shared computer, sign out when you&apos;re done. You can also sign this browser out
        from your phone under “Signed-in browsers”.
      </p>
      {error ? (
        <p className="outcome outcome-danger" role="alert">
          {error}
        </p>
      ) : null}
      <button type="button" className="button" onClick={handleSignOut} disabled={busy}>
        {busy ? 'Signing out…' : 'Sign out'}
      </button>
    </section>
  );
}

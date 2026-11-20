import { useCallback, useEffect, useState } from 'react';
import QrLogin from './components/QrLogin';
import SignedIn from './components/SignedIn';
import { getCurrentSession } from './services/auth';
import { describeError } from './services/messages';

const NOTICES = {
  revoked: 'This browser was signed out from your phone.',
  signed_out: 'You have signed out.',
};

export default function App() {
  const [view, setView] = useState({ name: 'loading' });
  const [notice, setNotice] = useState(null);

  const checkSession = useCallback(async () => {
    setView({ name: 'loading' });
    try {
      const current = await getCurrentSession();
      setView(current ? { name: 'signedIn', ...current } : { name: 'signedOut' });
    } catch (error) {
      setView({ name: 'error', message: describeError(error) });
    }
  }, []);

  useEffect(() => {
    checkSession();
  }, [checkSession]);

  const handleSignedIn = useCallback(({ user, session }) => {
    setNotice(null);
    setView({ name: 'signedIn', user, session });
  }, []);

  const handleSignedOut = useCallback((reason) => {
    setNotice(NOTICES[reason] ?? null);
    setView({ name: 'signedOut' });
  }, []);

  return (
    <main className="page">
      <header>
        <h1>Sign in with your phone</h1>
        {view.name === 'signedOut' && (
          <p className="lead">
            Scan the code with your trusted phone to sign in here, without typing your password on
            this computer.
          </p>
        )}
      </header>

      {notice ? (
        <p className="outcome outcome-info" role="status">
          {notice}
        </p>
      ) : null}

      {view.name === 'loading' && (
        <div className="panel spinner-row" role="status">
          <span className="spinner" aria-hidden="true" /> Checking your session…
        </div>
      )}

      {view.name === 'error' && (
        <section className="panel outcome outcome-danger" role="alert">
          <h2>Can&apos;t reach the sign-in service</h2>
          <p>{view.message}</p>
          <button type="button" className="button" onClick={checkSession}>
            Try again
          </button>
        </section>
      )}

      {view.name === 'signedOut' && (
        <QrLogin onSignedIn={handleSignedIn} onNewAttempt={() => setNotice(null)} />
      )}

      {view.name === 'signedIn' && (
        <SignedIn user={view.user} session={view.session} onSignedOut={handleSignedOut} />
      )}

      <footer className="footer">
        No password is entered on this computer. Your phone&apos;s private key never leaves the
        phone.
      </footer>
    </main>
  );
}

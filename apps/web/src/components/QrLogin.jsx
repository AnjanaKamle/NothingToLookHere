import { QRCodeSVG } from 'qrcode.react';
import { EXPIRY_WARNING_SECONDS, useQrLogin } from '../hooks/useQrLogin';

/**
 * QR sign-in panel. The QR code encodes only "capstone-auth:v1:<challengeId>.<nonce>": a
 * one-time value that expires in about a minute. It contains no password, token or cookie.
 */
export default function QrLogin({ onSignedIn, onNewAttempt }) {
  const { state, connected, secondsLeft, start: startLogin, cancel } = useQrLogin({ onSignedIn });
  const start = () => {
    onNewAttempt?.();
    startLogin();
  };
  const { phase } = state;

  return (
    <section className="panel" aria-labelledby="qr-heading">
      <h2 id="qr-heading" className="visually-hidden">
        Sign in with your phone
      </h2>
      <p className="visually-hidden" aria-live="polite">
        {announcement(phase, secondsLeft)}
      </p>

      {phase === 'requesting' && <Spinner label="Preparing a sign-in code…" />}

      {phase === 'waiting' && (
        <Waiting
          challenge={state.challenge}
          secondsLeft={secondsLeft}
          connected={connected}
          onCancel={cancel}
        />
      )}

      {phase === 'completing' && <Spinner label="Approved on your phone. Finishing sign-in…" />}

      {phase === 'denied' && (
        <Outcome tone="danger" title="Sign-in rejected" onRetry={start}>
          The request was rejected on your phone. If that wasn&apos;t you, no action is needed:
          nobody was signed in.
        </Outcome>
      )}

      {phase === 'expired' && (
        <Outcome tone="warning" title="This QR code has expired" onRetry={start}>
          For your security, each code works only once and only for about a minute. It can no longer
          be used. Get a new code to try again.
        </Outcome>
      )}

      {phase === 'cancelled' && (
        <Outcome tone="info" title="Sign-in cancelled" onRetry={start}>
          You cancelled this sign-in. The code will expire on its own and cannot be used to sign in
          this browser.
        </Outcome>
      )}

      {phase === 'failed' && (
        <Outcome tone="danger" title="Sign-in didn't work" onRetry={start} retryLabel="Try again">
          {state.reason}
        </Outcome>
      )}
    </section>
  );
}

function Waiting({ challenge, secondsLeft, connected, onCancel }) {
  const total = challenge.lifetimeSeconds;
  const expiringSoon = secondsLeft !== null && secondsLeft <= EXPIRY_WARNING_SECONDS;
  return (
    <>
      <ol className="steps">
        <li>Open the trusted-phone app on your phone.</li>
        <li>Tap “Scan sign-in QR code” and point it at this code.</li>
        <li>Check the request details on your phone, then approve.</li>
      </ol>

      <div
        className="qr"
        role="img"
        aria-label="Sign-in QR code. Scan it with your trusted phone app."
      >
        <QRCodeSVG value={challenge.qrPayload} size={232} level="M" marginSize={2} />
      </div>

      <div className={`countdown ${expiringSoon ? 'countdown-warning' : ''}`}>
        <progress max={total} value={secondsLeft ?? total} aria-label="Time left for this code" />
        <span>
          {expiringSoon ? 'Expiring soon: ' : 'Expires in '}
          <strong>{secondsLeft ?? '…'}</strong> s
        </span>
      </div>

      <p className="status-line" role="status">
        {connected ? (
          <>
            <span className="dot dot-live" aria-hidden="true" /> Waiting for approval on your phone…
          </>
        ) : (
          <>
            <span className="dot dot-offline" aria-hidden="true" /> Connection lost. Reconnecting…
            (still checking in the background)
          </>
        )}
      </p>

      <p className="hint">
        Only scan this with <strong>your own</strong> trusted phone. Your phone shows this
        browser&apos;s details before you approve. If someone asks you to scan a code for them,
        don&apos;t.
      </p>

      <button type="button" className="button secondary" onClick={onCancel}>
        Cancel
      </button>
    </>
  );
}

function Outcome({ tone, title, children, onRetry, retryLabel = 'Get a new QR code' }) {
  return (
    <div className={`outcome outcome-${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <h3>{title}</h3>
      <p>{children}</p>
      <button type="button" className="button" onClick={onRetry} autoFocus>
        {retryLabel}
      </button>
    </div>
  );
}

function Spinner({ label }) {
  return (
    <div className="spinner-row" role="status">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

function announcement(phase, secondsLeft) {
  if (phase === 'waiting' && secondsLeft === EXPIRY_WARNING_SECONDS) {
    return `The QR code expires in ${EXPIRY_WARNING_SECONDS} seconds.`;
  }
  return '';
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { inspectChallenge, submitDecision } from '../services/api';
import { DeviceKeyErrors, signLoginDecision } from '../services/deviceKey';
import { rotateThisPhoneKey } from '../services/enrollment';
import { useEnrollment } from '../state/EnrollmentContext';
import { describeError, isEnrollmentLost } from '../utils/messages';
import { describeUserAgent, formatDateTime } from '../utils/userAgent';
import { Banner, Body, Button, Card, LoadingView, Row, Screen, Title } from '../ui/components';

/**
 * Shows who is asking to sign in, and signs the user's decision for exactly this challenge.
 * States: loading → ready → signing → done | error. The result shown is the server's answer;
 * nothing is presented as approved until the server accepted the signed decision.
 */
export default function ApproveScreen({ route, navigation }) {
  const { challengeId, nonce } = route.params;
  const { enrollment, setEnrollment, forgetThisPhone } = useEnrollment();
  const [state, setState] = useState({ phase: 'loading' });
  const [secondsLeft, setSecondsLeft] = useState(null);
  const clockOffset = useRef(0);

  const load = useCallback(async () => {
    setState({ phase: 'loading' });
    try {
      const details = await inspectChallenge(enrollment.deviceToken, challengeId, nonce);
      clockOffset.current = details.serverTime - Date.now();
      setState({ phase: 'ready', details });
    } catch (error) {
      setState({ phase: 'error', error });
    }
  }, [challengeId, nonce, enrollment.deviceToken]);

  useEffect(() => {
    load();
  }, [load]);

  // Countdown to the challenge's expiry, using the server's clock.
  useEffect(() => {
    if (state.phase !== 'ready' && state.phase !== 'signing') return undefined;
    const expiresAt = Date.parse(state.details.expiresAt);
    const tick = () => {
      const left = Math.max(0, Math.ceil((expiresAt - (Date.now() + clockOffset.current)) / 1000));
      setSecondsLeft(left);
    };
    tick();
    const timer = setInterval(tick, 500);
    return () => clearInterval(timer);
  }, [state]);

  async function decide(decision) {
    const { details } = state;
    setState({ phase: 'signing', details, decision });
    try {
      const signature = await signLoginDecision({
        audience: enrollment.audience,
        challengeId,
        nonce,
        keyId: enrollment.keyId,
        decision,
      });
      const result = await submitDecision(enrollment.deviceToken, challengeId, {
        nonce,
        keyId: enrollment.keyId,
        decision,
        signature,
      });
      setState({ phase: 'done', status: result.status });
    } catch (error) {
      if (error?.code === DeviceKeyErrors.USER_CANCELLED) {
        setState({ phase: 'ready', details, notice: describeError(error) });
      } else {
        setState({ phase: 'error', error });
      }
    }
  }

  async function createNewKey() {
    setState({ phase: 'loading' });
    try {
      setEnrollment(await rotateThisPhoneKey(enrollment));
      await load();
    } catch (error) {
      setState({ phase: 'error', error });
    }
  }

  if (state.phase === 'loading') return <LoadingView label="Checking the sign-in request…" />;

  if (state.phase === 'error') {
    const { error } = state;
    return (
      <Screen>
        <Title>Request not approved</Title>
        <Banner tone="danger">{describeError(error)}</Banner>
        {error?.code === DeviceKeyErrors.KEY_INVALIDATED ? (
          <Button title="Create a new key for this phone" onPress={createNewKey} />
        ) : null}
        {isEnrollmentLost(error) ? (
          <Button title="Set up this phone again" variant="danger" onPress={forgetThisPhone} />
        ) : null}
        <Button
          title="Scan another code"
          variant="secondary"
          onPress={() => navigation.replace('Scan')}
        />
        <Button title="Back to home" variant="secondary" onPress={() => navigation.popToTop()} />
      </Screen>
    );
  }

  if (state.phase === 'done') {
    const approved = state.status === 'approved';
    return (
      <Screen>
        <Title>{approved ? 'Approved' : 'Rejected'}</Title>
        <Banner tone={approved ? 'success' : 'info'}>
          {approved
            ? 'The server accepted your approval. The browser will now finish signing in. If it does not, it may have closed or expired. You can check under "Signed-in browsers".'
            : 'The server recorded your rejection. That browser will not be signed in.'}
        </Banner>
        <Button title="Done" onPress={() => navigation.popToTop()} />
      </Screen>
    );
  }

  const { details } = state;
  const expired = secondsLeft === 0;
  return (
    <Screen>
      <Title>Sign in on another device?</Title>
      <Body>Only approve if you are signing in right now and recognise this request.</Body>

      <Card>
        <Row label="Browser" value={describeUserAgent(details.requester.userAgent)} />
        <Row label="IP address" value={details.requester.ip ?? 'Unknown'} />
        <Row label="Requested" value={formatDateTime(details.createdAt)} />
        <Row label="Expires in" value={expired ? 'Expired' : `${secondsLeft ?? '…'} s`} />
      </Card>

      <Banner tone="warning" title="Did someone send you this code?">
        Never scan a QR code that someone else gave you or showed you. Approving it would sign them
        in to your account.
      </Banner>
      {state.notice ? <Banner tone="info">{state.notice}</Banner> : null}
      {expired ? (
        <Banner tone="danger">This request expired. Ask the browser for a new QR code.</Banner>
      ) : null}

      <Button
        title="Approve sign-in"
        onPress={() => decide('approved')}
        busy={state.phase === 'signing' && state.decision === 'approved'}
        disabled={expired || state.phase === 'signing'}
        accessibilityHint="Asks for Face ID, fingerprint or passcode, then signs this request"
      />
      <Button
        title="Reject"
        variant="secondary"
        onPress={() => decide('denied')}
        busy={state.phase === 'signing' && state.decision === 'denied'}
        disabled={expired || state.phase === 'signing'}
      />
    </Screen>
  );
}

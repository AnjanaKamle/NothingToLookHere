import { useCallback, useState } from 'react';
import { Alert, Platform } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { regenerateRecoveryCodes, remainingRecoveryCodes } from '../services/api';
import { useEnrollment } from '../state/EnrollmentContext';
import { describeError } from '../utils/messages';
import { Banner, Body, Button, Card, Screen, Title } from '../ui/components';

/** Recovery guidance, remaining code count, and code regeneration (codes shown once). */
export default function RecoveryScreen() {
  const { enrollment } = useEnrollment();
  const [remaining, setRemaining] = useState(null);
  const [codes, setCodes] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useFocusEffect(
    useCallback(() => {
      remainingRecoveryCodes(enrollment.deviceToken)
        .then(setRemaining)
        .catch((e) => setError(describeError(e)));
    }, [enrollment.deviceToken]),
  );

  function confirmRegenerate() {
    Alert.alert(
      'Create new recovery codes?',
      'Your current recovery codes will stop working. Have pen and paper ready: the new codes are shown only once.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Create new codes', onPress: regenerate },
      ],
    );
  }

  async function regenerate() {
    setBusy(true);
    setError(null);
    try {
      const fresh = await regenerateRecoveryCodes(enrollment.deviceToken);
      setCodes(fresh);
      setRemaining(fresh.length);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Title>Recovery</Title>
      {error ? <Banner tone="danger">{error}</Banner> : null}

      {codes ? (
        <Card>
          <Body style={{ fontWeight: '700' }}>Your new recovery codes</Body>
          <Body muted>
            Write these down and keep them somewhere safe, away from this phone. Each works once.
          </Body>
          {codes.map((code) => (
            <Body
              key={code}
              style={{
                fontFamily: Platform.select({ ios: 'Courier', default: 'monospace' }),
                fontSize: 18,
              }}
            >
              {code}
            </Body>
          ))}
          <Button title="I have saved them" onPress={() => setCodes(null)} />
        </Card>
      ) : (
        <Card>
          <Body>
            Unused recovery codes: <Body style={{ fontWeight: '700' }}>{remaining ?? '…'}</Body>
          </Body>
          {remaining === 0 ? (
            <Banner tone="warning">You have no recovery codes. Create new ones now.</Banner>
          ) : null}
          <Button
            title="Create new recovery codes"
            variant="secondary"
            busy={busy}
            onPress={confirmRegenerate}
          />
        </Card>
      )}

      <Title>If you lose this phone</Title>
      <Body>
        If you have another trusted phone, open “Trusted phones” on it and revoke the lost one. This
        signs out every browser it approved.
      </Body>
      <Body>
        If this was your only trusted phone, install the app on a new phone and choose “I lost my
        trusted phone”. You will need your password and one recovery code. Recovery signs out every
        phone and browser on your account.
      </Body>
      <Body muted>
        A thief cannot use this phone to sign in as you without unlocking it: every approval needs
        Face ID, fingerprint or your passcode.
      </Body>
    </Screen>
  );
}

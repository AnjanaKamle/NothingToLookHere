import { useState } from 'react';
import { Platform } from 'react-native';
import { defaultDeviceName, enrollThisPhone } from '../services/enrollment';
import { useEnrollment } from '../state/EnrollmentContext';
import { describeError } from '../utils/messages';
import { Banner, Body, Button, Card, Field, Screen, Title } from '../ui/components';

/**
 * Creates the device key in secure hardware and registers its public key.
 * Reached after password sign-in or account recovery (route params carry the one-time challenge).
 */
export default function EnrollScreen({ route }) {
  const { challenge, source, revoked } = route.params;
  const { setEnrollment } = useEnrollment();
  const [deviceName, setDeviceName] = useState(defaultDeviceName());
  const [step, setStep] = useState('idle'); // idle | working
  const [error, setError] = useState(null);

  async function enroll() {
    setStep('working');
    setError(null);
    try {
      const enrollment = await enrollThisPhone(challenge, deviceName.trim() || defaultDeviceName());
      // Switching to the enrolled navigator only happens after the server confirmed enrollment.
      setEnrollment(enrollment);
    } catch (e) {
      setError(describeError(e));
      setStep('idle');
    }
  }

  const hardware = Platform.OS === 'ios' ? 'Secure Enclave' : 'Android Keystore (secure hardware)';

  return (
    <Screen>
      <Title>Create this phone&apos;s secure key</Title>
      {source === 'recovery' && revoked ? (
        <Banner tone="success" title="Account recovered">
          Signed out {revoked.devices} trusted phone(s) and {revoked.sessions} browser session(s).
          Finish setting up this phone below.
        </Banner>
      ) : null}

      <Card>
        <Body>
          This phone will create a key pair inside its {hardware}. The private key cannot be copied
          off the phone, not even by this app. Only the public key is sent to the server.
        </Body>
        <Body muted>
          You will be asked for Face ID, fingerprint or your passcode every time the key is used,
          including now to prove the key is real.
        </Body>
      </Card>

      {error ? <Banner tone="danger">{error}</Banner> : null}

      <Field
        label="Name for this phone"
        value={deviceName}
        onChangeText={setDeviceName}
        maxLength={64}
      />
      <Button
        title="Create key and register phone"
        onPress={enroll}
        busy={step === 'working'}
        accessibilityHint="Creates a key in secure hardware and asks you to confirm with biometrics or passcode"
      />
      <Body muted>
        This registration request expires in a few minutes. If it does, sign in again.
      </Body>
    </Screen>
  );
}

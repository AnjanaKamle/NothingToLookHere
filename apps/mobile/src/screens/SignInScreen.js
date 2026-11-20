import { useState } from 'react';
import { API_URL } from '../config';
import { passwordLogin } from '../services/api';
import { isDeviceKeyModuleAvailable } from '../services/deviceKey';
import { describeError } from '../utils/messages';
import { Banner, Body, Button, Field, Screen, Title } from '../ui/components';

/** Initial account sign-in. The password only starts enrollment; it never signs in a browser. */
export default function SignInScreen({ navigation }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const moduleAvailable = isDeviceKeyModuleAvailable();

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const challenge = await passwordLogin(email.trim(), password);
      setPassword('');
      navigation.navigate('Enroll', { challenge, source: 'signin' });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Title>Set up this phone</Title>
      <Body muted>
        Sign in once with your account password. This phone then creates a secure key that lets you
        approve browser sign-ins without typing your password on other computers.
      </Body>

      {!moduleAvailable ? (
        <Banner tone="danger" title="Secure key support missing">
          This build cannot create hardware-protected keys (for example, it is running in Expo Go).
          Install the development build to continue.
        </Banner>
      ) : null}
      {!API_URL ? (
        <Banner tone="danger" title="Server not configured">
          Set EXPO_PUBLIC_API_URL in apps/mobile/.env and restart the bundler.
        </Banner>
      ) : null}
      {error ? <Banner tone="danger">{error}</Banner> : null}

      <Field
        label="Email"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        textContentType="username"
      />
      <Field
        label="Password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoComplete="current-password"
        textContentType="password"
      />
      <Button
        title="Continue"
        onPress={submit}
        busy={busy}
        disabled={!email || !password || !moduleAvailable || !API_URL}
      />
      <Button
        title="I lost my trusted phone"
        variant="secondary"
        onPress={() => navigation.navigate('Recover')}
      />
    </Screen>
  );
}

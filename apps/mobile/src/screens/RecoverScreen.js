import { useState } from 'react';
import { recoverAccount } from '../services/api';
import { isDeviceKeyModuleAvailable } from '../services/deviceKey';
import { describeError } from '../utils/messages';
import { Banner, Body, Button, Field, Screen, Title } from '../ui/components';

/** Lost-phone recovery: password + one recovery code (docs/RECOVERY.md). */
export default function RecoverScreen({ navigation }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const result = await recoverAccount({
        email: email.trim(),
        password,
        recoveryCode: code,
        ...(newPassword && { newPassword }),
      });
      setPassword('');
      setCode('');
      setNewPassword('');
      navigation.replace('Enroll', {
        challenge: result.enrollment,
        source: 'recovery',
        revoked: result.revoked,
      });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Title>Recover your account</Title>
      <Body muted>
        Use this if you no longer have any trusted phone. You need your password and one of the
        recovery codes you saved when the account was created.
      </Body>
      <Banner tone="warning" title="What recovery does">
        Every trusted phone and every signed-in browser on your account will be signed out
        immediately, including the lost phone. This phone then becomes your trusted phone.
      </Banner>
      {error ? <Banner tone="danger">{error}</Banner> : null}

      <Field
        label="Email"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        keyboardType="email-address"
      />
      <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry />
      <Field
        label="Recovery code"
        value={code}
        onChangeText={setCode}
        autoCapitalize="characters"
        autoCorrect={false}
        placeholder="XXXX-XXXX-XXXX"
      />
      <Field
        label="New password (optional, at least 12 characters)"
        value={newPassword}
        onChangeText={setNewPassword}
        secureTextEntry
        autoComplete="new-password"
      />
      <Body muted>Change your password too if you think someone else may know it.</Body>
      <Button
        title="Recover and set up this phone"
        onPress={submit}
        busy={busy}
        disabled={!email || !password || !code || !isDeviceKeyModuleAvailable()}
      />
    </Screen>
  );
}

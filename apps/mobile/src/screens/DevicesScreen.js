import { useCallback, useState } from 'react';
import { Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { listDevices, revokeDevice } from '../services/api';
import { useEnrollment } from '../state/EnrollmentContext';
import { describeError } from '../utils/messages';
import { formatDateTime } from '../utils/userAgent';
import { Banner, Body, Button, Card, LoadingView, Row, Screen, Title } from '../ui/components';

/** Trusted phones on the account. Revoke a lost phone, or remove this one. */
export default function DevicesScreen() {
  const { enrollment, forgetThisPhone } = useEnrollment();
  const [devices, setDevices] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setDevices(await listDevices(enrollment.deviceToken));
    } catch (e) {
      setError(describeError(e));
    }
  }, [enrollment.deviceToken]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  function confirm(device) {
    const self = device.current;
    Alert.alert(
      self ? 'Remove this phone?' : `Revoke ${device.name}?`,
      self
        ? 'This phone will stop being trusted, its key will be deleted, and every browser it signed in will be signed out.'
        : 'That phone will stop being trusted and every browser it signed in will be signed out. Use this if it was lost or stolen.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: self ? 'Remove' : 'Revoke', style: 'destructive', onPress: () => revoke(device) },
      ],
    );
  }

  async function revoke(device) {
    setBusy(device.id);
    try {
      await revokeDevice(enrollment.deviceToken, device.id, device.current ? 'user' : 'lost');
      if (device.current) {
        await forgetThisPhone();
        return;
      }
      await load();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Screen>
      <Title>Trusted phones</Title>
      <Body muted>Any trusted phone can approve sign-ins for your account.</Body>
      {error ? (
        <>
          <Banner tone="danger">{error}</Banner>
          <Button title="Try again" variant="secondary" onPress={load} />
        </>
      ) : null}
      {devices === null && !error ? <LoadingView label="Loading phones…" /> : null}
      {devices?.map((device) => (
        <Card key={device.id}>
          <Body style={{ fontWeight: '700' }}>
            {device.name}
            {device.current ? ' (this phone)' : ''}
          </Body>
          <Row label="Platform" value={device.platform === 'ios' ? 'iPhone' : 'Android'} />
          <Row label="Enrolled" value={formatDateTime(device.createdAt)} />
          <Row label="Last used" value={formatDateTime(device.lastUsedAt)} />
          <Button
            title={device.current ? 'Remove this phone' : 'Revoke'}
            variant="danger"
            busy={busy === device.id}
            onPress={() => confirm(device)}
          />
        </Card>
      ))}
    </Screen>
  );
}

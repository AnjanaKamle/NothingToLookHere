import { useEnrollment } from '../state/EnrollmentContext';
import { Banner, Body, Button, Card, Row, Screen, Title } from '../ui/components';

const KEY_STORAGE_LABELS = {
  secure_enclave: 'Secure Enclave',
  strongbox: 'StrongBox secure chip',
  tee: 'Trusted Execution Environment',
  software: 'Software only (development)',
  unknown: 'Secure hardware (unspecified)',
};

export default function HomeScreen({ navigation }) {
  const { enrollment } = useEnrollment();
  return (
    <Screen>
      <Title>{enrollment.deviceName}</Title>
      <Body muted>
        To sign in on a computer, open the sign-in page there and scan its QR code with this phone.
      </Body>
      <Button title="Scan sign-in QR code" onPress={() => navigation.navigate('Scan')} />

      <Card>
        <Row
          label="Key protected by"
          value={KEY_STORAGE_LABELS[enrollment.keyStorage] ?? 'Secure hardware'}
        />
        <Row label="Key can be exported" value="No" />
      </Card>
      {enrollment.keyStorage === 'software' ? (
        <Banner tone="warning" title="Development key">
          This key is not held in secure hardware. Use a real device for anything beyond testing.
        </Banner>
      ) : null}

      <Button
        title="Signed-in browsers"
        variant="secondary"
        onPress={() => navigation.navigate('Sessions')}
      />
      <Button
        title="Trusted phones"
        variant="secondary"
        onPress={() => navigation.navigate('Devices')}
      />
      <Button
        title="Recovery codes & lost phone"
        variant="secondary"
        onPress={() => navigation.navigate('Recovery')}
      />
    </Screen>
  );
}

import { useCallback, useRef, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useFocusEffect } from '@react-navigation/native';
import { parseQrPayload } from '@capstone/protocol';
import { Banner, Body, Button, LoadingView, Screen, Title } from '../ui/components';
import { spacing } from '../ui/theme';

/**
 * Scans the browser's QR code. Only codes in the exact "capstone-auth:v1:<id>.<nonce>" format
 * are accepted; anything else (URLs, other apps' codes) is rejected without contacting a server.
 */
export default function ScanScreen({ navigation }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [message, setMessage] = useState(null);
  const handled = useRef(false);

  useFocusEffect(
    useCallback(() => {
      handled.current = false;
      setMessage(null);
    }, []),
  );

  const onScanned = useCallback(
    ({ data }) => {
      if (handled.current) return;
      const parsed = parseQrPayload(data);
      if (!parsed) {
        setMessage('That QR code is not a sign-in code from this service.');
        return;
      }
      handled.current = true;
      navigation.replace('Approve', parsed);
    },
    [navigation],
  );

  if (!permission) return <LoadingView label="Checking camera permission…" />;

  if (!permission.granted) {
    return (
      <Screen>
        <Title>Camera access needed</Title>
        <Body>
          The camera is used only to read the sign-in QR code on your computer screen. Nothing is
          recorded.
        </Body>
        {permission.canAskAgain ? (
          <Button title="Allow camera" onPress={requestPermission} />
        ) : (
          <>
            <Banner tone="warning" title="Camera permission is turned off">
              Turn on camera access for this app in Settings, then come back.
            </Banner>
            <Button title="Open Settings" onPress={() => Linking.openSettings()} />
          </>
        )}
      </Screen>
    );
  }

  return (
    <View style={styles.container}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={onScanned}
        accessibilityLabel="Camera viewfinder for scanning the sign-in QR code"
      />
      <View style={styles.overlay} pointerEvents="box-none">
        <Banner tone="info">Point the camera at the QR code shown in your browser.</Banner>
        {message ? <Banner tone="warning">{message}</Banner> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'black' },
  overlay: {
    position: 'absolute',
    left: spacing.md,
    right: spacing.md,
    bottom: spacing.xl,
    gap: spacing.sm,
  },
});

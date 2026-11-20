import { useCallback, useState } from 'react';
import { Alert, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { listSessions, revokeSession } from '../services/api';
import { useEnrollment } from '../state/EnrollmentContext';
import { describeError } from '../utils/messages';
import { describeUserAgent, formatDateTime } from '../utils/userAgent';
import { Banner, Body, Button, Card, LoadingView, Row, Title } from '../ui/components';
import { spacing, useTheme } from '../ui/theme';

/** Lists the account's signed-in browsers and lets the user sign any of them out. */
export default function SessionsScreen() {
  const { enrollment } = useEnrollment();
  const theme = useTheme();
  const [sessions, setSessions] = useState(null);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [revoking, setRevoking] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setSessions(await listSessions(enrollment.deviceToken));
    } catch (e) {
      setError(describeError(e));
    }
  }, [enrollment.deviceToken]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  function confirmRevoke(session) {
    Alert.alert(
      'Sign out this browser?',
      `${describeUserAgent(session.userAgent)} will be signed out immediately.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Sign out', style: 'destructive', onPress: () => revoke(session.id) },
      ],
    );
  }

  async function revoke(sessionId) {
    setRevoking(sessionId);
    try {
      await revokeSession(enrollment.deviceToken, sessionId);
      setSessions((current) => current.filter((s) => s.id !== sessionId));
    } catch (e) {
      setError(describeError(e));
      await load();
    } finally {
      setRevoking(null);
    }
  }

  return (
    <ScrollView
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
    >
      <Title>Signed-in browsers</Title>
      {error ? (
        <>
          <Banner tone="danger">{error}</Banner>
          <Button title="Try again" variant="secondary" onPress={load} />
        </>
      ) : null}
      {sessions === null && !error ? <LoadingView label="Loading sessions…" /> : null}
      {sessions?.length === 0 ? (
        <Banner tone="info" title="No signed-in browsers">
          When you approve a sign-in, that browser appears here so you can sign it out later.
        </Banner>
      ) : null}
      {sessions?.map((session) => (
        <Card key={session.id}>
          <Body style={styles.heading}>{describeUserAgent(session.userAgent)}</Body>
          <Row label="IP address" value={session.ip ?? 'Unknown'} />
          <Row label="Signed in" value={formatDateTime(session.createdAt)} />
          <Row label="Last active" value={formatDateTime(session.lastSeenAt)} />
          <Row label="Approved by" value={session.approvedBy.deviceName} />
          <View style={styles.action}>
            <Button
              title="Sign out"
              variant="danger"
              busy={revoking === session.id}
              onPress={() => confirmRevoke(session)}
            />
          </View>
        </Card>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.md, gap: spacing.md },
  heading: { fontWeight: '700' },
  action: { marginTop: spacing.sm },
});

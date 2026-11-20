import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { spacing, useTheme } from './theme';

export function Screen({ children, scroll = true }) {
  const theme = useTheme();
  const content = <View style={styles.content}>{children}</View>;
  return (
    <SafeAreaView
      edges={['bottom', 'left', 'right']}
      style={[styles.screen, { backgroundColor: theme.background }]}
    >
      {scroll ? <ScrollView keyboardShouldPersistTaps="handled">{content}</ScrollView> : content}
    </SafeAreaView>
  );
}

export function Title({ children }) {
  const theme = useTheme();
  return (
    <Text accessibilityRole="header" style={[styles.title, { color: theme.text }]}>
      {children}
    </Text>
  );
}

export function Body({ children, muted, style }) {
  const theme = useTheme();
  return (
    <Text style={[styles.body, { color: muted ? theme.muted : theme.text }, style]}>
      {children}
    </Text>
  );
}

export function Card({ children }) {
  const theme = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
      {children}
    </View>
  );
}

/** Inline status message. `tone` is info | success | warning | danger. Announced to screen readers. */
export function Banner({ tone = 'info', title, children }) {
  const theme = useTheme();
  const colors = {
    info: [theme.infoSurface, theme.text],
    success: [theme.successSurface, theme.success],
    warning: [theme.warningSurface, theme.warning],
    danger: [theme.dangerSurface, theme.danger],
  }[tone];
  return (
    <View
      accessibilityRole={tone === 'danger' ? 'alert' : 'summary'}
      accessibilityLiveRegion="polite"
      style={[styles.banner, { backgroundColor: colors[0] }]}
    >
      {title ? <Text style={[styles.bannerTitle, { color: colors[1] }]}>{title}</Text> : null}
      {children ? <Text style={[styles.body, { color: theme.text }]}>{children}</Text> : null}
    </View>
  );
}

export function Button({ title, onPress, variant = 'primary', disabled, busy, accessibilityHint }) {
  const theme = useTheme();
  const palette = {
    primary: {
      backgroundColor: theme.primary,
      color: theme.primaryText,
      borderColor: theme.primary,
    },
    secondary: { backgroundColor: 'transparent', color: theme.primary, borderColor: theme.border },
    danger: { backgroundColor: theme.danger, color: theme.surface, borderColor: theme.danger },
  }[variant];
  const inactive = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy: !!busy }}
      accessibilityHint={accessibilityHint}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: palette.backgroundColor, borderColor: palette.borderColor },
        (pressed || inactive) && { opacity: 0.6 },
      ]}
    >
      {busy ? (
        <ActivityIndicator color={palette.color} />
      ) : (
        <Text style={[styles.buttonText, { color: palette.color }]}>{title}</Text>
      )}
    </Pressable>
  );
}

export function Field({ label, ...inputProps }) {
  const theme = useTheme();
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: theme.text }]}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={theme.muted}
        style={[
          styles.input,
          { color: theme.text, borderColor: theme.border, backgroundColor: theme.surface },
        ]}
        {...inputProps}
      />
    </View>
  );
}

export function Row({ label, value }) {
  const theme = useTheme();
  return (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, { color: theme.muted }]}>{label}</Text>
      <Text style={[styles.rowValue, { color: theme.text }]} selectable>
        {value}
      </Text>
    </View>
  );
}

export function LoadingView({ label = 'Loading…' }) {
  const theme = useTheme();
  return (
    <View style={styles.centered} accessibilityLiveRegion="polite">
      <ActivityIndicator color={theme.primary} />
      <Text style={[styles.body, { color: theme.muted, marginTop: spacing.sm }]}>{label}</Text>
    </View>
  );
}

export function Gap({ size = 'md' }) {
  return <View style={{ height: spacing[size] }} />;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: spacing.md, gap: spacing.md },
  title: { fontSize: 24, fontWeight: '700' },
  body: { fontSize: 16, lineHeight: 22 },
  card: { borderWidth: 1, borderRadius: 12, padding: spacing.md, gap: spacing.sm },
  banner: { borderRadius: 10, padding: spacing.md, gap: spacing.xs },
  bannerTitle: { fontSize: 16, fontWeight: '700' },
  button: {
    minHeight: 48,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  buttonText: { fontSize: 16, fontWeight: '600' },
  field: { gap: spacing.xs },
  label: { fontSize: 15, fontWeight: '600' },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: spacing.md,
    fontSize: 16,
  },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md },
  rowLabel: { fontSize: 15 },
  rowValue: { fontSize: 15, fontWeight: '600', flexShrink: 1, textAlign: 'right' },
  centered: { padding: spacing.xl, alignItems: 'center' },
});

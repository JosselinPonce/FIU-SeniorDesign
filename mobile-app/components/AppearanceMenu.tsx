import { Alert, Pressable, Text, View } from 'react-native';
import { useTheme } from '../lib/theme/ThemeProvider';

/** Uses the same native choice-sheet pattern as Switch Driver; no duplicate theme state. */
export function AppearanceMenu() {
  const { tokens, preference, setPreference, error } = useTheme();
  const labels = { light: 'Light', dark: 'Dark', system: 'System' } as const;
  const icons = { light: '☀', dark: '☾', system: '◐' } as const;
  return <View style={{ flexShrink: 1 }}>
    <Pressable accessibilityRole="button" accessibilityLabel={`Appearance: ${labels[preference]}. Change appearance`}
      accessibilityHint="Choose Light, Dark or System" onPress={() => Alert.alert('Appearance', 'Choose the app appearance.', [
        ...(['light', 'dark', 'system'] as const).map(value => ({ text: `${preference === value ? '✓ ' : ''}${labels[value]}`,
          onPress: () => { void setPreference(value); } })),
        { text: 'Cancel', style: 'cancel' as const },
      ])} style={{ minWidth: 44, minHeight: 44, paddingHorizontal: 6, flexDirection: 'row', gap: 3, alignItems: 'center', justifyContent: 'center' }}>
      <Text accessible={false} style={{ color: tokens.text, fontSize: 20 }}>{icons[preference]}</Text>
      <Text accessible={false} style={{ color: tokens.textSecondary, fontSize: 12 }}>⌄</Text>
    </Pressable>
    {error ? <Text accessibilityLiveRegion="polite" style={{ color: tokens.danger, fontSize: 12 }}>{error}</Text> : null}
  </View>;
}

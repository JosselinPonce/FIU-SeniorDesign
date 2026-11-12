import type { ReactNode } from 'react';
import { View } from 'react-native';
import { LocalizedPressable as Pressable, LocalizedText as Text } from '../lib/i18n/native';
import { useTheme } from '../lib/theme/ThemeProvider';
/** Compact persistent navigation only. The owning screen provides its safe-area host. */
export function ScreenHeader({ title, onBack, backLabel = 'Back', right }: {
  title: string; onBack?: () => void; backLabel?: string; right?: ReactNode;
}) {
  const { tokens } = useTheme();
  if (!onBack && !right) return null;
  return <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'space-between', gap: 8,
    paddingHorizontal: 16, backgroundColor: tokens.background }}>
    {onBack ? <Pressable accessibilityRole="button" accessibilityLabel={backLabel} accessibilityHint={`Back from ${title}`} onPress={onBack}
      style={{ minWidth: 48, minHeight: 48, justifyContent: 'center', paddingRight: 12 }}>
      <Text style={{ color: tokens.text, fontSize: 16, fontWeight: '600' }}>‹ {backLabel}</Text>
    </Pressable> : <View style={{ flex: 1 }} />}
    {right}
  </View>;
}
/** Page identity belongs to scroll content, never to the persistent navigation bar. */
export function ScreenHeading({ title, accessory }: { title: string; accessory?: ReactNode }) {
  const { tokens } = useTheme();
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
    <Text accessibilityRole="header" style={{ flexShrink: 1, color: tokens.text, fontSize: 24, fontWeight: '800' }}>{title}</Text>
    {accessory}
  </View>;
}

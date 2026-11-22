import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { LocalizedPressable as Pressable, LocalizedText as Text } from '../lib/i18n/native';
import { useTheme } from '../lib/theme/ThemeProvider';

export function SettingsGroup({ children }: { children: ReactNode }) {
  const { tokens } = useTheme();
  return <View style={{ borderRadius: 14, backgroundColor: tokens.surface }}>{children}</View>;
}

export function SettingsRow({ title, subtitle, trailing, onPress, selected, disabled, divider, tone, expanded, action }: {
  title: string;
  subtitle?: string;
  trailing?: ReactNode;
  onPress?: () => void;
  selected?: boolean;
  disabled?: boolean;
  divider?: boolean;
  tone?: 'danger';
  expanded?: boolean;
  action?: boolean;
}) {
  const { tokens: t } = useTheme();
  const content = <>
    <View style={{ flex: 1, gap: 2 }}>
      <Text style={{ color: disabled ? t.disabledText : tone === 'danger' ? t.danger : t.text, fontSize: 16, fontWeight: '600' }}>{title}</Text>
      {subtitle ? <Text style={{ color: t.textSecondary, fontSize: 13 }}>{subtitle}</Text> : null}
    </View>
    {trailing ?? (onPress && !action ? <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ minWidth: 20, alignItems: 'center' }}>
      <Text style={{ color: selected ? t.heartText : t.textMuted, fontSize: 20 }}>
        {selected !== undefined ? selected ? '✓' : '' : expanded !== undefined ? expanded ? '⌄' : '›' : '›'}
      </Text>
    </View> : null)}
  </>;
  const row = { minHeight: 48, paddingHorizontal: 14, paddingVertical: 8, gap: 10, flexDirection: 'row' as const, alignItems: 'center' as const };
  return <View>
    {divider ? <View style={{ marginHorizontal: 14, height: StyleSheet.hairlineWidth, backgroundColor: t.border }} /> : null}
    {onPress ? <Pressable accessibilityRole={selected === undefined ? 'button' : 'radio'}
      accessibilityState={{ selected, disabled, expanded }} disabled={disabled} onPress={onPress}
      style={({ pressed }) => [row, { borderRadius: 12, backgroundColor: pressed ? t.surfaceMuted : undefined }]}>
      {content}
    </Pressable> : <View style={row}>{content}</View>}
  </View>;
}

export function SettingsNote({ children }: { children: ReactNode }) {
  const { tokens: t } = useTheme();
  return <Text style={{ color: t.textSecondary, fontSize: 14 }}>{children}</Text>;
}

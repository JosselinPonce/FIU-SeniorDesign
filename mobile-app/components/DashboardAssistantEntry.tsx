import { Pressable, View } from 'react-native';
import { useTheme } from '../lib/theme/ThemeProvider';
import type { AssistantMode } from '../lib/assistant/mode';
/** Passive event-only Sensi entry. Never checks or invokes a legacy AI provider. */
export function DashboardAssistantEntry(props: {
  mode: AssistantMode | null; language: string; disabled: boolean; error: string; onPress(): void;
}) {
  const { tokens } = useTheme();
  const modeLabel = 'Gemma on-device';
  const status = 'Open Sensi. Sensi responds automatically to safety events';
  const disabled = props.disabled;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Driver Assistant" accessibilityHint={`${modeLabel}. ${status}. Drag in any direction to reposition.`}
      accessibilityState={{ disabled }} disabled={disabled} onPress={props.onPress}
      style={({ pressed }) => ({ width: 58, height: 58, borderRadius: 29, alignItems: 'center', justifyContent: 'center',
        backgroundColor: disabled ? tokens.disabledSurface : tokens.primary, opacity: pressed ? .85 : 1,
        shadowColor: tokens.shadow, shadowOpacity: .15, shadowRadius: 6, shadowOffset: { width: 0, height: 3 }, elevation: 3 })}>
      {/* A simple steering-wheel control glyph, separate from the official app logo. */}
      <View accessible={false} style={{ width: 29, height: 29, borderRadius: 15, borderWidth: 2.5, borderColor: disabled ? tokens.disabledText : tokens.onPrimary, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ position: 'absolute', width: 23, height: 3, top: 11, backgroundColor: disabled ? tokens.disabledText : tokens.onPrimary }} />
        <View style={{ position: 'absolute', width: 3, height: 12, bottom: 0, backgroundColor: disabled ? tokens.disabledText : tokens.onPrimary }} />
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: disabled ? tokens.disabledText : tokens.onPrimary }} />
      </View>
    </Pressable>
  );
}

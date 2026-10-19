import { useEffect, useState } from 'react';
import { AppState, Platform, Pressable, View } from 'react-native';
import { useTheme } from '../lib/theme/ThemeProvider';
import type { AssistantMode } from '../lib/assistant/mode';
import { PHONE_CONNECTED_READINESS } from '../lib/assistant/phoneConnectedReadiness';
import { checkDriverAssistantAvailability, checkOfflineSpeechCapability, listLocalVoices } from '../modules/local-foundation-models';
import { assertAssistantPlatform, assertAssistantCapabilities, selectAssistantVoice } from '../modules/local-foundation-models/conversationPolicy';
import { getSetting } from '../lib/db/repositories';

/** Passive capability checks only: no microphone, playback, inference or cloud request. */
export function DashboardAssistantEntry(props: {
  mode: AssistantMode | null; language: string; disabled: boolean; error: string; onPress(): void;
}) {
  const { tokens } = useTheme();
  const [availability, setAvailability] = useState<{ key: string; available: boolean; message: string } | null>(null);
  const key = `${props.mode}:${props.language}`;
  useEffect(() => {
    let current = true;
    let version = 0;
    async function refresh() {
      const request = ++version;
      if (props.mode !== 'local') return;
      setAvailability(null);
      try {
        assertAssistantPlatform(Platform.OS, props.language);
        const [model, speech, voices, preferred] = await Promise.all([
          checkDriverAssistantAvailability(), checkOfflineSpeechCapability('en-US'), listLocalVoices(), getSetting('voice:en'),
        ]);
        assertAssistantCapabilities(model, speech);
        selectAssistantVoice(voices, preferred);
        if (speech.speechPermission === 'denied' || speech.speechPermission === 'restricted' || speech.microphonePermission === 'denied')
          throw new Error('Enable microphone and speech access in iOS Settings.');
        if (current && request === version) setAvailability({ key, available: true, message: 'Available · speech permissions checked when starting' });
      } catch (error) {
        if (current && request === version) setAvailability({ key, available: false,
          message: error instanceof Error ? error.message : 'Availability could not be verified. Open Settings to check your voice setup.' });
      }
    }
    void refresh();
    const subscription = AppState.addEventListener('change', state => { if (state === 'active') void refresh(); });
    return () => { current = false; version++; subscription.remove(); };
  }, [key, props.mode, props.language]);
  const checked = availability?.key === key ? availability : null;
  const status = props.mode === 'connected' ? (PHONE_CONNECTED_READINESS.verified ? 'Development pilot' : 'Unavailable · see Sensi Settings')
    : props.mode === 'core' ? 'Tools in Settings'
    : props.mode === 'local' ? checked ? checked.available ? 'Ready' : 'Unavailable · see Settings' : 'Checking availability…' : 'Loading Assistant Mode…';
  const disabled = props.disabled || (props.mode === 'connected' && !PHONE_CONNECTED_READINESS.verified) || checked?.available === false;
  const modeLabel = props.mode === 'core' ? 'CORE' : props.mode === 'connected' ? 'CONNECTED AI' : props.mode === 'local' ? 'LOCAL AI' : 'Mode loading';
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Driver Assistant" accessibilityHint={`Open Sensi. ${modeLabel}. ${status}. Drag in any direction to reposition.`}
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

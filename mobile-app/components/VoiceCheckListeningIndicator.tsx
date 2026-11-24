import Feather from 'expo/node_modules/@expo/vector-icons/Feather';
import type { ComponentProps } from 'react';
import { View } from 'react-native';
import { LocalizedText as Text } from '../lib/i18n/native';
import { useTheme } from '../lib/theme/ThemeProvider';

type Indicator = { icon: ComponentProps<typeof Feather>['name']; label: string };
const ready: Indicator = { icon: 'shield', label: 'Ready…' };

/** Display only. The microphone icon is reserved for the published listening phase. */
export function VoiceCheckListeningIndicator({ phase, finished, answerPending, audioUnavailable, spokenMessage, compact, shortViewport }: {
  phase?: string; finished: boolean; answerPending: boolean; audioUnavailable?: boolean;
  spokenMessage?: string; compact: boolean; shortViewport: boolean;
}) {
  const { tokens: t } = useTheme();
  const listening = phase === 'listening' && !finished && !answerPending && !audioUnavailable;
  const unavailable = !finished && !answerPending && (audioUnavailable || phase === 'response_unavailable');
  let state = ready;
  if (finished) state = { icon: 'check', label: 'Safety check finished' };
  else if (answerPending) state = { icon: 'more-horizontal', label: 'Processing response…' };
  else if (unavailable) state = { icon: 'alert-circle', label: audioUnavailable
    ? 'Audio unavailable — use the buttons below' : 'Voice unavailable — use buttons or type a response' };
  else if (listening) state = { icon: 'mic', label: 'Listening…' };
  else if (phase === 'speaking') state = { icon: 'volume-2', label: 'Speaking…' };
  else if (phase === 'preparing') state = { icon: 'shield', label: 'Preparing microphone' };
  else if (phase === 'finalizing') state = { icon: 'more-horizontal', label: 'Processing response…' };
  else if (phase !== 'ready') state = { icon: 'more-horizontal', label: 'Finishing safety check…' };

  const size = compact ? 44 : 72;
  return <View style={{ alignItems: 'center', paddingHorizontal: 20, paddingVertical: compact ? 4 : 12, gap: compact ? 4 : 7 }}>
    <View style={{ alignItems: 'center', justifyContent: 'center', maxWidth: '100%',
      flexDirection: shortViewport ? 'row' : 'column', gap: shortViewport ? 8 : compact ? 4 : 7 }}>
      <View accessible={false} style={{ width: size, height: size, borderRadius: size / 2, alignItems: 'center',
        justifyContent: 'center', borderWidth: listening ? 3 : 1, borderColor: listening ? t.accent : t.border,
        backgroundColor: listening ? t.graphite : unavailable ? t.warningSurface : t.surfaceMuted }}>
        <Feather name={state.icon} size={compact ? 21 : 32} color={listening ? t.pearl : unavailable ? t.warning : t.text}
          accessible={false} allowFontScaling={false} />
      </View>
      <Text accessibilityLiveRegion="polite" style={{ color: t.text, fontSize: compact ? 15 : 19, fontWeight: '700', textAlign: 'center', flexShrink: 1 }}>
        {state.label}
      </Text>
    </View>
    {state.icon === 'volume-2' && spokenMessage ? <Text localize={false} numberOfLines={compact ? 1 : 2}
      style={{ color: t.textSecondary, textAlign: 'center', maxWidth: 480 }}>{spokenMessage}</Text> : null}
  </View>;
}

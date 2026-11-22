import { VOICECHECK_BASIC_OFFLINE } from '../lib/voice/basicOfflineAcknowledgment';
import { useSyncExternalStore } from 'react';
import { View } from 'react-native';
import { sensiPreferences } from '../lib/assistant/phoneSensiRouting';
import { LocalizedText as Text } from '../lib/i18n/native';
import { useTheme } from '../lib/theme/ThemeProvider';
import { acknowledgmentProviderLabel, RESPONSE_MODE_SUMMARIES } from '../lib/ui/sensiPresentation';
import type { ConversationMessage } from '../modules/local-foundation-models/assistantConversation';

function responseModeLabel() {
  if (VOICECHECK_BASIC_OFFLINE) return 'Basic Offline';
  const { loaded, preference } = sensiPreferences.state;
  return loaded ? RESPONSE_MODE_SUMMARIES[preference] : 'Loading…';
}

/** Debug presentation. Read the current settings and the transcript without starting provider work. */
export function VoiceCheckProviderStatus({ messages, recordedSource }: { messages: readonly ConversationMessage[]; recordedSource?: string }) {
  const { tokens: t } = useTheme();
  const mode = useSyncExternalStore(sensiPreferences.subscribe, responseModeLabel);
  let acknowledgment = recordedSource === undefined ? 'Not generated yet' : acknowledgmentProviderLabel(recordedSource);
  // The message records the source of the displayed text after any fallback.
  // Later guidance or contact prompts do not replace the last acknowledgment.
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === 'assistant' && message.acknowledgmentSource !== undefined) {
      acknowledgment = acknowledgmentProviderLabel(message.acknowledgmentSource);
      break;
    }
  }

  const labelStyle = { color: t.textSecondary, fontSize: 12 };
  const valueStyle = { color: t.text, fontWeight: '600' as const };
  return <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 14, rowGap: 2 }}>
    <Text style={labelStyle}>Response mode: <Text style={valueStyle}>{mode}</Text></Text>
    <Text accessibilityLiveRegion="polite" style={labelStyle}>Last acknowledgment: <Text style={valueStyle}>{acknowledgment}</Text></Text>
  </View>;
}

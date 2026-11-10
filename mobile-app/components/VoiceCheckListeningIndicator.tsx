import { LocalizedText as Text } from '../lib/i18n/native';
import { View } from 'react-native';
import { listeningPresentation } from '../lib/voice/voiceCheckPresentation';
import type { Lang } from '../lib/voice/voiceCheck';
import { useTheme } from '../lib/theme/ThemeProvider';
import { useAppLanguage } from '../lib/i18n/LanguageProvider';

export function VoiceCheckListeningIndicator({ active, phase, language }: { active: boolean; phase?: string; language: Lang }) {
  const { tokens } = useTheme();
  const state = listeningPresentation(active, phase, language);
  const { t } = useAppLanguage();
  if (!state.visible) return null;
  return <View accessible accessibilityLabel={t(state.label)} accessibilityLiveRegion="polite" style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 3 }}>
    <View accessible={false} style={{ backgroundColor: '#EC8A38', borderRadius: 5, width: 9, height: 9 }} />
    <Text style={{ color: tokens.text, fontSize: 14, fontWeight: '600' }}>{state.label}</Text>
  </View>;
}

import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { LocalizedText as Text } from '../lib/i18n/native';
import { useTheme } from '../lib/theme/ThemeProvider';
import { checkOfflineSpeechCapability, type OfflineSpeechCapability } from '../modules/local-foundation-models';

/** Advisory inventory query only. Never starts capture or gates manual responses. */
export function SpeechCapabilityStatus({ language, blocked }: { language: 'en' | 'es'; blocked: boolean }) {
  const { tokens } = useTheme();
  const [capability, setCapability] = useState<OfflineSpeechCapability | null>(null);
  useEffect(() => {
    let current = true, generation = 0;
    const refresh = () => {
      if (!current) return;
      const request = ++generation; setCapability(null);
      if (blocked || AppState.currentState !== 'active') return;
      void checkOfflineSpeechCapability(language === 'es' ? 'es-US' : 'en-US').then(value => {
        if (current && request === generation) setCapability(value);
      }).catch(() => {});
    };
    refresh();
    const app = AppState.addEventListener('change', state => { if (!current) return; if (state === 'active') refresh(); else { generation++; setCapability(null); } });
    return () => { current = false; generation++; app.remove(); };
  }, [language, blocked]);
  const message = !capability ? 'Recognition capability has not been established. Typed and button responses remain available.'
    : language === 'es' && capability.engine !== 'speech_transcriber' ? 'Update this app to check Spanish recognition capability.'
    : capability.reason === 'requires_ios_26' ? 'Spanish offline recognition requires iOS 26 on supported devices.'
    : !capability.supportsOnDeviceRecognition ? 'Offline recognition is unavailable for this language on this device.'
    : !capability.recognizerAvailable ? 'Recognition assets are unavailable or uncertain. Typed and button responses remain available.'
    : language === 'es' ? 'Spanish recognition assets are reported installed. Microphone capture is not verified.'
    : 'On-device recognition capability reported. Microphone capture is not verified.';
  return <Text accessibilityLiveRegion="polite" style={{ color: tokens.textSecondary }}>{message}</Text>;
}

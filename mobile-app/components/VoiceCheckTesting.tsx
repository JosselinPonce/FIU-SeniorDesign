import { useEffect, useRef, useState } from 'react';
import { AppState, KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { LocalizedText as Text, LocalizedTextInput as TextInput } from '../lib/i18n/native';
import { VoiceCheckLanguageScope } from '../lib/i18n/LanguageProvider';
import { useTheme } from '../lib/theme/ThemeProvider';
import { VoiceCheckDiagnostic, type DiagnosticState } from '../lib/voice/voiceCheckDiagnostic';
import { phoneVoiceCheckDiagnostic } from '../lib/voice/phoneVoiceCheckDiagnostic';
import type { Lang } from '../lib/voice/voiceCheck';
import { Btn } from './ui';
import { ScreenHeader, ScreenHeading } from './ScreenHeader';
import { SpeechCapabilityStatus } from './SpeechCapabilityStatus';

/** Standalone diagnostic. No drive/controller actions are accepted as props. */
export function VoiceCheckTesting({ blocked, initialLanguage, onExit }: { blocked: boolean; initialLanguage: Lang; onExit(): void }) {
  const { tokens: t } = useTheme();
  const [lang, setLang] = useState<Lang>(initialLanguage);
  const [text, setText] = useState('');
  const [state, setState] = useState<DiagnosticState>({ phase: 'idle', transcript: '', confirmed: false, result: null, error: '' });
  const disabled = useRef(blocked); disabled.current = blocked;
  const tester = useRef<VoiceCheckDiagnostic | null>(null);
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const session = new VoiceCheckDiagnostic(phoneVoiceCheckDiagnostic(() => !disabled.current && AppState.currentState === 'active'), setState);
    tester.current = session;
    const subscription = AppState.addEventListener('change', value => {
      setForeground(value === 'active');
      if (value !== 'active') void session.cancel().catch(() => {});
    });
    return () => { subscription.remove(); tester.current = null; void session.close().catch(() => {}); };
  }, []);
  useEffect(() => { if (blocked) void tester.current?.cancel().catch(() => {}); }, [blocked]);
  const busy = state.phase !== 'idle';
  const unavailable = blocked || !foreground;
  return <VoiceCheckLanguageScope language={lang}>
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScreenHeader title="VoiceCheck Testing" backLabel="Safety Testing" onBack={onExit} />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, gap: 12 }}>
        <ScreenHeading title="VoiceCheck Testing" />
        <Text>Diagnostic only. No sensor events, saved episodes, uploads or phone calls. Park before testing.</Text>
        <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', gap: 12 }}>
          {(['en', 'es'] as const).map(language => <Btn key={language} title={language === 'en' ? 'English' : 'Español'}
            kind={lang === language ? 'primary' : 'ghost'} disabled={busy} onPress={() => { setLang(language); setText(''); tester.current?.clear(); }} />)}
        </View>
        <SpeechCapabilityStatus language={lang} blocked={busy || unavailable} />
        {unavailable ? <Text>Testing paused while a safety workflow or recording is active.</Text> : null}
        <Btn title="Start recognition test" disabled={busy || unavailable} onPress={() => void tester.current?.listen(lang)} />
        <Text accessibilityLiveRegion="polite">{state.phase}</Text>
        <Text>Recognized transcript</Text>
        <Text localize={false} selectable>{state.transcript || '—'}</Text>
        {state.transcript && !state.confirmed ? <Text>Unconfirmed transcript — not used for interpretation.</Text> : null}
        {state.error ? <Text accessibilityRole="alert">{state.error}</Text> : null}
        <TextInput accessibilityLabel="Typed diagnostic response" placeholder="Type a response" value={text} onChangeText={setText} maxLength={500}
          style={{ color: t.text, borderWidth: 1, borderColor: t.textSecondary, borderRadius: 10, padding: 12 }} />
        <Btn title="Test interpretation" disabled={!text.trim() || unavailable} onPress={() => void tester.current?.interpret(text, lang).catch(() => {})} />
        {state.result ? <>
          <Text localize={false} accessibilityLiveRegion="polite">{state.result.interpretation}</Text>
          {state.result.urgent ? <Text>Urgent symptoms recognized</Text> : null}
          <Text>Response preview — no action is authorized</Text>
          <Text localize={false}>{state.result.response}</Text>
          <Btn title="Play response preview" disabled={busy || unavailable} onPress={() => void tester.current?.play(lang)} />
        </> : null}
      </ScrollView>
      <View style={{ padding: 12, gap: 8, borderTopWidth: 1, borderTopColor: t.border }}>
        <Btn title="Cancel test" kind="ghost" disabled={!busy} onPress={() => void tester.current?.cancel().catch(() => {})} />
        <Btn title="Exit testing" kind="ghost" onPress={onExit} />
      </View>
    </KeyboardAvoidingView>
  </VoiceCheckLanguageScope>;
}

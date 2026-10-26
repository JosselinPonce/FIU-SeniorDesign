import { useEffect, useRef, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import type { AnswerScope } from '../lib/voice/voiceCheck';
import { useTheme } from '../lib/theme/ThemeProvider';
import { Btn } from './ui';

/** Explicit Send only, scoped to the rendered question. Never parses intent. */
export function SafetyTypedResponse({ scope, submit }: {
  scope: AnswerScope & { episodeId: string };
  submit(text: string, scope: AnswerScope & { episodeId: string }): boolean;
}) {
  const { tokens: t } = useTheme();
  const [text, setText] = useState('');
  const [sent, setSent] = useState(false);
  const pending = useRef(false);
  useEffect(() => { setText(''); setSent(false); pending.current = false; }, [scope.episodeId, scope.captureId, scope.question]);
  function send() {
    if (pending.current || !scope.captureId || !text.trim()) return;
    pending.current = true;
    if (submit(text, scope)) { setSent(true); setText(''); }
    else pending.current = false;
  }
  return <View style={{ gap: 6 }}>
    <Text style={{ color: t.textSecondary, fontSize: 12 }}>Use voice while driving. Type only when it is safe.</Text>
    <TextInput accessibilityLabel="Typed safety response" placeholder="Type a response" placeholderTextColor={t.textSecondary}
      value={text} onChangeText={setText} editable={!sent} maxLength={500} returnKeyType="send" onSubmitEditing={send}
      style={{ color: t.text, borderColor: t.textSecondary, borderWidth: 1, padding: 10, borderRadius: 8 }} />
    <Btn title="Send response" disabled={sent || !scope.captureId || !text.trim()} onPress={send} />
  </View>;
}

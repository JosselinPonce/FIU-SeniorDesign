import { useEffect, useRef } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useTheme } from '../lib/theme/ThemeProvider';
import { nearThreadBottom, playbackLabel } from '../lib/assistant/threadPresentation';
import type { ConversationMessage } from '../modules/local-foundation-models/assistantConversation';

/** Rendering and scrolling only; no audio, recognition, persistence or provider calls. */
export function SensiConversationThread({ messages, provisional }: { messages: readonly ConversationMessage[]; provisional: string }) {
  const { tokens: t } = useTheme();
  const scroll = useRef<ScrollView>(null);
  const follow = useRef(true);
  const conversationId = messages[0]?.id;
  useEffect(() => {
    follow.current = true;
    scroll.current?.scrollToEnd({ animated: false });
  }, [conversationId]);
  return <ScrollView ref={scroll} style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 12, gap: 10 }}
    onScroll={({ nativeEvent: e }) => { follow.current = nearThreadBottom(e.contentSize.height, e.layoutMeasurement.height, e.contentOffset.y); }}
    onLayout={() => { if (follow.current) scroll.current?.scrollToEnd({ animated: false }); }}
    scrollEventThrottle={32} onContentSizeChange={() => { if (follow.current) scroll.current?.scrollToEnd({ animated: false }); }}>
    {messages.length === 0 ? <Text style={{ color: t.textSecondary, lineHeight: 22 }}>Hi, I’m Sensi, your driving assistant. Start a voice conversation when it’s safe.</Text> : null}
    {messages.map(message => {
      const driver = message.role === 'driver';
      const system = message.role === 'system';
      return <View key={message.id} style={{ alignSelf: system ? 'center' : driver ? 'flex-end' : 'flex-start', maxWidth: '88%',
        borderRadius: 20, borderBottomLeftRadius: driver || system ? 20 : 6, borderBottomRightRadius: driver ? 6 : 20,
        backgroundColor: system ? t.surfaceMuted : driver ? t.graphite : t.surface, paddingHorizontal: 12, paddingVertical: 10, gap: 4,
        borderWidth: driver || system ? 0 : 1, borderColor: t.border }}>
        <Text style={{ color: driver ? t.pearl : t.textSecondary, fontSize: 12, fontWeight: '700' }}>{system ? 'Status' : driver ? 'You' : 'Sensi'}</Text>
        <Text selectable style={{ color: driver ? t.pearl : t.text, fontSize: 16, lineHeight: 23 }}>{message.text}</Text>
        {message.playback ? <Text style={{ color: t.textSecondary, fontSize: 12 }}>{playbackLabel(message.playback)}</Text> : null}
      </View>;
    })}
    {provisional ? <View style={{ alignSelf: 'flex-end', maxWidth: '88%', padding: 10, borderRadius: 18, borderWidth: 1, borderColor: t.border }}>
      <Text style={{ color: t.textSecondary, fontSize: 12 }}>You · not confirmed</Text>
      <Text style={{ color: t.textSecondary, fontSize: 16, lineHeight: 23 }}>{provisional}</Text>
    </View> : null}
  </ScrollView>;
}

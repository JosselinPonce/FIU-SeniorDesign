import { useEffect, useRef } from 'react';
import { Animated, Modal, Pressable, SafeAreaView, ScrollView, View } from 'react-native';
import Feather from 'expo/node_modules/@expo/vector-icons/Feather';
import { LocalizedText as Text } from '../lib/i18n/native';
import { useAppLanguage } from '../lib/i18n/LanguageProvider';
import { useTheme } from '../lib/theme/ThemeProvider';
import type { AskConversation } from '../lib/assistant/askSensiConversation';
import { Btn } from './ui';

export function AskSensiHistory({ chats, activeId, driveLabel, onClose, onNew, onSelect, onDelete }: {
  chats: AskConversation[];
  activeId?: string;
  driveLabel(chat: AskConversation): string;
  onClose(): void;
  onNew(): void;
  onSelect(chat: AskConversation): void;
  onDelete(chat: AskConversation): void;
}) {
  const { tokens } = useTheme();
  const { language, t } = useAppLanguage();
  const locale = language === 'es' ? 'es' : 'en';
  const offset = useRef(new Animated.Value(-380)).current;
  useEffect(() => {
    const animation = Animated.timing(offset, { toValue: 0, duration: 200, useNativeDriver: true });
    animation.start();
    return () => animation.stop();
  }, [offset]);
  return <Modal transparent visible onRequestClose={onClose}>
    <View style={{ flex: 1, flexDirection: 'row', backgroundColor: tokens.overlay }}>
      <Pressable accessibilityRole="button" accessibilityLabel="Close conversation history" onPress={onClose}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} />
      <Animated.View style={{ width: '82%', maxWidth: 360, backgroundColor: tokens.background, transform: [{ translateX: offset }] }}>
        <SafeAreaView style={{ flex: 1 }} accessibilityViewIsModal>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12 }}>
            <Btn title="New Chat" kind="ghost" onPress={onNew} />
            <Pressable accessibilityRole="button" accessibilityLabel="Close history" onPress={onClose}
              style={{ padding: 12 }}><Feather name="x" size={22} color={tokens.text} /></Pressable>
          </View>
          <ScrollView contentContainerStyle={{ padding: 10, gap: 4 }}>
            {chats.length === 0 ? <Text style={{ color: tokens.textSecondary }}>No saved conversations.</Text> : null}
            {chats.map(chat => <View key={chat.id} style={{ flexDirection: 'row', alignItems: 'center', borderRadius: 10,
              backgroundColor: chat.id === activeId ? tokens.surfaceMuted : tokens.background }}>
              <Pressable accessibilityRole="button" accessibilityState={{ selected: chat.id === activeId }}
                style={{ flex: 1, padding: 10, minHeight: 48 }} onPress={() => onSelect(chat)}>
                <Text localize={false} numberOfLines={1} style={{ color: tokens.text, fontWeight: '600' }}>{chat.title}</Text>
                <Text localize={false} style={{ color: tokens.textSecondary, fontSize: 12 }}>
                  {Number.isFinite(Date.parse(chat.createdAt)) ? new Date(chat.createdAt).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' }) : t('Date unavailable')}{chat.driveId ? ' · ' + driveLabel(chat) : ''}
                </Text>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="Delete conversation" onPress={() => onDelete(chat)}
                style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}><Feather name="trash-2" size={17} color={tokens.textSecondary} /></Pressable>
            </View>)}
          </ScrollView>
        </SafeAreaView>
      </Animated.View>
    </View>
  </Modal>;
}

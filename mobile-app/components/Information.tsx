import { LocalizedPressable as Pressable, LocalizedText as Text } from '../lib/i18n/native';
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AccessibilityInfo, AppState, findNodeHandle, Modal, SafeAreaView, ScrollView, View } from 'react-native';
import { useAppLanguage } from '../lib/i18n/LanguageProvider';
import { useTheme } from '../lib/theme/ThemeProvider';
import { createInformationState } from '../lib/ui/information';
import { SettingsRow } from './SettingsGroup';

const InformationContext = createContext<ReturnType<typeof createInformationState> | null>(null);
function useInformation() {
  const state = useContext(InformationContext);
  if (!state) throw new Error('InformationProvider is required');
  return state;
}
export function InformationProvider({ children }: { children: ReactNode }) {
  const [state] = useState(createInformationState);
  return <InformationContext.Provider value={state}>{children}</InformationContext.Provider>;
}
/** Lives beside VoiceCheckModal, with visibility suppressed in the same render as safety. */
export function InformationHost({ blocked }: { blocked: boolean }) {
  const state = useInformation();
  const content = useSyncExternalStore(state.subscribe, state.getSnapshot, state.getSnapshot);
  const { tokens } = useTheme();
  const { t } = useAppLanguage();
  const body = content?.body ?? '';
  const translated = t(body);
  const displayBody = translated === body ? body.split('\n').map(t).join('\n') : translated;
  const title = useRef<Text>(null);
  useLayoutEffect(() => { state.block(blocked); }, [state, blocked]);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', value => { if (value !== 'active') state.close(); });
    return () => { subscription.remove(); state.close(); };
  }, [state]);
  return <Modal visible={!blocked && content !== null} transparent animationType="none"
    onRequestClose={state.close} onShow={() => {
      const handle = findNodeHandle(title.current); if (handle != null) AccessibilityInfo.setAccessibilityFocus(handle);
    }}>
    <SafeAreaView style={{ flex: 1, backgroundColor: tokens.overlay }}>
      <View style={{ flex: 1, justifyContent: 'flex-end', padding: 12 }}>
        <Pressable accessible={false} onPress={state.close} style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }} />
        <View accessibilityViewIsModal onAccessibilityEscape={state.close}
          style={{ maxHeight: '88%', borderRadius: 20, paddingTop: 18, backgroundColor: tokens.surface }}>
          <Text ref={title} accessible accessibilityRole="header" style={{ paddingHorizontal: 18, paddingBottom: 10, color: tokens.text, fontSize: 21, fontWeight: '700' }}>{content?.title}</Text>
          <ScrollView bounces={false} contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 12 }}>
            <Text localize={false} style={{ color: tokens.textSecondary, fontSize: 16 }}>{displayBody}</Text>
          </ScrollView>
          <SettingsRow divider action title="Done" onPress={state.close} />
        </View>
      </View>
    </SafeAreaView>
  </Modal>;
}
export function InformationButton({ title, body, compact = false }: { title: string; body: string; compact?: boolean }) {
  const state = useInformation();
  const { tokens } = useTheme();
  return <Pressable accessibilityRole="button" accessibilityLabel={`Information about ${title}`}
    accessibilityHint="Opens an information sheet" onPress={() => state.open({ title, body })}
    style={{ minWidth: 44, minHeight: 44, flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: compact ? 'center' : 'flex-start' }}>
    <Text style={{ color: tokens.textSecondary, fontSize: 23 }}>ⓘ</Text>
    {!compact ? <Text style={{ color: tokens.textSecondary, flexShrink: 1, fontSize: 13 }}>{title}</Text> : null}
  </Pressable>;
}

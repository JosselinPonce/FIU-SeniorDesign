import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AccessibilityInfo, AppState, findNodeHandle, Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { useTheme } from '../lib/theme/ThemeProvider';
import { createInformationState } from '../lib/ui/information';
import { Btn } from './ui';

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
    <View style={{ flex: 1, backgroundColor: tokens.overlay, justifyContent: 'center', padding: 24 }}>
      <View accessibilityViewIsModal style={{ maxHeight: '80%', borderRadius: 22, padding: 20, gap: 16, backgroundColor: tokens.surface }}>
        <Text ref={title} accessible accessibilityRole="header" style={{ color: tokens.text, fontSize: 22, fontWeight: '700' }}>{content?.title}</Text>
        <ScrollView><Text style={{ color: tokens.textSecondary, fontSize: 16, lineHeight: 24 }}>{content?.body}</Text></ScrollView>
        <Btn title="Close" onPress={state.close} />
      </View>
    </View>
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

import Feather from 'expo/node_modules/@expo/vector-icons/Feather';
import { useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ScrollView, View } from 'react-native';
import { LocalizedPressable as Pressable, LocalizedText as Text } from '../lib/i18n/native';
import { isOpenAIAcknowledgmentReady, isPhoneGemmaAcknowledgmentReady, isGemmaPreparing, subscribeGemmaPreparation, sensiPreferences } from '../lib/assistant/phoneSensiRouting';
import { sensiCloudAuth } from '../lib/assistant/phoneCloudAuth';
import { sensiSetup } from '../lib/onboarding/phone';
import { gemmaPoc, inspectGemmaModelFile, subscribeGemmaReadiness } from '../modules/gemma-poc/phone';
import type { SensiPreference } from '../lib/assistant/sensiPreferences';
import { useTheme } from '../lib/theme/ThemeProvider';
import type { ConversationMessage } from '../modules/local-foundation-models/assistantConversation';

const modes = [
  ['automatic', 'Automatic'], ['gemma', 'On Device (Gemma)'], ['openai', 'OpenAI'],
] as const;
const readPreference = () => sensiPreferences.state;
const subscribeAuth = (notify: () => void) => sensiCloudAuth.subscribe(notify);
const readAuth = () => sensiCloudAuth.state.status;
const subscribeSetup = (notify: () => void) => sensiSetup.subscribe(notify);
const readTerms = () => sensiSetup.state.terms;
const subscribeGemma = (notify: () => void) => gemmaPoc.subscribe(notify);
const readGemma = () => gemmaPoc.state;

/** Preference writes affect optional acknowledgment routing only. */
export function BasicOfflineStatus({ messages }: { messages: readonly ConversationMessage[] }) {
  const { tokens: t } = useTheme();
  const spoke = messages.some(message => message.role === 'assistant' && message.playback === 'completed' && message.acknowledgmentSource === 'fallback');
  return <View style={{ marginHorizontal: 16, alignSelf: 'stretch' }}>
    <Text style={{ color: t.text, fontSize: 13, fontWeight: '700' }}>Basic Offline</Text>
    <Text accessibilityLiveRegion="polite" style={{ color: t.textSecondary, fontSize: 12 }}>
      Last acknowledgment: <Text style={{ color: t.text, fontWeight: '600' }}>{spoke ? 'Basic Offline' : 'None yet'}</Text>
    </Text>
  </View>;
}

export function LiveSensiProvider({ messages, compact = false, driverId, cloudRestricted }: {
  messages: readonly ConversationMessage[]; compact?: boolean; driverId: string | null; cloudRestricted: boolean;
}) {
  const { tokens: t } = useTheme();
  const { loaded, preference, driverId: consentDriver, consent } = useSyncExternalStore(sensiPreferences.subscribe, readPreference);
  const auth = useSyncExternalStore(subscribeAuth, readAuth);
  const terms = useSyncExternalStore(subscribeSetup, readTerms);
  const runtime = useSyncExternalStore(subscribeGemma, readGemma);
  const modelFile = useMemo(() => runtime.busy ? null : inspectGemmaModelFile(), [runtime.busy, runtime.installed]);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const writing = useRef(false);
  const mode = !loaded ? 'Loading…' : modes.find(([id]) => id === preference)?.[1] ?? 'Basic Offline';
  const gemmaReady = useSyncExternalStore(subscribeGemmaReadiness, isPhoneGemmaAcknowledgmentReady);
  const preparing = useSyncExternalStore(subscribeGemmaPreparation, isGemmaPreparing);
  const cloudReady = !cloudRestricted && !!driverId && consentDriver === driverId && consent && isOpenAIAcknowledgmentReady();
  const gemmaStatus = gemmaReady ? 'Ready' : preparing ? 'Preparing Gemma…' : !terms || runtime.error || runtime.cleanupRequired ? 'Unavailable'
    : runtime.busy ? 'Working…'
      : modelFile === 'missing' ? 'Download required' : 'Unavailable';
  const cloudStatus = cloudRestricted ? 'Unavailable' : cloudReady ? 'Ready'
    : auth === 'signed_out' ? 'Sign-in required' : auth === 'checking' ? 'Checking session…'
      : auth !== 'signed_in' || !driverId ? 'Unavailable'
        : consentDriver !== driverId || !consent ? 'Consent required' : 'Unavailable';
  const readiness = !loaded || busy ? 'Loading…' : preference === 'gemma' ? gemmaStatus
    : preference === 'openai' ? cloudStatus : preference === 'basic' ? 'Ready'
      : cloudReady || gemmaReady ? 'Available' : 'Limited availability';
  const icon = preference === 'gemma' ? 'cpu' : preference === 'openai' ? 'cloud'
    : preference === 'basic' ? 'shield' : 'sliders';
  const acknowledgment = messages.slice().reverse().find(message =>
    message.role === 'assistant' && message.playback === 'completed' && message.acknowledgmentSource !== undefined);
  const source = acknowledgment?.acknowledgmentSource;
  const provider = !acknowledgment ? 'None yet'
    : source === 'gemma' ? 'Gemma' : source === 'openai' ? 'OpenAI'
      : source === 'fallback' ? 'Basic Offline' : 'Unknown';

  async function select(next: SensiPreference) {
    if (!loaded || writing.current || next === preference) return;
    writing.current = true;
    setBusy(true);
    setError(false);
    try { await sensiPreferences.savePreference(next); setExpanded(false); }
    catch { setError(true); }
    finally { writing.current = false; setBusy(false); }
  }

  return <View style={{ marginHorizontal: 16, alignSelf: 'stretch' }}>
    <Pressable accessibilityRole="button" accessibilityHint="AI response mode"
      accessibilityState={{ expanded, disabled: !loaded }}
      disabled={!loaded} onPress={() => setExpanded(value => !value)}
      style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', columnGap: 6 }}>
      <Feather name={icon} size={14} color={t.textSecondary} accessible={false} allowFontScaling={false} />
      <Text style={{ color: t.text, fontSize: 13, fontWeight: '700', flex: 1, minWidth: 0 }}>{mode}</Text>
      <Text accessibilityLiveRegion="polite" style={{ color: t.textSecondary, fontSize: 12, flexShrink: 1 }}>{readiness}</Text>
      <Feather name={expanded ? 'chevron-up' : 'chevron-down'} size={14} color={t.textSecondary}
        accessible={false} allowFontScaling={false} />
    </Pressable>
    <Text accessibilityLiveRegion="polite" style={{ color: t.textSecondary, fontSize: 12 }}>
      Last acknowledgment: <Text style={{ color: t.text, fontWeight: '600' }}>{provider}</Text>
    </Text>
    {expanded ? <ScrollView keyboardShouldPersistTaps="handled" style={compact ? { flexGrow: 0, maxHeight: 64 } : { flexGrow: 0 }}>
      <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>
        {modes.map(([id, label]) => <Pressable key={id} accessibilityRole="radio"
          accessibilityState={{ checked: preference === id, disabled: busy }}
          disabled={busy} onPress={() => { void select(id); }}
          style={{ minHeight: 44, paddingHorizontal: 8, justifyContent: 'center', borderRadius: 8,
            backgroundColor: preference === id ? t.primary : t.surface }}>
          <Text style={{ color: preference === id ? t.onPrimary : t.text, fontSize: 13 }}>{label}</Text>
        </Pressable>)}
      </View>
      <Text style={{ color: t.textSecondary, fontSize: 12 }}>OpenAI requires sign-in and cloud consent in Settings.</Text>
    </ScrollView> : null}
    {error ? <Text accessibilityRole="alert" style={{ color: t.danger, fontSize: 12 }}>Sensi setting unavailable.</Text> : null}
  </View>;
}

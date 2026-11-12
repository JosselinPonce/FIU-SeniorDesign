import { VoiceCheckLanguageScope } from '../lib/i18n/LanguageProvider';
import { RealContactDemoConfirmation } from './RealContactDemoConfirmation';
import { traceVoiceCheckUI } from '../lib/voice/responsivenessDiagnostics';
import { LocalizedText as Text } from '../lib/i18n/native';
import { SafetyTypedResponse } from './SafetyTypedResponse';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Modal, SafeAreaView, View, KeyboardAvoidingView, Platform } from 'react-native';
import type { useDriveSession } from '../lib/hooks/useDriveSession';
import type { AssistantMode } from '../lib/assistant/mode';
import { safetyButtonText, simulationCompletion } from '../lib/assistant/safetyConversation';
import { contactHandoffMessage } from '../modules/local-foundation-models/conversationPolicy';
import { useTheme } from '../lib/theme/ThemeProvider';
import { SensiConversationThread } from './SensiConversationThread';
import { Btn } from './ui';
import { VoiceCheckListeningIndicator } from './VoiceCheckListeningIndicator';

type Drive = ReturnType<typeof useDriveSession>;
/** A view of VoiceCheck, never a second recognition loop or contact decision engine. */
export function SensiSafetyConversation({ drive, onContinue, standby, onStandbyClose }: {
  drive: Drive; onContinue(episodeId: string, mode: AssistantMode): void;
  standby?: ReactNode; onStandbyClose?(): void;
}) {
  const { tokens: t } = useTheme();
  const dialogue = drive.safety.conversation;
  const check = drive.safety.check;
  const diagnosticCheck = drive.safety.check;
  useEffect(() => {
    if (diagnosticCheck && diagnosticCheck.episode.id === dialogue?.episodeId) traceVoiceCheckUI(diagnosticCheck, 'conversation');
  }, [diagnosticCheck?.captureId, diagnosticCheck?.question, diagnosticCheck?.phase, !!diagnosticCheck?.fallbackText, dialogue?.episodeId]);
  const pending = useRef(false);
  const [answerPending, setAnswerPending] = useState(false);
  useEffect(() => { pending.current = false; setAnswerPending(false); }, [dialogue?.episodeId, check?.question, check?.captureId]);
  // Keep one native modal host when a sensor event replaces standby. Neither
  // navigation nor the presentation transition touches the active VoiceCheck.
  if (!dialogue) return standby ? <Modal visible transparent animationType="fade" onRequestClose={onStandbyClose}>{standby}</Modal> : null;
  const active = !!check && check.episode.id === dialogue.episodeId;
  const showListening = active && !answerPending && !check?.fallbackText && check?.phase === 'listening';
  const last = drive.safety.last?.episode.id === dialogue.episodeId ? drive.safety.last : null;
  function answer(positive: boolean) {
    if (!active || pending.current || !check) return;
    const accepted = drive.respondAlert(check.question === 'contact_offer' ? positive ? 'call_yes' : 'call_no' : positive ? 'ok' : 'not_ok',
      { episodeId: dialogue!.episodeId, question: check.question, captureId: check.captureId });
    if (accepted !== false) { pending.current = true; setAnswerPending(true); }
  }
  const controls = <>
        {active ? <>
          <Btn title={safetyButtonText(check.question, true)} disabled={answerPending} onPress={() => answer(true)} />
          <Btn title={safetyButtonText(check.question, false)} kind="ghost" disabled={answerPending} onPress={() => answer(false)} />
          <SafetyTypedResponse scope={{ episodeId: dialogue.episodeId, question: check.question, captureId: check.captureId }} submit={drive.respondAlertText} />
        </> : null}
        {dialogue.finished && last ? <Text accessibilityLiveRegion="polite" style={{ color: t.text }}>Status: {' '}
          {last.handoff === 'opened' || last.handoff === 'open_failed' ? contactHandoffMessage(last.handoff) : last.simulation ? simulationCompletion(last.result, !!drive.safety.pendingDemoContact, !!dialogue.realContactDemo) : last.handoff ? contactHandoffMessage(last.handoff) : last.result.outcome === 'ok' ? 'You said you were OK.'
            : last.result.outcome === 'no_response' ? 'No confirmed answer was received. No automatic phone call was made.' : 'You said you were not OK. Follow the safety guidance above.'}
        </Text> : null}

        {dialogue.finished && last?.simulation ? <RealContactDemoConfirmation drive={drive} /> : null}
        {dialogue.finished ? <Btn title="Close safety check" kind="ghost" onPress={() => drive.dismissSafetyConversation(dialogue.episodeId)} /> : null}
  </>;
  return <Modal visible transparent animationType="fade" onRequestClose={() => {
    if (dialogue.finished) drive.dismissSafetyConversation(dialogue.episodeId);
  }}>
    <VoiceCheckLanguageScope language={dialogue.language ?? (drive.driver?.language === 'es' ? 'es' : 'en')}>
    <SafeAreaView style={{ flex: 1, backgroundColor: t.background }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={{ paddingHorizontal: 16, paddingVertical: 10, gap: 4, flexShrink: 0, backgroundColor: t.background, borderBottomWidth: 1, borderBottomColor: t.border }}>
        <Text accessibilityRole="header" style={{ color: t.text, fontSize: 18, fontWeight: '700' }}>Sensi · Safety check{dialogue.simulation ? ' · Simulation' : dialogue.simulation === false ? ' · Live sensors' : ''}</Text>
        {showListening ? <VoiceCheckListeningIndicator active phase={check?.phase} language={drive.driver?.language === 'es' ? 'es' : 'en'} />
          : <Text accessibilityLiveRegion="polite" style={{ color: t.text }}>{active ? check.fallbackText ? 'Audio unavailable — use the buttons below' : check.phase === 'speaking' ? 'Speaking…' : check.phase === 'preparing' ? 'Preparing microphone' : check.phase === 'ready' ? 'Ready…' : check.phase === 'finalizing' ? 'Processing response…' : check.phase === 'response_unavailable' ? 'Voice unavailable — use buttons or type a response' : 'Processing response…' : dialogue.finished ? 'Safety check finished' : 'Finishing safety check…'}</Text>}
      {dialogue.simulation ? <Text style={{ color: t.textSecondary, fontSize: 12 }}>{dialogue.realContactDemo ? 'Real-contact demo · iOS confirmation required' : 'Noncalling simulation'}</Text> : null}
      </View>

      <SensiConversationThread messages={dialogue.simulation ? dialogue.messages.filter(message => !(message.role === 'system' && /^(?:Simulation complete\.|Noncalling simulation complete\.|Contact consent received\.)/.test(message.text))) : dialogue.messages} provisional="" compactPlayback footer={controls} />

    </KeyboardAvoidingView>
    </SafeAreaView>
    </VoiceCheckLanguageScope>
  </Modal>;
}

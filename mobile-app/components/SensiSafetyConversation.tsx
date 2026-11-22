import { VOICECHECK_BASIC_OFFLINE } from '../lib/voice/basicOfflineAcknowledgment';
import { VoiceCheckLanguageScope } from '../lib/i18n/LanguageProvider';
import { RealContactDemoConfirmation } from './RealContactDemoConfirmation';
import { responsivenessProbe, SENSI_ACKNOWLEDGMENT_PRESENTATION, traceVoiceCheckUI } from '../lib/voice/responsivenessDiagnostics';
import { LocalizedText as Text } from '../lib/i18n/native';
import { SafetyTypedResponse } from './SafetyTypedResponse';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Modal, SafeAreaView, View, KeyboardAvoidingView, Platform, ScrollView, useWindowDimensions } from 'react-native';
import type { useDriveSession } from '../lib/hooks/useDriveSession';
import type { AssistantMode } from '../lib/assistant/mode';
import { safetyButtonText, simulationCompletion } from '../lib/assistant/safetyConversation';
import { contactHandoffMessage } from '../modules/local-foundation-models/conversationPolicy';
import { useTheme } from '../lib/theme/ThemeProvider';
import { SensiConversationThread } from './SensiConversationThread';
import { BasicOfflineStatus, LiveSensiProvider } from './LiveSensiProvider';
import { Btn } from './ui';
import { VoiceCheckListeningIndicator } from './VoiceCheckListeningIndicator';

type Drive = ReturnType<typeof useDriveSession>;
/** A view of VoiceCheck, never a second recognition loop or contact decision engine. */
export function SensiSafetyConversation({ drive, onContinue, standby, onStandbyClose }: {
  drive: Drive; onContinue(episodeId: string, mode: AssistantMode): void;
  standby?: ReactNode; onStandbyClose?(): void;
}) {
  const { tokens: t } = useTheme();
  const { height, width, fontScale } = useWindowDimensions();
  const [viewport, setViewport] = useState(0);
  const availableHeight = viewport || height;
  const compact = availableHeight < 560 || fontScale >= 1.5;
  const stackActions = (width < 350 && fontScale > 1.3) || fontScale >= 1.8;
  const dialogue = drive.safety.conversation;
  const check = drive.safety.check;
  useEffect(() => {
    if (check && check.episode.id === dialogue?.episodeId) traceVoiceCheckUI(check, 'conversation');
  }, [check?.captureId, check?.question, check?.phase, !!check?.fallbackText, dialogue?.episodeId]);
  const latestAcknowledgment = __DEV__ ? dialogue?.messages.slice().reverse().find(message =>
    message.role === 'assistant' && message.acknowledgmentSource !== undefined) : undefined;
  useEffect(() => {
    if (__DEV__ && latestAcknowledgment) {
      responsivenessProbe('warning', SENSI_ACKNOWLEDGMENT_PRESENTATION)('displayed', { source: latestAcknowledgment.acknowledgmentSource });
    }
  }, [latestAcknowledgment?.id, latestAcknowledgment?.acknowledgmentSource]);
  const pending = useRef(false);
  const [answerPending, setAnswerPending] = useState(false);
  useEffect(() => { pending.current = false; setAnswerPending(false); }, [dialogue?.episodeId, check?.question, check?.captureId]);
  // Keep one native modal host when a sensor event replaces standby. Neither
  // navigation nor the presentation transition touches the active VoiceCheck.
  if (!dialogue) return standby ? <Modal visible transparent animationType="fade" onRequestClose={onStandbyClose}>{standby}</Modal> : null;
  const active = !!check && check.episode.id === dialogue.episodeId;
  const spokenMessage = active && check.phase === 'speaking'
    ? dialogue.messages.slice().reverse().find(message => message.role === 'assistant' && message.playback === 'playing')?.text : undefined;
  const last = drive.safety.last?.episode.id === dialogue.episodeId ? drive.safety.last : null;
  function answer(positive: boolean) {
    if (!active || pending.current || !check) return;
    const accepted = drive.respondAlert(check.question === 'contact_offer' ? positive ? 'call_yes' : 'call_no' : positive ? 'ok' : 'not_ok',
      { episodeId: dialogue!.episodeId, question: check.question, captureId: check.captureId });
    if (accepted !== false) { pending.current = true; setAnswerPending(true); }
  }
  const controls = <>
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
          <View style={{ flex: 1 }} onLayout={({ nativeEvent }) => setViewport(nativeEvent.layout.height)}>
            <View style={{ paddingHorizontal: 16, paddingVertical: compact ? 4 : 9, flexShrink: 0, flexDirection: 'row',
              flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: 10 }}>
              <View>
                <Text accessibilityRole="header" style={{ color: t.text, fontSize: compact ? 22 : 28, fontWeight: '800' }}>Sensi</Text>
                <Text style={{ color: t.textSecondary, fontSize: 13 }}>Safety check</Text>
              </View>
              {dialogue.simulation ? <Text style={{ backgroundColor: t.warningSurface, color: t.warning, borderRadius: 10,
                overflow: 'hidden', paddingHorizontal: 9, paddingVertical: 4, fontSize: 12, fontWeight: '700' }}>Simulation</Text> : null}
              {dialogue.realContactDemo ? <Text style={{ color: t.textSecondary, fontSize: 12, flexBasis: '100%' }}>
                Real-contact demo · iOS confirmation required
              </Text> : null}
            </View>
            {VOICECHECK_BASIC_OFFLINE ? <BasicOfflineStatus messages={dialogue.messages} /> : <LiveSensiProvider key={dialogue.episodeId} messages={dialogue.messages}
              compact={availableHeight < 390} driverId={drive.driver?.id ?? null} cloudRestricted={dialogue.simulation !== false && !dialogue.cloudSimulation} />}
            <VoiceCheckListeningIndicator phase={active ? check.phase : undefined} finished={dialogue.finished}
              answerPending={answerPending} audioUnavailable={active && !!check.fallbackText} spokenMessage={spokenMessage} compact={compact} shortViewport={availableHeight < 390} />

            <SensiConversationThread messages={dialogue.simulation ? dialogue.messages.filter(message => !(message.role === 'system' && /^(?:Simulation complete\.|Noncalling simulation complete\.|Contact consent received\.)/.test(message.text))) : dialogue.messages} provisional="" compactPlayback />

            {active ? <View style={{ paddingHorizontal: 12, paddingTop: 8, gap: 6, borderTopWidth: 1, borderColor: t.border }}>
              <View style={{ flexDirection: stackActions ? 'column' : 'row', gap: 8 }}>
                <Btn title={safetyButtonText(check.question, true)}
                  style={stackActions ? undefined : { flex: 1, minHeight: 48, paddingHorizontal: 8 }} disabled={answerPending} onPress={() => answer(true)} />
                <Btn title={safetyButtonText(check.question, false)} kind="ghost"
                  style={stackActions ? undefined : { flex: 1, minHeight: 48, paddingHorizontal: 8 }} disabled={answerPending} onPress={() => answer(false)} />
              </View>
              <ScrollView keyboardShouldPersistTaps="handled" style={{ flexGrow: 0, flexShrink: 1, maxHeight: Math.max(76, availableHeight * 0.28) }}
                contentContainerStyle={{ paddingBottom: 8 }}>
                <SafetyTypedResponse secondary scope={{ episodeId: dialogue.episodeId, question: check.question, captureId: check.captureId }} submit={drive.respondAlertText} />
                {controls}
              </ScrollView>
            </View> : <ScrollView keyboardShouldPersistTaps="handled" style={{ flexGrow: 0, flexShrink: 1,
              maxHeight: availableHeight * 0.48, borderTopWidth: 1, borderTopColor: t.border }} contentContainerStyle={{ padding: 12, gap: 8 }}>
              {controls}
            </ScrollView>}
          </View>

      </KeyboardAvoidingView>
      </SafeAreaView>
    </VoiceCheckLanguageScope>
  </Modal>;
}

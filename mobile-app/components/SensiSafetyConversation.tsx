import { RealContactDemoConfirmation } from './RealContactDemoConfirmation';
import { responsivenessProbe, SENSI_ACKNOWLEDGMENT_PRESENTATION, traceVoiceCheckUI } from '../lib/voice/responsivenessDiagnostics';
import { LocalizedText as Text } from '../lib/i18n/native';
import { SafetyTypedResponse } from './SafetyTypedResponse';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Modal, SafeAreaView, View, KeyboardAvoidingView, Platform, ScrollView, useWindowDimensions } from 'react-native';
import type { useDriveSession } from '../lib/hooks/useDriveSession';
import type { HandoffUnavailable } from '../lib/diagnostics/hardwareSafetyTest';
import type { AssistantMode } from '../lib/assistant/mode';
import { safetyButtonText, simulationCompletion } from '../lib/assistant/safetyConversation';
import { contactHandoffMessage } from '../modules/local-foundation-models/conversationPolicy';
import { useTheme } from '../lib/theme/ThemeProvider';
import { SensiConversationThread } from './SensiConversationThread';
import { Btn } from './ui';
import { VoiceCheckListeningIndicator } from './VoiceCheckListeningIndicator';

type Drive = ReturnType<typeof useDriveSession>;
const handoffUnavailable: Record<HandoffUnavailable, string> = {
  not_enabled: 'Contact handoff was not enabled for this test.',
  contact_unavailable: 'The saved emergency contact is unavailable.',
  signal_lost: 'Sensor signal was lost before contact authorization.',
  episode_expired: 'The emergency episode expired.',
  ownership_lost: 'The response no longer belongs to the active question.',
};

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
  const hardware = __DEV__ && dialogue && drive.hardwareTest?.safety?.conversation?.episodeId === dialogue.episodeId ? drive.hardwareTest : null;
  const homeDemo = __DEV__ && dialogue && drive.homeHardwareDemo?.safety?.conversation?.episodeId === dialogue.episodeId
    ? drive.homeHardwareDemo : null;
  const homeConfirmation = homeDemo?.confirmation;
  const confirmation = hardware?.confirmation;
  const visibleConfirmationId = dialogue?.finished ? confirmation?.id : undefined;
  const markConfirmationVisible = __DEV__ ? drive.hardwareTestControls?.markConfirmationVisible : undefined;
  useEffect(() => {
    if (__DEV__ && visibleConfirmationId) markConfirmationVisible?.(visibleConfirmationId);
  }, [markConfirmationVisible, visibleConfirmationId]);
  const markListeningVisible = __DEV__ ? drive.hardwareTestControls?.markListeningVisible : undefined;
  const listeningCapture = hardware && !dialogue?.finished && !answerPending && !check?.fallbackText
    && check?.phase === 'listening' && check.episode.id === dialogue?.episodeId ? check.captureId : undefined;
  useEffect(() => {
    if (__DEV__ && dialogue?.episodeId && listeningCapture) markListeningVisible?.(dialogue.episodeId, listeningCapture);
  }, [markListeningVisible, dialogue?.episodeId, listeningCapture]);
  const blockedHandoff = hardware?.handoffEvidence?.permit?.reason;
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
        {dialogue.finished && homeDemo ? homeConfirmation ? <>
          <Text accessibilityRole="header" style={{ color: t.text, fontWeight: '700' }}>Confirm saved test contact</Text>
          <Text localize={false} selectable style={{ color: t.text }}>{homeConfirmation.name} · {homeConfirmation.phone}</Text>
          <Text style={{ color: t.textSecondary }}>Continuing opens the real iPhone calling interface for this number.</Text>
          <Btn title="Open iPhone Dialer" onPress={() => { void drive.homeHardwareDemoControls?.confirm(homeConfirmation.id); }} />
        </> : <Text accessibilityLiveRegion="polite" style={{ color: t.text }}>{
          homeDemo.result === 'requested' ? 'iPhone dialer requested. Call connection is unconfirmed.'
            : homeDemo.result === 'failed' ? 'The iPhone dialer could not be requested.'
            : homeDemo.phase === 'opening' ? 'Checking the saved contact…' : 'Diagnostic check finished.'
        }</Text> : null}
        {homeDemo && (active || homeConfirmation || homeDemo.phase === 'opening')
          ? <Btn title="Cancel demonstration" kind="ghost" onPress={() => drive.homeHardwareDemoControls?.cancel()} /> : null}
        {dialogue.finished && last && !hardware && !homeDemo ? <Text accessibilityLiveRegion="polite" style={{ color: t.text }}>Status: {' '}
          {last.handoff === 'opened' || last.handoff === 'open_failed' ? contactHandoffMessage(last.handoff) : last.simulation ? simulationCompletion(last.result, !!drive.safety.pendingDemoContact, !!dialogue.realContactDemo) : last.handoff ? contactHandoffMessage(last.handoff) : last.result.outcome === 'ok' ? 'You said you were OK.'
            : last.result.outcome === 'no_response' ? 'No confirmed answer was received. No automatic phone call was made.' : 'You said you were not OK. Follow the safety guidance above.'}
        </Text> : null}

        {dialogue.finished && hardware ? <>
          {confirmation ? <>
            <Text accessibilityRole="header" style={{ color: t.text, fontWeight: '700' }}>Confirm saved emergency contact</Text>
            <Text localize={false} selectable style={{ color: t.text }}>{confirmation.name} · {confirmation.phone}</Text>
            <Text style={{ color: t.textSecondary }}>Continuing opens the real iPhone calling interface for this number.</Text>
            <Btn title="Open iPhone Dialer" onPress={() => { void drive.hardwareTestControls?.confirm(confirmation.id); }} />
          </> : hardware.recoveryReady ? <>
            <Text accessibilityLiveRegion="polite" style={{ color: t.text }}>
              Signal recovered. Request contact handoff again to review the saved contact.
            </Text>
            <Btn title="Request contact handoff again" onPress={() => {
              void drive.hardwareTestControls?.requestRecoveredHandoff(dialogue.episodeId);
            }} />
          </> : <Text accessibilityLiveRegion="polite" style={{ color: t.text }}>
            {hardware.result === 'requested' ? 'iPhone dialer requested. Call connection is unconfirmed.'
              : hardware.result === 'failed' ? 'The iPhone dialer could not be requested.'
              : hardware.phase === 'opening' ? 'Checking the saved contact…'
              : hardware.handoffEvidence?.recovery?.permit?.result === 'blocked' ? 'Contact handoff recovery could not be authorized.'
              : blockedHandoff === 'signal_lost' ? 'Sensor signal was lost. Waiting for three consecutive strictly qualified readings.'
              : blockedHandoff ? handoffUnavailable[blockedHandoff] : 'Diagnostic check finished.'}
          </Text>}
        </> : null}
        {hardware && (active || confirmation || hardware.phase === 'opening')
          ? <Btn title="Cancel hardware test" kind="ghost" onPress={() => drive.hardwareTestControls?.cancel()} /> : null}
        {dialogue.finished && last?.simulation && !hardware && !homeDemo ? <RealContactDemoConfirmation drive={drive} /> : null}
        {dialogue.finished ? <Btn title="Close safety check" kind="ghost" onPress={() => drive.dismissSafetyConversation(dialogue.episodeId)} /> : null}
  </>;
  return <Modal visible transparent animationType="fade" onRequestClose={() => {
    if (dialogue.finished) drive.dismissSafetyConversation(dialogue.episodeId);
  }}>
    <SafeAreaView style={{ flex: 1, backgroundColor: t.background }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={{ flex: 1 }} onLayout={({ nativeEvent }) => setViewport(nativeEvent.layout.height)}>
          <View style={{ paddingHorizontal: 16, paddingVertical: compact ? 4 : 9, flexShrink: 0, flexDirection: 'row',
            flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: 10 }}>
            <View>
              <Text accessibilityRole="header" style={{ color: t.text, fontSize: compact ? 22 : 28, fontWeight: '800' }}>Sensi</Text>
              <Text style={{ color: t.textSecondary, fontSize: 13 }}>Safety check</Text>
            </View>
            {dialogue.simulation && !hardware ? <Text style={{ backgroundColor: t.warningSurface, color: t.warning, borderRadius: 10,
              overflow: 'hidden', paddingHorizontal: 9, paddingVertical: 4, fontSize: 12, fontWeight: '700' }}>Simulation</Text> : null}
            {homeDemo ? <Text style={{ color: t.textSecondary, fontSize: 12, flexBasis: '100%' }}>{homeDemo.liveEpisode
              ? 'Hardware Demo Mode · Simulated biometric abnormality' : 'Hardware Demo Mode · Simulated high HR'}</Text> : null}
            {hardware ? <Text style={{ color: t.textSecondary, fontSize: 12, flexBasis: '100%' }}>Real Hardware Safety Test</Text> : null}
            {(dialogue.realContactDemo || homeDemo) && !hardware ? <Text style={{ color: t.textSecondary, fontSize: 12, flexBasis: '100%' }}>
              Real-contact demo · iOS confirmation required
            </Text> : null}
          </View>
          <VoiceCheckListeningIndicator phase={active ? check.phase : undefined} finished={dialogue.finished}
            answerPending={answerPending} audioUnavailable={active && !!check.fallbackText} spokenMessage={spokenMessage} compact={compact} shortViewport={availableHeight < 390} />

          <SensiConversationThread messages={dialogue.simulation ? dialogue.messages.filter(message => !(message.role === 'system' && /^(?:Simulation complete\.|Noncalling simulation complete\.|Contact consent received\.)/.test(message.text))) : dialogue.messages} provisional="" compactPlayback />

          {active ? <View style={{ paddingHorizontal: 12, paddingTop: 8, gap: 6, borderTopWidth: 1, borderColor: t.border }}>
            {homeDemo?.liveEpisode && check.question === 'contact_offer' && homeDemo.testContact ? <>
              <Text localize={false} style={{ color: t.text }}>{homeDemo.testContact.name} · {homeDemo.testContact.phone}</Text>
              <Text style={{ color: t.textSecondary }}>Saying yes or tapping Yes opens the iPhone dialer and may start a real call.</Text>
            </> : null}
            <View style={{ flexDirection: stackActions ? 'column' : 'row', gap: 8 }}>
              <Btn title={hardware && check.question === 'contact_offer' ? 'Yes, review saved contact' : safetyButtonText(check.question, true)}
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
  </Modal>;
}

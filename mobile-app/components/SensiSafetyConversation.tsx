import { SafetyTypedResponse } from './SafetyTypedResponse';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Modal, SafeAreaView, Text, View, KeyboardAvoidingView, Platform } from 'react-native';
import type { useDriveSession } from '../lib/hooks/useDriveSession';
import type { AssistantMode } from '../lib/assistant/mode';
import { safetyButtonText, simulationCompletion } from '../lib/assistant/safetyConversation';
import { contactHandoffMessage } from '../modules/local-foundation-models/conversationPolicy';
import { useTheme } from '../lib/theme/ThemeProvider';
import { SensiConversationThread } from './SensiConversationThread';
import { Btn } from './ui';

type Drive = ReturnType<typeof useDriveSession>;
/** A view of VoiceCheck, never a second recognition loop or contact decision engine. */
export function SensiSafetyConversation({ drive, onContinue, standby, onStandbyClose }: {
  drive: Drive; onContinue(episodeId: string, mode: AssistantMode): void;
  standby?: ReactNode; onStandbyClose?(): void;
}) {
  const { tokens: t } = useTheme();
  const dialogue = drive.safety.conversation;
  const check = drive.safety.check;
  const pending = useRef(false);
  const [answerPending, setAnswerPending] = useState(false);
  useEffect(() => { pending.current = false; setAnswerPending(false); }, [dialogue?.episodeId, check?.question, check?.captureId]);
  // Keep one native modal host when a sensor event replaces standby. Neither
  // navigation nor the presentation transition touches the active VoiceCheck.
  if (!dialogue) return standby ? <Modal visible transparent animationType="fade" onRequestClose={onStandbyClose}>{standby}</Modal> : null;
  const active = !!check && check.episode.id === dialogue.episodeId;
  const last = drive.safety.last?.episode.id === dialogue.episodeId ? drive.safety.last : null;
  function answer(positive: boolean) {
    if (!active || pending.current || !check) return;
    const accepted = drive.respondAlert(check.question === 'contact_offer' ? positive ? 'call_yes' : 'call_no' : positive ? 'ok' : 'not_ok',
      { episodeId: dialogue!.episodeId, question: check.question, captureId: check.captureId });
    if (accepted !== false) { pending.current = true; setAnswerPending(true); }
  }
  return <Modal visible transparent animationType="fade" onRequestClose={() => {
    if (dialogue.finished) drive.dismissSafetyConversation(dialogue.episodeId);
  }}>
    <SafeAreaView style={{ flex: 1, backgroundColor: t.background }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={{ padding: 16, gap: 6 }}>
        <Text accessibilityRole="header" style={{ color: t.text, fontSize: 22, fontWeight: '800' }}>Sensi · Safety check{dialogue.simulation ? ' · Simulation' : dialogue.simulation === false ? ' · Live sensors' : ''}</Text>
        <Text style={{ color: t.textSecondary }}>Gemma on-device · Safety decisions stay on this phone</Text>
        <Text accessibilityLiveRegion="polite" style={{ color: t.text }}>{active ? check.fallbackText ? 'Audio unavailable — use the buttons below' : check.phase === 'speaking' ? 'Speaking…' : 'Listening — answer out loud or use a button' : dialogue.finished ? 'Safety check finished' : 'Finishing safety check…'}</Text>
      </View>
      {__DEV__ && dialogue.acknowledgmentSource ? <Text style={{ color: t.textSecondary, paddingHorizontal: 16 }}>Acknowledgment: {dialogue.acknowledgmentSource === 'gemma' ? 'Gemma selection' : 'deterministic fallback'}</Text> : null}
      <SensiConversationThread messages={dialogue.messages} provisional="" />
      <View style={{ padding: 16, gap: 8 }}>
        <Text style={{ color: t.textSecondary, fontSize: 13 }}>Phone handoff requires your request or agreement. Opening the phone interface does not confirm a connected call. If you need emergency help, pull over safely and call 911.</Text>
        {active ? <>
          <Btn title={safetyButtonText(check.question, true)} disabled={answerPending} onPress={() => answer(true)} />
          <Btn title={safetyButtonText(check.question, false)} kind="ghost" disabled={answerPending} onPress={() => answer(false)} />
          <SafetyTypedResponse scope={{ episodeId: dialogue.episodeId, question: check.question, captureId: check.captureId }} submit={drive.respondAlertText} />
        </> : null}
        {dialogue.finished && last ? <Text style={{ color: t.text }}>
          {last.simulation ? simulationCompletion(last.result) : last.handoff ? contactHandoffMessage(last.handoff) : last.result.outcome === 'ok' ? 'You said you were OK.'
            : last.result.outcome === 'no_response' ? 'No confirmed answer was received. No automatic phone call was made.' : 'You said you were not OK. Follow the safety guidance above.'}
        </Text> : null}

        {dialogue.finished ? <Btn title="Close safety check" kind="ghost" onPress={() => drive.dismissSafetyConversation(dialogue.episodeId)} /> : null}
      </View>
    </KeyboardAvoidingView>
    </SafeAreaView>
  </Modal>;
}

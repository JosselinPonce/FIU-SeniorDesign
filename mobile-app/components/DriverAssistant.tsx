import { useEffect, useRef, useState } from 'react';
import { AppState, BackHandler, Platform, SafeAreaView, ScrollView, Text, View } from 'react-native';
import { Btn, C } from './ui';
import * as repo from '../lib/db/repositories';
import { appAudio } from '../lib/voice/audioOwnership';
import { responsivenessProbe } from '../lib/voice/responsivenessDiagnostics';
import { ResponsivenessDiagnostics } from './ResponsivenessDiagnostics';
import { AssistantConversation, CONVERSATION_REVISION, type ConversationState } from '../modules/local-foundation-models/assistantConversation';
import { assertAssistantPlatform, assertAssistantCapabilities, selectAssistantVoice, conversationStatus, conversationMessage } from '../modules/local-foundation-models/conversationPolicy';
import { cancelDriverInterpretation, cancelLocalSpeech, cancelOfflineListening, checkDriverAssistantAvailability,
  checkOfflineSpeechCapability, interpretConversation, listLocalVoices, listenOffline, speakLocal,
  subscribeOfflineSpeechProgress, type LocalVoice } from '../modules/local-foundation-models';

type Props = { visible: boolean; onClose(): void; language: string; ownershipKey: string; contactName?: string | null;
  contactAvailability(): 'available' | 'missing_contact' | 'invalid_phone';
  captureOwnership(): () => boolean;
  handoff(text: string, offered: boolean, current: () => boolean): Promise<string> };
const initial: ConversationState = { phase: 'idle', turns: [], transcript: '', timings: {} };

export function DriverAssistant(props: Props) {
  const [state, setState] = useState(initial);
  const [voice, setVoice] = useState<LocalVoice | null>(null);
  const [support, setSupport] = useState('Checking local assistant availability…');
  const [ready, setReady] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const live = useRef(false);
  const epoch = useRef(0);
  const currentProps = useRef(props); currentProps.current = props;
  const chosen = useRef<LocalVoice | null>(null);
  const controller = useRef<AssistantConversation | null>(null);

  async function prepare() {
    const timing = responsivenessProbe('assistant', 'availability and voice checks');
    const version = epoch.current;
    assertAssistantPlatform(Platform.OS, currentProps.current.language);
    const model = await checkDriverAssistantAvailability();
    if (!model.available) throw new Error(model.message);
    const recognition = await checkOfflineSpeechCapability('en-US');
    assertAssistantCapabilities(model, recognition);
    const selected = selectAssistantVoice(await listLocalVoices(), await repo.getSetting('voice:en'));
    if (!live.current || version !== epoch.current) throw new Error('Assistant dismissed.');
    chosen.current = selected;
    timing('checks completed', { voiceId: selected.id, locale: selected.language });
    if (live.current) { setVoice(selected); setSupport('Ready when you are.'); }
  }

  useEffect(() => {
    if (!props.visible) return;
    live.current = true;
    const version = ++epoch.current;
    const ownershipKey = props.ownershipKey;
    const current = () => live.current && epoch.current === version
      && currentProps.current.visible && currentProps.current.ownershipKey === ownershipKey;
    let ownsConversation = () => true;
    let previousPhase = '';
    setReady(false); setBusy(false); setState(initial); setVoice(null); setDiagnosticsOpen(false);
    const conversation = new AssistantConversation({
      diagnostics: __DEV__,
      contactName: () => currentProps.current.contactName,
      contactAvailability: () => currentProps.current.contactAvailability(),
      prepare: async () => {
        if (!current()) throw new Error('Assistant dismissed.');
        ownsConversation = currentProps.current.captureOwnership();
        if (!ownsConversation()) throw new Error('Safety audio or driver ownership changed.');
        await prepare();
        if (!current() || !ownsConversation()) throw new Error('Driver/session changed.');
      },
      acquire: async stop => {
        const timing = responsivenessProbe('assistant', 'audio ownership');
        const release = await appAudio.acquire('optional', stop);
        timing('acquired');
        return () => { release(); timing('released'); };
      },
      speak: async (text, id) => {
        const timing = responsivenessProbe('assistant', 'playback');
        if (!current() || !ownsConversation()) throw new Error('Conversation ownership changed.');
        if (!chosen.current) throw new Error('No selected voice.');
        const result = await speakLocal(text, chosen.current.id, id);
        timing('playback returned after native cleanup', { status: result.status, voiceId: result.voiceId, nativeMs: result.elapsedMs });
        if (result.status !== 'completed' || result.voiceId !== chosen.current.id) throw new Error(`${result.reason}: ${result.message}`);
      },
      listen: async (id, progress) => {
        const timing = responsivenessProbe('assistant', 'recognition');
        const subscription = subscribeOfflineSpeechProgress(event => {
          if (event.requestId === id) {
            timing(`native ${event.phase} progress`, { nativeMs: event.elapsedMs });
            if (event.transcript) timing('first text progress received');
            progress(event.phase === 'finalizing' ? 'finalizing' : 'listening', event.transcript);
          }
        });
        try {
          const result = await listenOffline('en-US', id, 15000);
          timing('recognition returned after native cleanup', {
            locale: result.locale, onDeviceRequired: result.requiresOnDeviceRecognition,
            status: result.status, isFinal: result.isFinal, finalResultReceived: result.finalResultReceived,
            hasFinalTranscript: result.hasFinalTranscript, endpointReason: result.endpointReason,
            nativeMs: result.totalTimeMs, listeningMs: result.listeningTimeMs,
            finalizingMs: result.finalizationTimeMs, firstPartialMs: result.firstPartialTimeMs,
          });
          return result;
        }
        finally { subscription.remove(); }
      },
      interpret: async (text, context, id) => {
        const timing = responsivenessProbe('assistant', 'Foundation Models generation');
        try {
          const result = await interpretConversation(text, context, id);
          timing('generation returned', { status: result.status, nativeMs: result.processingTimeMs });
          return result;
        } finally { timing('generation promise settled'); }
      },
      cancel: async (kind, id) => {
        const timing = responsivenessProbe('assistant', `cancel ${kind}`);
        try {
          await (kind === 'speech' ? cancelLocalSpeech(id)
            : kind === 'listening' ? cancelOfflineListening(id) : cancelDriverInterpretation(id));
        } finally { timing('cancel promise settled'); }
      },
      handoff: (text, offered, requestCurrent) => currentProps.current.handoff(text, offered,
        () => current() && ownsConversation() && requestCurrent()),
      onChange: next => {
        if (current()) {
          if (next.phase !== previousPhase) {
            previousPhase = next.phase;
            responsivenessProbe('assistant', 'conversation phase')(next.phase);
          }
          setState(next);
        }
      },
    });
    controller.current = conversation;
    void prepare().then(() => { if (current()) setReady(true); })
      .catch((error: unknown) => { if (current()) setSupport(error instanceof Error ? error.message : String(error)); });
    const subscription = AppState.addEventListener('change', status => {
      if (status !== 'active') void conversation.stop().catch(() => {});
    });
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      void conversation.stop().catch(() => {}); currentProps.current.onClose(); return true;
    });
    return () => {
      back.remove();
      live.current = false;
      epoch.current += 1;
      subscription.remove();
      void conversation.stop().catch(() => {});
      if (controller.current === conversation) controller.current = null;
    };
  }, [props.visible, props.ownershipKey]);

  async function start() {
    const conversation = controller.current;
    if (!conversation || busy) return;
    setBusy(true);
    try { await conversation.start(); }
    catch (error) { if (live.current) setSupport(String(error)); }
    finally { if (live.current && controller.current === conversation) setBusy(false); }
  }
  function stop() {
    setState(value => ({ ...value, phase: 'stopping' }));
    void controller.current?.stop().catch(error => { if (live.current) setSupport(String(error)); });
  }
  function close() {
    void controller.current?.stop().catch(() => {});
    props.onClose();
  }
  if (!props.visible) return null;
  // A React overlay allows the existing native safety modal to remain above it.
  return <View style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, zIndex: 20 }}>
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
      <ScrollView contentContainerStyle={{ padding: 18, gap: 12 }}>
        <Text style={{ fontSize: 22, fontWeight: '800', color: C.ink }}>DriveSense Driver Assistant</Text>
        <Text>{support}</Text>
        <Text>This assistant offers suggestions. You decide whether to call; tap Call on your phone to connect.</Text>
        <Text>Wait for “Listening” before answering. Say “stop” while listening, or tap Stop anytime.</Text>
        <Btn title="Start conversation" disabled={!ready || busy} onPress={() => void start()} />
        {busy ? <Btn title="Stop" kind="danger" onPress={stop} /> : null}
        <Text accessibilityLiveRegion="polite">{conversationStatus(state.phase)}</Text>
        {state.message ? <Text style={{ color: state.phase === 'error' ? C.bad : C.ink }}>{conversationMessage(state.phase, state.message)}</Text> : null}
        {(state.phase === 'listening' || state.phase === 'finalizing') && state.transcript ? <Text selectable>You (still listening): {state.transcript}</Text> : null}
        {state.turns.map((turn, i) => <View key={i} style={{ gap: 5 }}>
          <Text selectable>You: {turn.driver}</Text><Text selectable>DriveSense: {turn.assistant}</Text>
        </View>)}
        {__DEV__ ? <>
          <Btn title={diagnosticsOpen ? 'Hide developer diagnostics' : 'Developer diagnostics'} kind="ghost" onPress={() => setDiagnosticsOpen(v => !v)} />
          {diagnosticsOpen ? <View style={{ gap: 8 }}>
            <ResponsivenessDiagnostics />
            <Text selectable>Running JavaScript revision: {CONVERSATION_REVISION}</Text>
            <Text>Native prompt changes require a rebuilt development app. This revision identifies JavaScript only.</Text>
            <Text>Diagnostics are held in memory for this conversation; they are not saved or uploaded.</Text>
            <Text>Voice: {voice ? `${voice.name} · ${voice.quality} · ${voice.language}` : '—'}</Text>
            <Text selectable>Internal state: {state.phase} · {state.message ?? ''}</Text>
            {(state.decisions ?? []).map((decision, i) => <Text selectable key={`decision-${i}`}>{JSON.stringify(decision, null, 2)}</Text>)}
            {state.turns.map((turn, i) => turn.fallback ? <Text key={`fallback-${i}`}>Turn {i + 1}: safety reply selected · {turn.fallbackReason}</Text> : null)}
            {(state.recognitionAttempts ?? []).map(({ turn, attempt, result }, i) => <View key={`recognition-${i}`} style={{ gap: 4 }}>
              <Text selectable>Recognition · turn {turn}, attempt {attempt}: {result.status} · {result.reason}</Text>
              <Text selectable>Final callback: {String(result.finalResultReceived ?? 'unknown')} · nonempty final: {String(result.hasFinalTranscript ?? 'unknown')}</Text>
              <Text selectable>Partial: {result.partialTranscript ?? '—'}</Text>
              <Text selectable>Final: {result.finalTranscript ?? '—'}</Text>
              <Text selectable>Endpoint: {result.endpointReason} · listening: {Math.round(result.listeningTimeMs)} ms · finalizing: {Math.round(result.finalizationTimeMs)} ms · total: {Math.round(result.totalTimeMs)} ms</Text>
              <Text selectable>{JSON.stringify(result, null, 2)}</Text>
            </View>)}
            <Text selectable>Interpretation: {JSON.stringify(state.interpretation ?? null, null, 2)}</Text>
            <Text selectable>Timing (ms): {JSON.stringify(state.timings)}</Text>
            <Text>End-to-end offline behavior remains unverified until physical iPhone testing with network access disabled.</Text>
          </View> : null}
        </> : null}
        <Btn title="Close assistant" kind="ghost" onPress={close} />
      </ScrollView>
    </SafeAreaView>
  </View>;
}

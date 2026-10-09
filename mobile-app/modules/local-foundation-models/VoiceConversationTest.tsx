import { useEffect, useRef, useState } from 'react';
import { AppState, Pressable, Text, View } from 'react-native';
import * as Speech from 'expo-speech';
import { ExpoSpeechRecognitionModule } from 'expo-speech-recognition';
import { Btn, C } from '../../components/ui';
import {
  cancelDriverInterpretation, cancelLocalSpeech, cancelOfflineListening,
  checkFoundationModelsAvailability, checkOfflineSpeechCapability, interpretDriverResponse,
  listLocalVoices, listenOffline, speakLocal, subscribeOfflineSpeechProgress,
  type DriverInterpretationResponse, type LocalVoice, type OfflineTranscription,
} from './index';
import { finalTranscript, safeSpokenReply } from './conversationPolicy';

const QUESTION = 'Are you feeling okay? Please tell me how you feel.';
const PREVIEW = 'This is the voice for the local driving assistant test.';
type Phase = 'idle' | 'checking prerequisites' | 'previewing voice' | 'speaking question'
  | 'listening' | 'finalizing' | 'interpreting' | 'speaking response'
  | 'complete' | 'error' | 'stopping' | 'cancelled';
type Operation = {
  id: string;
  cancelled: boolean;
  resource: 'none' | 'playback' | 'capture' | 'inference';
  resourceId: string;
  cancellation: Promise<void>;
};

export function VoiceConversationTest(props: {
  disabled: boolean; tryBegin: () => boolean; onBusyChange: (busy: boolean) => void;
}) {
  const [voices, setVoices] = useState<LocalVoice[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState('');
  const [recognition, setRecognition] = useState<OfflineTranscription | null>(null);
  const [interpretation, setInterpretation] = useState<DriverInterpretationResponse | null>(null);
  const [reply, setReply] = useState('');
  const [times, setTimes] = useState<Record<string, number>>({});
  const active = useRef<Operation | null>(null);
  const mounted = useRef(true);
  const sequence = useRef(0);
  const progressSubscription = useRef<{ remove(): void } | null>(null);
  const ownerCallback = useRef(props.onBusyChange);
  ownerCallback.current = props.onBusyChange;
  const selectedVoice = voices.find(voice => voice.id === selectedId);

  function stop() {
    const operation = active.current;
    if (!operation || operation.cancelled) return;
    operation.cancelled = true;
    if (mounted.current) setPhase('stopping');
    const cancel = operation.resource === 'playback' ? cancelLocalSpeech
      : operation.resource === 'capture' ? cancelOfflineListening
      : operation.resource === 'inference' ? cancelDriverInterpretation : null;
    if (cancel) {
      operation.cancellation = cancel(operation.resourceId).catch((cause: unknown) => {
        if (mounted.current && active.current === operation) setError(`Cancellation failed: ${String(cause)}`);
      });
    }
  }

  useEffect(() => {
    let alive = true;
    mounted.current = true;
    void listLocalVoices().then(available => {
      if (alive) { setVoices(available); setSelectedId(available[0]?.id ?? ''); }
    }).catch((cause: unknown) => { if (alive) setError(String(cause)); });
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'background') stop();
    });
    return () => {
      alive = false;
      mounted.current = false;
      subscription.remove();
      progressSubscription.current?.remove();
      progressSubscription.current = null;
      stop();
    };
  }, []);

  async function run(mode: 'conversation' | 'preview' | 'refresh') {
    if (active.current || props.disabled || !props.tryBegin()) return;
    const operation: Operation = {
      id: `conversation-${Date.now()}-${++sequence.current}`, cancelled: false,
      resource: 'none', resourceId: '', cancellation: Promise.resolve(),
    };
    active.current = operation;
    const started = performance.now();
    const timing: Record<string, number> = {};
    const current = () => mounted.current && active.current === operation && !operation.cancelled;
    const assertCurrent = () => { if (!current()) throw new Error('Voice test cancelled.'); };
    async function measured<T>(key: string, action: () => Promise<T>): Promise<T> {
      const at = performance.now();
      try { return await action(); }
      finally {
        timing[key] = performance.now() - at;
        if (current()) setTimes({ ...timing });
      }
    }
    async function playback(text: string, stage: 'question' | 'response' | 'preview') {
      assertCurrent();
      operation.resource = 'playback';
      operation.resourceId = `${operation.id}-${stage}`;
      const result = await measured(`${stage}PlaybackMs`, () => speakLocal(text, selectedId, operation.resourceId));
      assertCurrent();
      operation.resource = 'none';
      if (result.status !== 'completed' || result.voiceId !== selectedId) {
        throw new Error(`${result.reason}: ${result.message}`);
      }
    }
    setBusy(true);
    setError(null);
    setPhase('checking prerequisites');
    setTranscript('');
    setRecognition(null);
    setInterpretation(null);
    setReply('');
    setTimes({});
    try {
      const availableVoices = await listLocalVoices();
      assertCurrent();
      setVoices(availableVoices);
      if (mode === 'refresh') {
        setSelectedId(availableVoices.some(voice => voice.id === selectedId) ? selectedId : availableVoices[0]?.id ?? '');
        setPhase('complete');
        return;
      }
      if (!availableVoices.some(voice => voice.id === selectedId)) {
        throw new Error('Select an installed en-US Apple voice. Refresh voices if needed.');
      }
      const [speaking, recognitionState] = await Promise.all([
        Speech.isSpeakingAsync(), ExpoSpeechRecognitionModule.getStateAsync(),
      ]);
      assertCurrent();
      if (speaking || recognitionState !== 'inactive') throw new Error('Another speech operation is active; test refused.');
      if (mode === 'preview') {
        setPhase('previewing voice');
        await playback(PREVIEW, 'preview');
        setPhase('complete');
        return;
      }
      const [model, support] = await Promise.all([
        checkFoundationModelsAvailability(), checkOfflineSpeechCapability('en-US'),
      ]);
      assertCurrent();
      if (!model.available) throw new Error(`${model.reason}: ${model.message}`);
      if (!support.supportsOnDeviceRecognition || !support.recognizerAvailable) {
        throw new Error(`${support.reason}: ${support.message}`);
      }
      setPhase('speaking question');
      await playback(QUESTION, 'question'); // didFinish + audio cleanup before capture
      assertCurrent();
      progressSubscription.current = subscribeOfflineSpeechProgress(progress => {
        if (current() && progress.requestId === `${operation.id}-capture`) {
          setPhase(progress.phase === 'finalizing' ? 'finalizing' : 'listening');
          setTranscript(progress.transcript);
        }
      });
      operation.resource = 'capture';
      operation.resourceId = `${operation.id}-capture`;
      setPhase('listening');
      const captured = await measured('recognitionTotalMs', () => listenOffline('en-US', operation.resourceId));
      assertCurrent();
      operation.resource = 'none';
      progressSubscription.current.remove();
      progressSubscription.current = null;
      setRecognition(captured);
      setTranscript(captured.transcript);
      timing.listeningMs = captured.listeningTimeMs;
      timing.finalizingMs = captured.finalizationTimeMs;
      const text = finalTranscript(captured); // refuses every nonfinal/error envelope
      setPhase('interpreting');
      operation.resource = 'inference';
      operation.resourceId = `${operation.id}-inference`;
      const understood = await measured('inferenceTotalMs', () => interpretDriverResponse(text, operation.resourceId));
      assertCurrent();
      operation.resource = 'none';
      setInterpretation(understood);
      timing.inferenceNativeMs = understood.processingTimeMs;
      if (understood.status !== 'success') throw new Error(`${understood.error.code}: ${understood.error.message}`);
      const spokenReply = safeSpokenReply(understood.interpretation, text);
      setReply(spokenReply);
      setPhase('speaking response');
      await playback(spokenReply, 'response');
      assertCurrent();
      setPhase('complete');
    } catch (cause) {
      if (current()) {
        setPhase('error');
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      // Stage promises only resolve after native cleanup. Keep the launcher lease
      // during cooperative inference cancellation and pending cancellation delivery.
      await operation.cancellation;
      progressSubscription.current?.remove();
      progressSubscription.current = null;
      if (active.current === operation) active.current = null;
      if (mounted.current) {
        setBusy(false);
        setTimes({ ...timing, totalInteractionMs: performance.now() - started });
        if (operation.cancelled) setPhase('cancelled');
      }
      ownerCallback.current(false);
    }
  }

  if (!__DEV__) return null;
  return (
    <View style={{ gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: '700', color: C.ink }}>Local Voice Conversation Test</Text>
      <Text>Advisory only. No calls or emergency actions. End-to-end offline operation remains unverified until Airplane Mode testing.</Text>
      <Text>Question: {QUESTION}</Text>
      <Text>Allow permission prompts first. Answer after question playback, when listening and the microphone indicator is visible.</Text>
      <Text selectable>Selected voice: {selectedVoice ? `${selectedVoice.name} · ${selectedVoice.quality} · ${selectedVoice.language}\n${selectedVoice.id}` : 'No en-US voice selected.'}</Text>
      <Btn title="Refresh installed Apple voices" disabled={busy || props.disabled} onPress={() => void run('refresh')} />
      {voices.map(voice => (
        <Pressable key={voice.id} disabled={busy || props.disabled} onPress={() => setSelectedId(voice.id)}
          accessibilityRole="radio" accessibilityState={{ selected: selectedId === voice.id }}
          style={{ padding: 10, borderWidth: 1, borderColor: selectedId === voice.id ? C.brand : C.line }}>
          <Text>{selectedId === voice.id ? '● ' : '○ '}{voice.name} · {voice.quality}</Text>
        </Pressable>
      ))}
      <Text>Only voices enumerated by Apple for this app are listed. Standard voices remain available as a fallback when listed.</Text>
      <Btn title="Preview selected voice" disabled={busy || props.disabled || !selectedVoice} onPress={() => void run('preview')} />
      <Btn title="Start Voice Test" disabled={busy || props.disabled || !selectedVoice} onPress={() => void run('conversation')} />
      {busy ? <Btn title="Stop / Cancel Voice Test" kind="ghost" onPress={stop} /> : null}
      <Text accessibilityLiveRegion="polite">State: {phase}</Text>
      <Text selectable>Transcript ({recognition?.status === 'success' && recognition.isFinal ? 'final' : 'partial / incomplete'}): {transcript || '—'}</Text>
      <Text selectable>Spoken reply: {reply || '—'}</Text>
      <Text selectable>Structured AI interpretation: {interpretation ? JSON.stringify(interpretation, null, 2) : '—'}</Text>
      <Text selectable>Recognition result: {recognition ? JSON.stringify(recognition, null, 2) : '—'}</Text>
      <Text selectable>Stage timing (milliseconds): {JSON.stringify(Object.fromEntries(Object.entries(times).map(([key, value]) => [key, Math.round(value)])), null, 2)}</Text>
      {error !== null ? <Text selectable style={{ color: C.bad }}>{error}</Text> : null}
    </View>
  );
}

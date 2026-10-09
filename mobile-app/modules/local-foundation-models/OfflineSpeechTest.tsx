import { useEffect, useRef, useState } from 'react';
import { AppState, Text, View } from 'react-native';
import * as Speech from 'expo-speech';
import { ExpoSpeechRecognitionModule } from 'expo-speech-recognition';
import { Btn, C } from '../../components/ui';
import {
  cancelOfflineListening, checkOfflineSpeechCapability, listenOffline, subscribeOfflineSpeechProgress,
  type OfflineSpeechCapability, type OfflineSpeechProgress, type OfflineTranscription,
} from './index';

const LOCALE = 'en-US';

/** Standalone transcription diagnostic. Never passes audio/text to the AI. */
export function OfflineSpeechTest(props: { disabled: boolean; tryBegin: () => boolean; onBusyChange: (busy: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState('idle');
  const [capability, setCapability] = useState<OfflineSpeechCapability | null>(null);
  const [transcription, setTranscription] = useState<OfflineTranscription | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<OfflineSpeechProgress | null>(null);
  const progressSubscription = useRef<{ remove(): void } | null>(null);
  const mounted = useRef(true);
  const active = useRef<{ id: string; cancelled: boolean; nativeStarted: boolean } | null>(null);
  const sequence = useRef(0);
  const ownerCallback = useRef(props.onBusyChange);
  ownerCallback.current = props.onBusyChange;

  function stop() {
    const request = active.current;
    if (!request || request.cancelled) return;
    request.cancelled = true;
    if (mounted.current) setPhase('stopping');
    if (request.nativeStarted) {
      void cancelOfflineListening(request.id).catch((cause: unknown) => {
        if (mounted.current && active.current === request) setError(`Cancellation failed: ${String(cause)}`);
      });
    }
  }

  useEffect(() => {
    mounted.current = true;
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'background') stop();
    });
    return () => {
      mounted.current = false;
      subscription.remove();
      progressSubscription.current?.remove();
      progressSubscription.current = null;
      stop();
    };
  }, []);

  async function run(listen: boolean) {
    if (active.current || props.disabled || !props.tryBegin()) return;
    const request = { id: `speech-${Date.now()}-${++sequence.current}`, cancelled: false, nativeStarted: false };
    const current = () => mounted.current && active.current === request && !request.cancelled;
    active.current = request;
    ownerCallback.current(true);
    setBusy(true);
    setPhase('checking');
    setError(null);
    setTranscription(null);
    setProgress(null);
    try {
      const support = await checkOfflineSpeechCapability(LOCALE);
      if (!current()) return;
      setCapability(support);
      if (!support.supportsOnDeviceRecognition || !support.recognizerAvailable) {
        setPhase('unavailable');
        setError(support.message);
        return;
      }
      if (!listen) { setPhase('supported'); return; }
      // Read-only guards; do not stop or reconfigure another audio owner.
      const [speaking, recognitionState] = await Promise.all([
        Speech.isSpeakingAsync(), ExpoSpeechRecognitionModule.getStateAsync(),
      ]);
      if (!current()) return;
      if (speaking || recognitionState !== 'inactive') {
        throw new Error('Existing speech playback or recognition is active. Offline capture refused.');
      }
      progressSubscription.current = subscribeOfflineSpeechProgress(event => {
        if (current() && event.requestId === request.id) {
          setPhase(event.phase);
          setProgress(event);
        }
      });
      setPhase('preparing (allow permissions if prompted)');
      request.nativeStarted = true;
      const response = await listenOffline(LOCALE, request.id);
      if (!mounted.current || active.current !== request) return;
      if (request.cancelled) {
        // A user stop can race Apple's final callback. Preserve only a cancelled
        // envelope; never publish successful output after consent to capture ended.
        setTranscription({ ...response, status: 'cancelled', isFinal: false,
          reason: 'cancelled', message: 'Capture cancelled; any transcript is incomplete.' });
        return;
      }
      setTranscription(response);
      setPhase(response.status === 'success' ? 'complete' : response.status);
      if (response.status !== 'success' && response.status !== 'cancelled') setError(`${response.reason}: ${response.message}`);
    } catch (cause) {
      if (current()) {
        setPhase('error');
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      progressSubscription.current?.remove();
      progressSubscription.current = null;
      if (active.current === request) active.current = null;
      if (mounted.current) {
        setBusy(false);
        if (request.cancelled) setPhase('cancelled');
      }
      // Unlock the launcher only after the native promise resolves after cleanup.
      ownerCallback.current(false);
    }
  }

  if (!__DEV__) return null;
  return (
    <View style={{ gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: '700', color: C.ink }}>Offline Speech Test · en-US</Text>
      <Text>No AI interpretation or speech playback. On-device recognition is required. Finalization behavior still needs device testing.</Text>
      <Btn title="Check en-US offline support" busy={busy} disabled={props.disabled} onPress={() => void run(false)} />
      <Btn title="Test Offline Transcription" disabled={busy || props.disabled} onPress={() => void run(true)} />
      {busy ? <Btn title="Stop / Cancel transcription" kind="ghost" onPress={stop} /> : null}
      <Text accessibilityLiveRegion="polite">State: {phase}</Text>
      <Text selectable>{capability ? JSON.stringify(capability, null, 2) : 'Support not checked.'}</Text>
      <Text selectable>Transcript ({transcription?.isFinal ? 'final' : 'partial / incomplete'}): {transcription?.transcript || progress?.transcript || '—'}</Text>
      {progress ? <Text selectable>
        Elapsed: {Math.round(progress.elapsedMs)} ms · Audio: {progress.audioLevelDb.toFixed(1)} dBFS · Activity threshold: {progress.activityThresholdDb.toFixed(1)} dBFS{ '\n' }
        Since last audio activity: {Math.round(progress.silenceMs)} ms · Measured activity: {Math.round(progress.measuredActivityMs)} ms · Endpoint: {progress.endpointReason}
      </Text> : null}
      {transcription ? <Text selectable>Listening: {Math.round(transcription.listeningTimeMs)} ms · Finalizing: {Math.round(transcription.finalizationTimeMs)} ms · Total: {Math.round(transcription.totalTimeMs)} ms</Text> : null}
      <Text selectable>{transcription ? JSON.stringify(transcription, null, 2) : 'No transcription result.'}</Text>
      {error !== null ? <Text selectable style={{ color: C.bad }}>{error}</Text> : null}
    </View>
  );
}

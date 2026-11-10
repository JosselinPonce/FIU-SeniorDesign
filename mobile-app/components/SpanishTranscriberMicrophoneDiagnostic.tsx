import { useEffect, useRef, useState } from 'react';
import { AppState, Text, View } from 'react-native';
import { useTheme } from '../lib/theme/ThemeProvider';
import { appAudio } from '../lib/voice/audioOwnership';
import { cancelSpanishOfflineTranscription, subscribeSpanishTranscriberTestProgress,
  testSpanishOfflineTranscription, type SpanishTranscriptionTestResult } from '../modules/local-foundation-models';
import { Btn } from './ui';

type Run = { id: string; cancelled: boolean; pending?: Promise<SpanishTranscriptionTestResult>; done: Promise<void> };

/** Explicit, isolated microphone experiment; never supplies recognition evidence to VoiceCheck. */
export function SpanishTranscriberMicrophoneDiagnostic({ blocked }: { blocked: boolean }) {
  const { tokens } = useTheme();
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState('Idle');
  const [report, setReport] = useState<SpanishTranscriptionTestResult | null>(null);
  const [error, setError] = useState('');
  const current = useRef<Run | null>(null);
  const alive = useRef(true);
  const blockedNow = useRef(blocked);
  blockedNow.current = blocked;

  async function stop() {
    const run = current.current;
    if (!run) return;
    run.cancelled = true;
    if (run.pending) await cancelSpanishOfflineTranscription(run.id);
    await run.done;
  }
  function requestStop() {
    void stop().catch(cause => { if (alive.current) setError(String(cause)); });
  }
  useEffect(() => {
    alive.current = true;
    const subscription = AppState.addEventListener('change', state => { if (state === 'background') requestStop(); });
    return () => { alive.current = false; subscription.remove(); requestStop(); };
  }, []);
  useEffect(() => { if (blocked) requestStop(); }, [blocked]);

  async function start() {
    if (!__DEV__ || current.current || blockedNow.current) return;
    let complete!: () => void;
    const run: Run = { id: `spanish-test-${Date.now()}`, cancelled: false,
      done: new Promise<void>(resolve => { complete = resolve; }) };
    current.current = run;
    setBusy(true); setPhase('Preparing'); setReport(null); setError('');
    let release: (() => void) | undefined;
    let subscription: { remove(): void } | undefined;
    let cleanupFailed = false;
    try {
      release = await appAudio.acquire('optional', stop);
      if (run.cancelled || blockedNow.current || !alive.current) return;
      subscription = subscribeSpanishTranscriberTestProgress(event => {
        if (event.requestId === run.id && alive.current && !run.cancelled) {
          setPhase(event.phase === 'recording' ? 'Recording for 5 seconds — say “Sí, estoy bien.”'
            : event.phase === 'finalizing' ? 'Finalizing transcription' : 'Preparing');
        }
      });
      run.pending = testSpanishOfflineTranscription(run.id);
      const result = await run.pending;
      cleanupFailed = !!result.cleanupErrors?.length;
      if (alive.current) {
        setReport(result);
        setPhase(result.status);
        if (cleanupFailed) setError('Native cleanup failed. Audio ownership is retained; restart the app before another speech operation.');
      }
    } catch (cause) {
      if (alive.current) { setError(cause instanceof Error ? cause.message : String(cause)); setPhase('Error'); }
    } finally {
      subscription?.remove();
      if (!cleanupFailed) release?.();
      if (current.current === run) current.current = null;
      complete();
      if (alive.current) setBusy(false);
    }
  }

  if (!__DEV__) return null;
  return <View style={{ gap: 6 }}>
    <Btn title="Test Spanish offline transcription" disabled={blocked || busy} onPress={() => void start()} />
    <Text style={{ color: tokens.textSecondary }}>While parked, enable airplane mode and turn Wi-Fi off to verify offline operation. This action may request microphone permission, then records for 5 seconds. Say “Sí, estoy bien” when Recording appears. No model downloads, saved recordings, contacts or calls. The test times out after 20 seconds.</Text>
    <Btn title="Cancel Spanish transcription test" kind="ghost" disabled={!busy} onPress={requestStop} />
    <Text accessibilityLiveRegion="polite" style={{ color: tokens.textSecondary }}>{phase}</Text>
    {error ? <Text selectable style={{ color: tokens.textSecondary }}>{error}</Text> : null}
    {report ? <>
      <Text selectable style={{ color: tokens.textSecondary }}>Finalized transcription: {report.transcript || '(none)'}</Text>
      <Text style={{ color: tokens.textSecondary }}>Preparation: {report.preparationTimeMs === undefined ? 'Unknown' : `${Math.round(report.preparationTimeMs)} ms`} · Recognition: {report.recognitionTimeMs === undefined ? 'Unknown' : `${Math.round(report.recognitionTimeMs)} ms`}</Text>
      <Text selectable style={{ color: tokens.textSecondary }}>{JSON.stringify(report, null, 2)}</Text>
    </> : null}
  </View>;
}

import { ScreenHeader } from '../../components/ScreenHeader';
import { useEffect, useRef, useState } from 'react';
import { AppState, BackHandler, Platform, SafeAreaView, ScrollView, Text, View } from 'react-native';
import { Btn } from '../../components/ui';
import { useTheme } from '../../lib/theme/ThemeProvider';
import { GEMMA_ARTIFACT, TEST_PROMPT } from './artifact';
import { gemmaPoc } from './phone';
import type { DiagnosticReport } from './contextualDiagnostic';
const contextual = __DEV__ ? require('./contextualDiagnostic') as typeof import('./contextualDiagnostic') : null;
const memory = __DEV__ ? require('./diagnosticMemory') as typeof import('./diagnosticMemory') : null;

export function GemmaDiagnostic({ blocked, onClose }: { blocked: boolean; onClose(): void }) {
  const { tokens: t } = useTheme();
  const [state, setState] = useState(gemmaPoc.state);
  const [closing, setClosing] = useState(false);
  const live = useRef(false);
  const evaluationPending = useRef(false);
  const closingRef = useRef(false);
  const blockedRef = useRef(blocked); blockedRef.current = blocked;
  const [evaluationBusy, setEvaluationBusy] = useState(false);
  const [report, setReport] = useState<DiagnosticReport | null>(null);
  const [evaluationError, setEvaluationError] = useState('');
  const [runner] = useState(() => contextual && memory ? new contextual.ContextualGemmaDiagnostic(gemmaPoc, {
    current: () => live.current && !blockedRef.current && AppState.currentState === 'active',
    memory: memory.readGemmaDiagnosticMemory, now: () => performance.now(), osVersion: String(Platform.Version),
  }) : null);
  useEffect(() => {
    live.current = true;
    const unsubscribe = gemmaPoc.subscribe(setState);
    const app = AppState.addEventListener('change', status => { if (status !== 'active') { runner?.cancel(); void gemmaPoc.dispose(); } });
    const back = BackHandler.addEventListener('hardwareBackPress', () => { runner?.cancel(); void gemmaPoc.dispose(); return true; });
    return () => { live.current = false; runner?.cancel(); unsubscribe(); app.remove(); back.remove(); void gemmaPoc.dispose(); };
  }, [runner]);
  useEffect(() => { if (blocked) { runner?.cancel(); void gemmaPoc.dispose(); } }, [blocked, runner]);
  if (!__DEV__) return null;
  const disabled = blocked || closing || state.busy || evaluationBusy;
  const act = (action: () => Promise<void>) => { void action().catch(() => {}); };
  return <SafeAreaView style={{ flex: 1, backgroundColor: t.background }}>
    <ScreenHeader title="Gemma diagnostics" onBack={() => {
      if (closingRef.current) return;
      closingRef.current = true; setClosing(true); runner?.cancel();
      void gemmaPoc.dispose().then(() => {
        if (!gemmaPoc.state.loaded && !gemmaPoc.state.busy) onClose();
      }).finally(() => { closingRef.current = false; if (live.current) setClosing(false); });
    }} />
    <ScrollView contentContainerStyle={{ padding: 20, gap: 12 }} style={{ backgroundColor: t.background }}>
    <Text accessibilityRole="header" style={{ color: t.text, fontSize: 22 }}>Gemma · isolated development test</Text>
    <Text style={{ color: t.textSecondary }}>No microphone, TTS, sensor decisions, or phone actions. Generated output is diagnostic only. Download only after accepting the Gemma terms at ai.google.dev/gemma/terms.</Text>
    {blocked ? <Text style={{ color: t.text }}>Unavailable during a drive or safety check. Cleanup has been requested.</Text> : null}
    <Text style={{ color: t.text }}>{state.phase} · Model verified: {state.installed ? 'yes' : 'no'} · Loaded: {state.loaded ? 'yes' : 'no'}</Text>
    {state.progress ? <Text accessibilityLiveRegion="polite" style={{ color: t.text }}>
      {state.progress.stage === 'download' ? 'Downloaded' : 'SHA-256 checked'} {(state.progress.completed / 1_000_000).toFixed(1)} / {(state.progress.total / 1_000_000).toFixed(1)} MB
      {' · '}{Math.min(100, state.progress.completed / state.progress.total * 100).toFixed(1)}%{' · '}{Math.round(state.progress.elapsedMs / 1000)} s
    </Text> : null}
    <Text selectable style={{ color: t.textSecondary }}>{GEMMA_ARTIFACT.filename} · 241 MB{`\n`}SHA-256: {GEMMA_ARTIFACT.sha256}</Text>
    <Btn title="Check installed model (verify checksum)" disabled={disabled || state.loaded} onPress={() => act(() => gemmaPoc.check())} />
    <Btn title="Accept terms and download approved model" disabled={disabled || state.loaded} onPress={() => act(() => gemmaPoc.provision())} />
    <Btn title="Initialize model" disabled={disabled || state.loaded} onPress={() => act(() => gemmaPoc.load())} />
    <Text style={{ color: t.text }}>Fixed prompt: {TEST_PROMPT}</Text>
    <Btn title="Run fixed acknowledgment test" disabled={disabled || !state.loaded} onPress={() => act(() => gemmaPoc.run())} />
    <Text style={{ color: t.text }}>Contextual evaluation: 12 fixed English/Spanish fixtures; synthetic NOT OK events only. No live driver data. Unload first. Eligible fixtures verify, load, infer and release through the production controller. Omitted statements skip inference and use fixed fallback. Results stay in RAM; copy the selectable JSON before leaving.</Text>
    <Btn title="Run contextual English + Spanish suite" disabled={disabled || state.loaded || !runner} onPress={() => {
      if (!runner || evaluationPending.current || closingRef.current || !live.current || blockedRef.current) return;
      evaluationPending.current = true;
      setEvaluationBusy(true); setReport(null); setEvaluationError('');
      void runner.run(value => { if (live.current) setReport(value); })
        .then(value => { if (live.current && value.status === 'cancelled') setReport(value); })
        .catch(() => { if (live.current) setEvaluationError('Suite could not start. Unload the idle model and retry in the foreground.'); })
        .finally(() => { evaluationPending.current = false; if (live.current) setEvaluationBusy(false); });
    }} />
    {evaluationError ? <Text style={{ color: t.text }}>{evaluationError}</Text> : null}
    {report && contextual ? <View style={{ gap: 8 }}>
      <Text style={{ color: t.text }}>Suite: {report.status}. Grammar acceptance is not proof of bilingual quality or VoiceCheck readiness.</Text>
      {(['en', 'es'] as const).map(language => {
        const all = contextual.diagnosticSummary(report.rows, language);
        const grounded = contextual.diagnosticSummary(report.rows, language, 'grounded');
        return <Text key={language} style={{ color: t.text }}>{language}: accepted {all.accepted}/{all.attempted} inference attempts; skipped {all.skipped}/{all.cases} cases; returned output {all.completedOutput}; grounded acceptance {grounded.accepted}/{grounded.attempted}. Planned: 6 cases, 3 eligible per language.</Text>;
      })}
      <Text style={{ color: t.textSecondary }}>Memory values are whole-process snapshots, never peak native/model memory. Operation timings exclude memory sampling. Initialization excludes file verification; load includes it. Release is a controller-call duration. This suite does not reproduce guidance playback or the five-second presentation window.</Text>
      <Text selectable style={{ color: t.text }}>{JSON.stringify(report, null, 2)}</Text>
    </View> : null}
    {state.busy || evaluationBusy ? <Btn title="Cancel operation" onPress={() => { if (evaluationBusy) runner?.cancel(); else gemmaPoc.cancel(); }} /> : null}
    <Btn title="Unload model safely" disabled={closing || evaluationBusy || (!state.loaded && !state.busy)} onPress={() => act(() => gemmaPoc.dispose())} />
    <View style={{ gap: 8 }}>
      <Text style={{ color: t.text }}>Loading: {state.loadMs ?? '—'} ms · Inference: {state.inferenceMs ?? '—'} ms</Text>
      <Text selectable style={{ color: t.text }}>Generated response: {state.response || '—'}</Text>
      {state.error ? <Text accessibilityRole="alert" selectable style={{ color: t.text }}>Error: {state.error}</Text> : null}
    </View>

  </ScrollView></SafeAreaView>;
}

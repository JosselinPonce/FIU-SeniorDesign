import { ScreenHeader } from '../../components/ScreenHeader';
import { useEffect, useRef, useState } from 'react';
import { AppState, BackHandler, Platform, SafeAreaView, ScrollView, Text, View } from 'react-native';
import { Btn } from '../../components/ui';
import { SettingsGroup } from '../../components/SettingsGroup';
import { DiagnosticDetails, DiagnosticResult } from '../../components/DiagnosticUI';
import { useTheme } from '../../lib/theme/ThemeProvider';
import { GEMMA_ARTIFACT, TEST_PROMPT } from './artifact';
import { gemmaPoc, isGemmaRuntimeProtected } from './phone';
import type { DiagnosticReport } from './contextualDiagnostic';
const contextual = __DEV__ ? require('./contextualDiagnostic') as typeof import('./contextualDiagnostic') : null;
const memory = __DEV__ ? require('./diagnosticMemory') as typeof import('./diagnosticMemory') : null;

function disposeDiagnosticRuntime() {
  return isGemmaRuntimeProtected() ? Promise.resolve() : gemmaPoc.dispose();
}

export function GemmaDiagnostic({ blocked, onClose }: { blocked: boolean; onClose(): void }) {
  const { tokens: t } = useTheme();
  const [state, setState] = useState(gemmaPoc.state);
  const [closing, setClosing] = useState(false);
  const live = useRef(false);
  const evaluationPending = useRef(false);
  const closingRef = useRef(false);
  const blockedRef = useRef(blocked); blockedRef.current = blocked;
  const [evaluationBusy, setEvaluationBusy] = useState(false);
  const [reports, setReports] = useState<Partial<Record<'baseline' | 'conversational', DiagnosticReport>>>({});
  const [evaluationError, setEvaluationError] = useState('');
  const releaseObserved = useRef(false);
  const [releaseResult, setReleaseResult] = useState<'PASS' | 'FAIL' | 'NOT TESTED' | 'RUNNING'>('NOT TESTED');
  const [runner] = useState(() => contextual && memory ? new contextual.ContextualGemmaDiagnostic(gemmaPoc, {
    current: () => live.current && !blockedRef.current && !isGemmaRuntimeProtected() && AppState.currentState === 'active',
    memory: memory.readGemmaDiagnosticMemory, now: () => performance.now(), osVersion: String(Platform.Version),
  }) : null);
  useEffect(() => {
    live.current = true;
    const unsubscribe = gemmaPoc.subscribe(next => {
      if (next.busy && next.loaded && next.phase === 'Unloading model') { releaseObserved.current = true; setReleaseResult('RUNNING'); }
      if (!next.busy && releaseObserved.current) {
        releaseObserved.current = false;
        setReleaseResult(!next.loaded && !next.cleanupRequired && !next.error ? 'PASS' : 'FAIL');
      }
      setState(next);
    });
    const app = AppState.addEventListener('change', status => { if (status !== 'active') { runner?.cancel(); void disposeDiagnosticRuntime(); } });
    const back = BackHandler.addEventListener('hardwareBackPress', () => { runner?.cancel(); void disposeDiagnosticRuntime(); return true; });
    return () => { live.current = false; runner?.cancel(); unsubscribe(); app.remove(); back.remove(); void disposeDiagnosticRuntime(); };
  }, [runner]);
  useEffect(() => { if (blocked) { runner?.cancel(); void disposeDiagnosticRuntime(); } }, [blocked, runner]);
  if (!__DEV__) return null;
  const protectedRuntime = isGemmaRuntimeProtected();
  const disabled = blocked || closing || state.busy || evaluationBusy || protectedRuntime;
  const act = (action: () => Promise<void>) => { if (!isGemmaRuntimeProtected()) void action().catch(() => {}); };
  return <SafeAreaView style={{ flex: 1, backgroundColor: t.background }}>
    <ScreenHeader title="Gemma diagnostics" onBack={() => {
      if (closingRef.current) return;
      closingRef.current = true; setClosing(true); runner?.cancel();
      void disposeDiagnosticRuntime().then(() => {
        if (isGemmaRuntimeProtected() || !gemmaPoc.state.loaded && !gemmaPoc.state.busy) onClose();
      }).finally(() => { closingRef.current = false; if (live.current) setClosing(false); });
    }} />
    <ScrollView contentContainerStyle={{ padding: 20, gap: 12 }} style={{ backgroundColor: t.background }}>
    <Text accessibilityRole="header" style={{ color: t.text, fontSize: 22 }}>Gemma · isolated development test</Text>
    <Text style={{ color: t.textSecondary }}>No microphone, TTS, sensor decisions, or phone actions. Generated output is diagnostic only. Download only after accepting the Gemma terms at ai.google.dev/gemma/terms.</Text>
    {blocked ? <Text style={{ color: t.text }}>Unavailable during a drive or safety check. Cleanup has been requested.</Text> : null}
    {protectedRuntime ? <Text style={{ color: t.textSecondary }}>Stop the prepared Gemma session in Settings before running diagnostics.</Text> : null}
    <SettingsGroup>
    <DiagnosticResult title="Model Integrity" status={state.installed ? 'PASS' : state.busy && /Verifying/.test(state.phase) ? 'RUNNING' : 'NOT TESTED'} />
    <DiagnosticResult divider title="Model Initialization" status={state.busy && state.phase === 'Loading model' ? 'RUNNING' : state.loadMs !== null ? 'PASS' : 'NOT TESTED'} />
    <DiagnosticResult divider title="Native release" status={releaseResult} />
    <DiagnosticResult divider title="Inference" status={state.inferenceMs !== null && !!state.response ? 'PASS' : state.busy && /Generating/.test(state.phase) ? 'RUNNING' : 'NOT TESTED'} />
    </SettingsGroup>
    {state.busy ? <Text accessibilityLiveRegion="polite" style={{ color: t.text }}>{state.phase}</Text> : null}
    {state.progress ? <Text accessibilityLiveRegion="polite" style={{ color: t.text }}>
      {state.progress.stage === 'download' ? 'Downloaded' : 'SHA-256 checked'} {(state.progress.completed / 1_000_000).toFixed(1)} / {(state.progress.total / 1_000_000).toFixed(1)} MB
      {' · '}{Math.min(100, state.progress.completed / state.progress.total * 100).toFixed(1)}%{' · '}{Math.round(state.progress.elapsedMs / 1000)} s
    </Text> : null}
    <DiagnosticDetails>
      <Text selectable style={{ color: t.textSecondary }}>{GEMMA_ARTIFACT.filename} · 241 MB{`\n`}SHA-256: {GEMMA_ARTIFACT.sha256}</Text>
    </DiagnosticDetails>
    <Btn title="Check installed model (verify checksum)" disabled={disabled || state.loaded} onPress={() => act(() => gemmaPoc.check())} />
    <Btn title="Accept terms and download approved model" disabled={disabled || state.loaded} onPress={() => act(() => gemmaPoc.provision())} />
    <Btn title="Initialize model" disabled={disabled || state.loaded} onPress={() => act(() => gemmaPoc.load())} />
    <DiagnosticDetails>
      <Text style={{ color: t.text }}>Fixed prompt: {TEST_PROMPT}</Text>
    </DiagnosticDetails>
    <Btn title="Run fixed acknowledgment test" disabled={disabled || !state.loaded} onPress={() => act(() => gemmaPoc.run())} />
    <DiagnosticDetails>
      <Text style={{ color: t.text }}>Contextual evaluation: 16 fixed English/Spanish fixtures per prompt; synthetic NOT OK events only. No live driver data. Unload first. Eligible fixtures verify, load, infer and release through the production controller. Ineligible fixtures skip inference and use fixed fallback. Results stay in RAM; copy the selectable JSON before leaving.</Text>
    </DiagnosticDetails>
    {(['baseline', 'conversational'] as const).map(arm => <Btn key={arm} title={arm === 'baseline' ? 'Run bilingual prompt A · Current' : 'Run bilingual prompt B · Conversational'} disabled={disabled || state.loaded || !runner} onPress={() => {
      if (!runner || evaluationPending.current || closingRef.current || !live.current || blockedRef.current || isGemmaRuntimeProtected()) return;
      evaluationPending.current = true;
      setEvaluationBusy(true); setEvaluationError('');
      const publish = (value: DiagnosticReport) => {
        if (live.current) setReports(current => ({ ...current, [arm]: value }));
      };
      void runner.run(publish, arm)
        .then(value => { if (value.status === 'cancelled') publish(value); })
        .catch(() => { if (live.current) setEvaluationError('Suite could not start. Unload the idle model and retry in the foreground.'); })
        .finally(() => { evaluationPending.current = false; if (live.current) setEvaluationBusy(false); });
    }} />)}
    {evaluationError ? <Text style={{ color: t.text }}>{evaluationError}</Text> : null}
    {contextual && Object.values(reports).map(report => <View key={report.promptRevision} style={{ gap: 8 }}>
      <Text style={{ color: t.text }}>{report.promptRevision}: {report.status}. Grammar acceptance is not proof of bilingual quality or VoiceCheck readiness.</Text>
      {(['en', 'es'] as const).map(language => {
        const all = contextual.diagnosticSummary(report.rows, language);
        const grounded = contextual.diagnosticSummary(report.rows, language, 'grounded');
        return <Text key={language} style={{ color: t.text }}>{language}: accepted {all.accepted}/{all.attempted} inference attempts; skipped {all.skipped}/{all.cases} cases; returned output {all.completedOutput}; grounded acceptance {grounded.accepted}/{grounded.attempted}. Repeated openings {all.repeatedOpenings}; inference median {all.medianMs ?? "—"} ms / p95 {all.p95Ms ?? "—"} ms.</Text>;
      })}
      <DiagnosticDetails title="Suite evidence">
        <Text style={{ color: t.textSecondary }}>Memory values are whole-process snapshots, never peak native/model memory. Operation timings exclude memory sampling. Initialization excludes file verification; load includes it. Release is a controller-call duration. This suite does not reproduce guidance playback or the five-second presentation window.</Text>
        <Text selectable style={{ color: t.text }}>{JSON.stringify(report, null, 2)}</Text>
      </DiagnosticDetails>
    </View>)}
    {state.busy || evaluationBusy ? <Btn title="Cancel operation" onPress={() => { if (evaluationBusy) runner?.cancel(); else if (!isGemmaRuntimeProtected()) gemmaPoc.cancel(); }} /> : null}
    <Btn title="Unload model safely" disabled={protectedRuntime || closing || evaluationBusy || (!state.loaded && !state.busy)} onPress={() => act(() => gemmaPoc.dispose())} />
    <DiagnosticDetails title="Runtime evidence">
      <Text style={{ color: t.text }}>Loading: {state.loadMs ?? '—'} ms · Inference: {state.inferenceMs ?? '—'} ms</Text>
      <Text selectable style={{ color: t.text }}>Generated response: {state.response || '—'}</Text>
      {state.error ? <Text accessibilityRole="alert" selectable style={{ color: t.text }}>Error: {state.error}</Text> : null}
    </DiagnosticDetails>

  </ScrollView></SafeAreaView>;
}

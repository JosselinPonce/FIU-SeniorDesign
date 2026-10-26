import { useEffect, useState } from 'react';
import { AppState, BackHandler, ScrollView, Text, View } from 'react-native';
import { Btn } from '../../components/ui';
import { useTheme } from '../../lib/theme/ThemeProvider';
import { GEMMA_ARTIFACT, TEST_PROMPT } from './artifact';
import { gemmaPoc } from './phone';

export function GemmaDiagnostic({ blocked, onClose }: { blocked: boolean; onClose(): void }) {
  const { tokens: t } = useTheme();
  const [state, setState] = useState(gemmaPoc.state);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    const unsubscribe = gemmaPoc.subscribe(setState);
    const app = AppState.addEventListener('change', status => { if (status !== 'active') void gemmaPoc.dispose(); });
    const back = BackHandler.addEventListener('hardwareBackPress', () => { void gemmaPoc.dispose(); return true; });
    return () => { unsubscribe(); app.remove(); back.remove(); void gemmaPoc.dispose(); };
  }, []);
  useEffect(() => { if (blocked) void gemmaPoc.dispose(); }, [blocked]);
  if (!__DEV__) return null;
  const disabled = blocked || closing || state.busy;
  const act = (action: () => Promise<void>) => { void action().catch(() => {}); };
  return <ScrollView contentContainerStyle={{ padding: 20, gap: 12 }} style={{ backgroundColor: t.background }}>
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
    {state.busy ? <Btn title="Cancel operation" onPress={() => gemmaPoc.cancel()} /> : null}
    <Btn title="Unload model safely" disabled={closing || (!state.loaded && !state.busy)} onPress={() => act(() => gemmaPoc.dispose())} />
    <View style={{ gap: 8 }}>
      <Text style={{ color: t.text }}>Loading: {state.loadMs ?? '—'} ms · Inference: {state.inferenceMs ?? '—'} ms</Text>
      <Text selectable style={{ color: t.text }}>Generated response: {state.response || '—'}</Text>
      {state.error ? <Text accessibilityRole="alert" selectable style={{ color: t.text }}>Error: {state.error}</Text> : null}
    </View>
    <Btn title="Unload and return to Settings" disabled={closing} onPress={() => {
      setClosing(true);
      void gemmaPoc.dispose().then(() => {
        if (!gemmaPoc.state.loaded && !gemmaPoc.state.busy) onClose();
      }).finally(() => setClosing(false));
    }} />
  </ScrollView>;
}

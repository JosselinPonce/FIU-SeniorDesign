import { useEffect, useRef, useState } from 'react';
import { LocalizedText as Text } from '../lib/i18n/native';
import { useTheme } from '../lib/theme/ThemeProvider';
import { gemmaPoc, type inspectGemmaModelFile } from '../modules/gemma-poc/phone';
import { gemmaStatusLabels } from '../lib/ui/gemmaStatus';
import { DiagnosticDetails, DiagnosticResult } from './DiagnosticUI';
import { SettingsGroup, SettingsRow } from './SettingsGroup';
import { GEMMA_ARTIFACT } from '../modules/gemma-poc/artifact';

/** Observes existing runtime state only. History stays in memory while mounted. */
export function GemmaStatus({ file, ready }: { file: ReturnType<typeof inspectGemmaModelFile>; ready: boolean }) {
  const { tokens } = useTheme();
  const [state, setState] = useState(gemmaPoc.state);
  const [release, setRelease] = useState<'PASS' | 'FAIL' | 'NOT TESTED'>('NOT TESTED');
  const [last, setLast] = useState<{ phase: string; failed: boolean; seconds: number; time: string } | null>(null);
  const active = useRef<{ phase: string; started: number; loaded: boolean } | null>(null);
  useEffect(() => gemmaPoc.subscribe(next => {
    if (next.busy && !active.current) active.current = { phase: next.phase, started: performance.now(), loaded: next.loaded };
    if (!next.busy && active.current) {
      const operation = active.current;
      active.current = null;
      const failed = !!next.error || !!next.cleanupRequired || (operation.phase === 'Unloading model' && next.loaded);
      if (operation.phase === 'Unloading model' && operation.loaded) setRelease(failed ? 'FAIL' : 'PASS');
      setLast({ phase: operation.phase, failed,
        seconds: Math.max(0, (performance.now() - operation.started) / 1000), time: new Date().toLocaleTimeString() });
    }
    setState(next);
  }), []);
  const labels = gemmaStatusLabels(state);
  return <>
    <SettingsGroup>
      <SettingsRow title="Installation" subtitle={file === 'present' ? 'Installed' : file === 'missing' ? 'Not installed' : 'Unavailable'} />
      <SettingsRow divider title="Session" subtitle={ready ? 'Prepared for this session' : state.loaded && !state.busy && !state.error && !state.cleanupRequired ? 'Not prepared' : labels.session} />
      <SettingsRow divider title="Model size" subtitle={`Approximately ${Math.round(GEMMA_ARTIFACT.bytes / 1_000_000)} MB`} />
    </SettingsGroup>
    <SettingsGroup>
      <DiagnosticResult title="Model integrity" status={state.busy && /Verifying/.test(state.phase) ? 'RUNNING' : file === 'unavailable' ? 'UNAVAILABLE' : file === 'present' && state.installed ? 'PASS' : 'NOT TESTED'} />
      <DiagnosticResult divider title="Native initialization" status={state.busy && state.phase === 'Loading model' ? 'RUNNING' : state.loadMs !== null ? 'PASS' : 'NOT TESTED'} />
      <DiagnosticResult divider title="Native release" status={state.busy && state.phase === 'Unloading model' ? 'RUNNING' : release} />
      <DiagnosticDetails>
        <Text style={{ color: tokens.textSecondary }}>Press and hold the details to select and copy. No driver responses are included.</Text>
        <Text selectable style={{ color: tokens.text }}>{JSON.stringify({ phase: state.phase, verifiedThisProcess: state.installed,
          loaded: state.loaded, busy: state.busy, cleanupRequired: !!state.cleanupRequired,
          error: state.error || null, initializationMs: state.loadMs, lastObservedOperation: last }, null, 2)}</Text>
      </DiagnosticDetails>
    </SettingsGroup>
  </>;
}

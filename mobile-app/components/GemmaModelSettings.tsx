import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AppState, Linking } from 'react-native';
import { LocalizedText as Text } from '../lib/i18n/native';
import { useTheme } from '../lib/theme/ThemeProvider';
import { GEMMA_TERMS_URL, GEMMA_POLICY_URL } from '../lib/onboarding/setup';
import { sensiSetup } from '../lib/onboarding/phone';
import { inspectGemmaModelFile } from '../modules/gemma-poc/phone';
import { Btn, SectionTitle } from './ui';
import { SettingsGroup, SettingsNote, SettingsRow } from './SettingsGroup';
import { DiagnosticDetails } from './DiagnosticUI';
import { GemmaStatus } from './GemmaStatus';

/** Release maintenance UI; no driver data, audio, inference prompts or phone actions. */
export function GemmaModelSettings({ blocked, ready = false, preparing = false, sessionActions }: { blocked: boolean; ready?: boolean; preparing?: boolean; sessionActions?: ReactNode }) {
  const { tokens } = useTheme();
  const [setup, setSetup] = useState(sensiSetup.state);
  const [file, setFile] = useState(inspectGemmaModelFile);
  const live = useRef(false), owned = useRef(false), blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  useEffect(() => {
    live.current = true;
    const unsubscribe = sensiSetup.subscribe(setSetup);
    const app = AppState.addEventListener('change', state => {
      if (state !== 'active' && owned.current) sensiSetup.cancel();
      if (state === 'active') setFile(inspectGemmaModelFile());
    });
    return () => { live.current = false; unsubscribe(); app.remove(); if (owned.current) sensiSetup.cancel(); };
  }, []);
  useEffect(() => { if (blocked && owned.current) sensiSetup.cancel(); }, [blocked]);
  const runtime = sensiSetup.runtime.state;
  const busy = setup.busy || runtime.busy;
  const status = preparing ? 'Preparing Gemma…' : busy ? 'Checking or repairing Gemma…'
    : setup.error || runtime.error || runtime.cleanupRequired ? 'Gemma requires attention.'
    : file !== 'present' ? 'Gemma is unavailable.'
    : setup.modelReady ? 'Last explicit model check succeeded. Availability is verified again before use.'
    : 'Check Gemma here to confirm model readiness.';
  return <>
    <GemmaStatus file={file} ready={ready} />
    <SectionTitle>Model maintenance</SectionTitle>
    <Text accessibilityLiveRegion="polite" style={{ color: tokens.text }}>{status}</Text>
    <SettingsNote>Fixed safety responses remain available. Check and repair verifies the model and tests initialization.</SettingsNote>
    <SettingsGroup>
      <DiagnosticDetails title="Storage and troubleshooting" divider={false}>
        {setup.error ? <Text selectable style={{ color: tokens.text }}>{setup.error}</Text> : null}
        <SettingsNote>Allow at least 483 MB of free storage. Check and repair downloads a missing or corrupt model only after you press the button. A download requires an internet connection. Keep DriveSense open until cleanup finishes.</SettingsNote>
      </DiagnosticDetails>
    </SettingsGroup>
    {!setup.terms ? <SettingsNote>{'Review both Gemma documents in Legal & Information before accepting the terms.'}</SettingsNote> : null}
    {blocked ? <Text style={{ color: tokens.textSecondary }}>Pause sensor monitoring and finish recording or safety checks before model recovery.</Text> : null}
    {runtime.progress && busy ? <Text style={{ color: tokens.textSecondary }}>Model download/verification progress: {Math.min(100, Math.round(runtime.progress.completed / runtime.progress.total * 100))}%</Text> : null}
    {runtime.cleanupRequired && !runtime.busy ? <Text style={{ color: tokens.textSecondary }}>Model cleanup did not finish. Retry; restart the app if it remains unavailable.</Text> : null}
    <Btn title="Check and repair Gemma" disabled={blocked || busy || !setup.ready || !setup.terms} onPress={() => {
      if (owned.current || blockedRef.current || sensiSetup.state.busy || sensiSetup.runtime.state.busy) return;
      owned.current = true;
      void sensiSetup.repair(() => live.current && !blockedRef.current).finally(() => {
        owned.current = false; if (live.current) setFile(inspectGemmaModelFile());
      });
    }} />
    {setup.busy && owned.current ? <Btn title="Cancel model recovery" kind="ghost" onPress={() => sensiSetup.cancel()} /> : null}
    {sessionActions}
    <SectionTitle>{'Legal & Information'}</SectionTitle>
    <SettingsGroup>
      <SettingsRow title="Gemma Terms of Use" onPress={() => { void Linking.openURL(GEMMA_TERMS_URL).catch(() => {}); }} />
      <SettingsRow divider title="Gemma Prohibited Use Policy" onPress={() => { void Linking.openURL(GEMMA_POLICY_URL).catch(() => {}); }} />
      {!setup.terms ? <SettingsRow divider action title="I accept the Gemma Terms of Use and Prohibited Use Policy" disabled={blocked || busy} onPress={() => { void sensiSetup.acknowledge('terms', true); }} /> : null}
    </SettingsGroup>
  </>;
}

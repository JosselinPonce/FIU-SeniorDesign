import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { LocalizedText as Text } from '../lib/i18n/native';
import { useTheme } from '../lib/theme/ThemeProvider';
import { sensiSetup } from '../lib/onboarding/phone';
import { inspectGemmaModelFile } from '../modules/gemma-poc/phone';
import { Btn, Card, SectionTitle } from './ui';

/** Release maintenance UI; no driver data, audio, inference prompts or phone actions. */
export function GemmaModelSettings({ blocked }: { blocked: boolean }) {
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
  const status = busy ? 'Checking or repairing Gemma…'
    : setup.error || runtime.error || runtime.cleanupRequired ? 'Gemma requires attention. Fixed safety responses remain available.'
    : file !== 'present' ? 'Gemma is unavailable. Fixed safety responses remain available.'
    : setup.modelReady ? 'Last explicit model check succeeded. Availability is verified again before use.'
    : 'Check Gemma here to confirm model readiness.';
  return <Card>
    <SectionTitle>Gemma model</SectionTitle>
    <Text accessibilityLiveRegion="polite" style={{ color: tokens.text }}>{status}</Text>
    <Text style={{ color: tokens.textSecondary }}>Safety checks retain fixed responses when Gemma is unavailable.</Text>
    <Text style={{ color: tokens.textSecondary }}>Check and repair verifies the approved model and tests initialization. A missing or corrupt model is downloaded only after you press this button.</Text>
    <Text style={{ color: tokens.textSecondary }}>A download requires an internet connection. Keep the app open until cleanup finishes.</Text>
    {blocked ? <Text style={{ color: tokens.textSecondary }}>Pause sensor monitoring and finish recording or safety checks before model recovery.</Text> : null}
    {runtime.progress && busy ? <Text style={{ color: tokens.textSecondary }}>Model download/verification progress: {Math.min(100, Math.round(runtime.progress.completed / runtime.progress.total * 100))}%</Text> : null}
    {runtime.cleanupRequired ? <Text style={{ color: tokens.textSecondary }}>Model cleanup did not finish. Retry; restart the app if it remains unavailable.</Text> : null}
    <Btn title="Check and repair Gemma" disabled={blocked || busy || !setup.ready} onPress={() => {
      if (owned.current || blockedRef.current || sensiSetup.state.busy || sensiSetup.runtime.state.busy) return;
      owned.current = true;
      void sensiSetup.repair(() => live.current && !blockedRef.current).finally(() => {
        owned.current = false; if (live.current) setFile(inspectGemmaModelFile());
      });
    }} />
    {setup.busy && owned.current ? <Btn title="Cancel model recovery" kind="ghost" onPress={() => sensiSetup.cancel()} /> : null}
  </Card>;
}

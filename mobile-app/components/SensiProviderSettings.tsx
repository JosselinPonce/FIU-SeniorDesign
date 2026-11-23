import { useEffect, useRef, useState } from 'react';
import { Switch, View } from 'react-native';
import { LocalizedText as Text } from '../lib/i18n/native';
import { useTheme } from '../lib/theme/ThemeProvider';
import { sensiPreferences, resumePreparedGemma, stopPreparedGemma, isGemmaPreparing, isGemmaExplicitlyStopped, subscribeGemmaPreparation } from '../lib/assistant/phoneSensiRouting';
import { SENSI_PROVIDERS } from '../lib/assistant/sensiPreferences';
import { gemmaPoc, inspectGemmaModelFile, isGemmaAcknowledgmentReady } from '../modules/gemma-poc/phone';
import { CloudPrivacyInfo } from './CloudPrivacyInfo';
import { RESPONSE_MODE_REQUIREMENTS, RESPONSE_MODE_DESCRIPTIONS, RESPONSE_MODE_SUBTITLES, RESPONSE_MODE_SUMMARIES } from '../lib/ui/sensiPresentation';
import { settingsSwitchColors } from '../lib/ui/settingsSwitch';
import { SettingsGroup, SettingsNote, SettingsRow } from './SettingsGroup';
import { InformationButton } from './Information';
import { SensiCloudAccess, useSensiAccount } from './SensiCloudAccess';
import { GemmaModelSettings } from './GemmaModelSettings';
type SensiDetail = 'sensi_account' | 'sensi_mode' | 'sensi_cloud' | 'sensi_gemma' | 'sensi_voice';
type SettingsPage = SensiDetail | 'developer';

export function SensiProviderSettings({ driverId, blocked, accountBlocked, page, navigate }: {
  driverId: string | null;
  blocked: boolean;
  accountBlocked: boolean;
  page: 'assistant' | SensiDetail;
  navigate: (page: SettingsPage) => void;
}) {
  const { tokens } = useTheme();
  const [state, setState] = useState(sensiPreferences.state);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [runtime, setRuntime] = useState(gemmaPoc.state);
  const live = useRef(false);
  const [preparing, setPreparing] = useState(() => isGemmaPreparing());
  const [stopped, setStopped] = useState(() => isGemmaExplicitlyStopped());
  useEffect(() => {
    live.current = true;
    const policy = sensiPreferences.subscribe(setState), runtime = gemmaPoc.subscribe(setRuntime);
    const preparation = subscribeGemmaPreparation(() => {
      setPreparing(isGemmaPreparing());
      setStopped(isGemmaExplicitlyStopped());
    });
    void sensiPreferences.boot();
    return () => { live.current = false; policy(); runtime(); preparation(); };
  }, []);
  useEffect(() => { void sensiPreferences.selectDriver(driverId); }, [driverId]);
  async function action(work: () => Promise<unknown>) {
    setBusy(true); setMessage('');
    try { await work(); } catch (error) { if (live.current) setMessage(error instanceof Error ? error.message : 'Sensi setting unavailable.'); }
    finally { if (live.current) setBusy(false); }
  }
  const account = useSensiAccount();
  const ready = isGemmaAcknowledgmentReady();
  const consent = state.driverId === driverId && state.consent;
  const accountStatus = account.status === 'signed_in' ? 'Signed in · Connected account'
    : account.status === 'checking' ? 'Checking session…'
    : account.status === 'unavailable' ? 'Session unavailable' : 'Signed out';

  if (page === 'assistant') {
    const file = inspectGemmaModelFile();
    const modelStatus = runtime.error || runtime.cleanupRequired ? 'Needs attention'
      : runtime.busy ? 'Working…'
      : file === 'present' ? runtime.installed ? 'Verified' : 'Installed · Verification needed'
      : file === 'missing' ? 'Not installed' : 'Unavailable';
    return <>
      <SettingsNote>Personalize your safety assistant.</SettingsNote>
      <SettingsGroup>
        <SettingsRow title="Account" subtitle={accountStatus} onPress={() => navigate('sensi_account')} />
        <SettingsRow divider title="AI Response Mode" subtitle={state.loaded ? RESPONSE_MODE_SUMMARIES[state.preference] : 'Loading…'} onPress={() => navigate('sensi_mode')} />
        <SettingsRow divider title="Cloud Processing" subtitle={consent ? 'Consent on' : 'Consent off'} onPress={() => navigate('sensi_cloud')} />
        <SettingsRow divider title="On-Device Gemma" subtitle={modelStatus} onPress={() => navigate('sensi_gemma')} />
      </SettingsGroup>
      <SettingsGroup>
        <SettingsRow title="Voice & Language" onPress={() => navigate('sensi_voice')} />
        {__DEV__ ? <SettingsRow divider title="Diagnostics" onPress={() => navigate('developer')} /> : null}
      </SettingsGroup>
    </>;
  }

  if (page === 'sensi_account') return <SensiCloudAccess blocked={accountBlocked} state={account} />;
  if (page === 'sensi_voice') return null;

  if (page === 'sensi_gemma') return <>
    <GemmaModelSettings blocked={blocked} ready={ready} preparing={preparing} sessionActions={<SettingsGroup>
      {(ready || preparing)
        ? <SettingsRow action title="Stop prepared Gemma" onPress={stopPreparedGemma} tone="danger" />
        : state.preference === 'gemma'
          ? <SettingsRow action title={stopped ? 'Resume Gemma' : 'Retry Gemma'} disabled={blocked || runtime.busy} onPress={resumePreparedGemma} />
          : null}
    </SettingsGroup>} />
    {message ? <Text accessibilityRole="alert" style={{ color: tokens.danger }}>{message}</Text> : null}
  </>;

  if (page === 'sensi_mode') {
    const modeDetails = SENSI_PROVIDERS.map(provider =>
      [provider.label, RESPONSE_MODE_DESCRIPTIONS[provider.id]].join('\n')).concat(RESPONSE_MODE_REQUIREMENTS).join('\n\n');
    return <>
      <View accessibilityRole="radiogroup">
        <SettingsGroup>
          {SENSI_PROVIDERS.map((provider, index) => <SettingsRow key={provider.id} divider={index > 0} title={provider.label}
            subtitle={RESPONSE_MODE_SUBTITLES[provider.id]} selected={state.loaded && state.preference === provider.id}
            disabled={!state.loaded || busy || blocked} onPress={() => { void action(() => sensiPreferences.savePreference(provider.id)); }} />)}
        </SettingsGroup>
      </View>
      <SettingsNote>Every mode uses the same core safety guidance.</SettingsNote>
      <InformationButton title="How response modes work" body={modeDetails} />
      {message ? <Text accessibilityRole="alert" style={{ color: tokens.danger }}>{message}</Text> : null}
    </>;
  }

  return <>
    <CloudPrivacyInfo />
    <SettingsGroup>
      <SettingsRow title="Cloud processing consent" subtitle={consent ? 'On for this driver' : 'Off'}
        trailing={<Switch {...settingsSwitchColors(tokens)} accessibilityLabel="Allow short VoiceCheck responses to be sent to OpenAI for this driver" value={consent}
          disabled={!state.accountId || !driverId || busy || state.driverId !== driverId || blocked && !state.consent}
          onValueChange={consent => { if (driverId) void action(() => sensiPreferences.saveConsent(driverId, consent)); }} />} />
    </SettingsGroup>
    <SettingsNote>Consent is saved for this account and driver. Signing out clears saved consent. Signing in and selecting a mode are separate from consent.</SettingsNote>
    {!state.accountId ? <SettingsNote>Sign in to manage cloud consent.</SettingsNote> : null}
    {!driverId ? <SettingsNote>Select a driver to manage cloud consent.</SettingsNote> : null}
    {message ? <Text accessibilityRole="alert" style={{ color: tokens.danger }}>{message}</Text> : null}
  </>;
}

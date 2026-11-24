import { STANDALONE_DEMO } from '../lib/buildProfile';
import { resumeTelemetry, telemetryMode, type TelemetryMode } from '../lib/db/telemetryPolicy';
import { VoiceCheckTesting } from './VoiceCheckTesting';
import { SettingsGroup, SettingsRow } from './SettingsGroup';
import { SimulationProgress } from './SimulationProgress';
import { FIRST_ABNORMAL_SIMULATION_SECOND, simulationReading, type DemoScenario } from '../lib/analysis/simulationReadings';
import { DiagnosticDetails, DiagnosticResult } from './DiagnosticUI';
import { getSetting, setSetting } from '../lib/db/repositories';
import { readRealContactPreference, saveRealContactPreference } from '../lib/voice/realContactPreference';
import { displayBmi, maskedContactPhone } from '../lib/ui/profileSummary';
import { RealContactDemoConfirmation } from './RealContactDemoConfirmation';
import { contactPhone } from '../lib/analysis/safetyController';
import { ScreenHeader, ScreenHeading } from './ScreenHeader';
import { LocalizedAlert as Alert, LocalizedPressable as Pressable, LocalizedText as Text } from '../lib/i18n/native';
import { simulationCompletion } from '../lib/assistant/safetyConversation';
import { settingsSwitchColors } from '../lib/ui/settingsSwitch';
import { REHEARSAL_SAFETY_REVISION } from '../lib/voice/phoneHandoff';
import { InformationButton } from './Information';
import { useTheme } from '../lib/theme/ThemeProvider';
import { presentationColors, type ThemeTokens } from '../lib/theme/tokens';
/**
 * Storage choice, cloud backlog, and the technical link details that used to
 * crowd the drive screen.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { SETTINGS_CATEGORIES, isSensiDetail, settingsTitle, type SettingsPage } from '../lib/ui/settingsNavigation';
import { AppState, BackHandler, ScrollView, StyleSheet, Switch, View } from 'react-native';

import type { useDriveSession } from '../lib/hooks/useDriveSession';
import type { StorageMode } from '../lib/db/repositories';
import { pendingCount, syncToSupabase } from '../lib/db/sync';
import { wipeEverything } from '../lib/db/deletion';
import { Btn, Card, Pill, Row, SectionTitle, fmtClock, fmtDuration } from './ui';
import { VoicePicker } from './VoicePicker';
import { CalibrationCard } from './CalibrationCard';
import { ThresholdHistory } from './ThresholdHistory';
import { LanguageMenu } from './LanguageMenu';
import { SpeechCapabilityStatus } from './SpeechCapabilityStatus';

// Metro removes this branch from release builds, including the diagnostic module.
const ResponsivenessDiagnostics = __DEV__
  ? (require('./ResponsivenessDiagnostics') as typeof import('./ResponsivenessDiagnostics')).ResponsivenessDiagnostics
  : null;
const SensiVoicePlaybackDiagnostic = __DEV__
  ? (require('./SensiVoicePlaybackDiagnostic') as typeof import('./SensiVoicePlaybackDiagnostic')).SensiVoicePlaybackDiagnostic
  : null;

const hardwareTools = __DEV__ || STANDALONE_DEMO;
const HardwareSafetyDiagnostic = hardwareTools
  ? (require('./HardwareSafetyDiagnostic') as typeof import('./HardwareSafetyDiagnostic')).HardwareSafetyDiagnostic
  : null;

type Drive = ReturnType<typeof useDriveSession>;

const MODES: { key: StorageMode; title: string; body: string }[] = [
  {
    key: 'vitals',
    title: 'Vitals only (recommended)',
    body:
      'Heart rate and oxygen once per second. This is the project proposal\'s data policy: keep processed values, not raw sensor signals.',
  },
  {
    key: 'full',
    title: 'Vitals + full waveform',
    body:
      'Also keeps every raw sensor sample (100 per second) for research. When the drive ends it is folded into a compact, checksummed archive — about 4× smaller, and it unfolds exactly — then backed up to the cloud. Use only with the driver\'s consent.',
  },
];

export function SettingsView(props: {
  initialPage?: SettingsPage;
  drive: Drive;
  autoOn: boolean;
  setAutoOn: (v: boolean) => void;
  onWiped: () => Promise<void>;
  onDeleteDriver?: (id: string) => void;
  onShowIntro: () => void;
  onEditProfile: (returnPage?: SettingsPage) => void;
}) {
  const { colors: C, tokens } = useTheme();
  const st = makeStyles(tokens);
  const d = props.drive;
  const initialPage = String(props.initialPage) === 'where_to_store' ? 'data' : props.initialPage ?? null;
  const [page, setPage] = useState<SettingsPage>(initialPage);
  const scroll = useRef<ScrollView>(null);
  const focusedDemo = useRef(false);
  const positions = useRef<Record<string, number>>({});
  const history = useRef<SettingsPage[]>([]);
  const navigate = (next: SettingsPage) => { history.current.push(page); setPage(next); };
  const goBack = () => {
    const leave = () => setPage(history.current.length ? history.current.pop()! : isSensiDetail(page) ? 'assistant' : page === 'voicecheck_testing' ? 'safety_testing' : page === 'safety_testing' || page === 'thresholds' || page === 'calibration' ? 'safety' : page === 'hardware_safety_test' ? 'developer' : page === 'developer' ? 'advanced' : page === 'what_to_save' || page === 'cloud_sync' ? 'data' : null);
    const phase = d.hardwareTest?.phase;
    if (page === 'hardware_safety_test' && phase && !['idle', 'cancelled', 'finished'].includes(phase)) {
      Alert.alert('Leave hardware test?', 'Leaving this screen cancels the current diagnostic run.', [
        { text: 'Cancel', style: 'cancel' }, { text: 'Leave test', style: 'destructive', onPress: leave },
      ]);
    } else leave();
  };
  useEffect(() => { if (initialPage) setPage(initialPage); }, [initialPage]);
  useEffect(() => {
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      if (page === null) return false;
      goBack(); return true;
    });
    return () => back.remove();
  }, [page, d.hardwareTest?.phase]);
  const [languageBusy, setLanguageBusy] = useState(false);
  const [languageError, setLanguageError] = useState('');
  const [direct, setDirect] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [cloudMode, setCloudMode] = useState<TelemetryMode>(STANDALONE_DEMO ? 'standalone' : 'available');
  useEffect(() => {
    if (STANDALONE_DEMO || (page !== 'data' && page !== 'cloud_sync')) return;
    let current = true;
    void telemetryMode().then(mode => { if (current) setCloudMode(mode); });
    return () => { current = false; };
  }, [page]);
  const cloudNotice = cloudMode === 'standalone' ? 'Cloud synchronization is unavailable in this demonstration.'
    : 'Cloud synchronization is paused. Waiting items remain on this phone.';
  const [waiting, setWaiting] = useState<Awaited<ReturnType<typeof pendingCount>> | null>(null);
  useEffect(() => {
    const profileId = d.driver?.id;
    if (!profileId || cloudMode !== 'available' || page !== 'data' && page !== 'cloud_sync') return;
    let current = true;
    void Promise.resolve().then(() => pendingCount(profileId)).then(result => { if (current) setWaiting(result); })
      .catch(() => { if (current) setWaiting(null); });
    return () => { current = false; };
  }, [page, syncing, d.driver?.id, d.live?.ok, d.session?.status, cloudMode]);
  const [rehearsal, setRehearsal] = useState<string | null>(null);
  const [demoResult, setDemoResult] = useState<string | null>(null);
  const [selectedScenario, setSelectedScenario] = useState<DemoScenario | null>(null);
  const [startingScenario, setStartingScenario] = useState(false);
  const simulationStarting = useRef(false);
  const [realContact, setRealContact] = useState(false);
  const [preferenceReady, setPreferenceReady] = useState(false);
  const [preferenceBusy, setPreferenceBusy] = useState(false);
  const [preferenceError, setPreferenceError] = useState('');
  const preferenceWriting = useRef(false);
  const preferenceLive = useRef(false);
  useEffect(() => {
    preferenceLive.current = true;
    void readRealContactPreference(getSetting).then(value => { if (preferenceLive.current) setRealContact(value); })
      .catch(() => { if (preferenceLive.current) setPreferenceError('Could not restore the demonstration preference. Calling remains off.'); })
      .finally(() => { if (preferenceLive.current) setPreferenceReady(true); });
    return () => { preferenceLive.current = false; };
  }, []);
  async function changeRealContact(value: boolean) {
    if (!preferenceReady || preferenceWriting.current) return;
    preferenceWriting.current = true; setPreferenceBusy(true); setPreferenceError('');
    if (!value) { d.cancelRealContactDemo?.(); }
    try {
      await saveRealContactPreference(setSetting, value);
      if (preferenceLive.current) setRealContact(value);
    } catch { if (preferenceLive.current) setPreferenceError('Could not save the demonstration preference. Please try again.'); }
    finally { preferenceWriting.current = false; if (preferenceLive.current) setPreferenceBusy(false); }
  }
  const savedContact = contactPhone(d.driver?.emergency_phone);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => { if (state !== 'active') { d.cancelRealContactDemo?.(); } });
    return () => { subscription.remove(); d.cancelRealContactDemo?.(); };
  }, [page]);
  const describe = (r: { outcome: string; urgent: boolean; channel: string } | null) =>
    !r
      ? 'The readings never confirmed an emergency.'
      : r.outcome === 'no_response'
        ? 'No answer heard — in a real drive this counts as an emergency (simulated escalation).'
        : `Understood: ${r.outcome === 'ok' ? 'you are OK' : 'you are NOT OK'}${r.urgent ? ' (urgent words heard)' : ''} — via ${r.channel}.`;
  const sf = d.safety;
  const simulationBlocked = !preferenceReady || preferenceBusy || (realContact && !savedContact.phone)
    || d.hasActiveSession || !sf.th || !!sf.demo || !!sf.check || !!sf.conversation || !!sf.pendingDemoContact;
  async function startSimulation(scenario: DemoScenario) {
    if (simulationBlocked || simulationStarting.current) return;
    simulationStarting.current = true;
    setStartingScenario(true);
    setDemoResult(null);
    try {
      setDemoResult(describe(await d.simulate(scenario, realContact)));
    } finally {
      simulationStarting.current = false;
      setStartingScenario(false);
    }
  }
  const now = Date.now();

  async function uploadBacklog() {
    if (await telemetryMode() !== 'available') return;
    setSyncing(true);
    try {
      const profileId = d.driver?.id;
      if (!profileId) return;
      const p = await pendingCount(profileId);
      if (p.sessions === 0 && p.profiles === 0 && p.events === 0) {
        setSyncMsg('Everything is already in the cloud.');
        return;
      }
      setSyncMsg(`Uploading ${p.profiles} profile(s) and ${p.sessions} drive(s)…`);
      const r = await syncToSupabase(profileId);
      setSyncMsg(r.errors.length ? `Couldn't reach the cloud: ${r.errors[0]}` : `Uploaded ${r.profiles} profile(s), ${r.sessions} drive(s), ${r.events} readings.`);
    } catch {
      setSyncMsg("Could not check or upload waiting data.");
    } finally {
      setSyncing(false);
    }
  }

  const assistantPage = page === 'assistant' || isSensiDetail(page) ? page : null;
  useLayoutEffect(() => {
    if (assistantPage) scroll.current?.scrollTo({ y: positions.current[assistantPage] ?? 0, animated: false });
  }, [assistantPage]);

  if (page === 'voicecheck_testing') return <VoiceCheckTesting
    blocked={d.hasActiveSession || !!sf.check || !!sf.demo || !!sf.conversation && !sf.conversation.finished}
    initialLanguage={d.driver?.language === 'es' ? 'es' : 'en'} onExit={goBack} />;

  return (
    <View style={{ flex: 1 }}>
      <ScreenHeader title={settingsTitle(page)} onBack={page === null ? undefined : goBack} backLabel="Back" />
    <ScrollView ref={scroll} key={assistantPage ? 'assistant' : page ?? 'landing'} contentContainerStyle={st.container}
      keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets
      contentOffset={assistantPage ? undefined : { x: 0, y: positions.current[page ?? 'landing'] ?? 0 }} scrollEventThrottle={100}
      onScroll={event => { positions.current[page ?? 'landing'] = event.nativeEvent.contentOffset.y; }}>
      <ScreenHeading title={settingsTitle(page)} />
      {page === null ? <>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}><Text style={st.modeTitle}>App language</Text><LanguageMenu /></View>
        <SettingsGroup>
          {SETTINGS_CATEGORIES.map((category, index) => <SettingsRow key={category.key} divider={index > 0}
            title={category.title} subtitle={category.description} onPress={() => navigate(category.key)} />)}
          <SettingsRow divider title="Advanced Settings" subtitle="More settings and support" onPress={() => navigate('advanced')} />
        </SettingsGroup>
      </> : null}
      {page === 'profile' ? <>
      <Card>
        <Text localize={false} style={st.note}>{d.driver?.display_name}</Text>
        <Text style={st.note}>{d.driver?.emergency_phone ? `Emergency contact: ${d.driver.emergency_name || 'Saved contact'} · ${maskedContactPhone(d.driver.emergency_phone)}` : 'No emergency contact configured. Saved-contact phone handoff is unavailable.'}</Text>
        <Btn title="Edit Driver Profile" onPress={() => props.onEditProfile(page)} />
        <InformationButton title="Profile storage" body={STANDALONE_DEMO ? "Profiles and emergency contacts are saved on this phone. Cloud synchronization is unavailable in this demonstration." : "Profiles are saved on this phone. Cloud updates retry when online; emergency contacts stay on this phone."} />
        {d.hasActiveSession ? <Text style={st.note}>End and save the current drive before editing.</Text> : null}
      </Card>
      {d.driver && props.onDeleteDriver ? <Btn title="Delete Driver Profile" kind="danger"
        disabled={d.hasActiveSession || !!sf.check || !!sf.demo || !!sf.conversation && !sf.conversation.finished}
        onPress={() => props.onDeleteDriver?.(d.driver!.id)} /> : null}
      </> : null}
      {page === 'assistant' ? <SettingsGroup>
        <SettingsRow title="Voice & Language" onPress={() => navigate('sensi_voice')} />
        <SettingsRow divider title="Safety Testing" onPress={() => navigate('safety_testing')} />
        <SettingsRow divider title="Diagnostics" onPress={() => navigate(hardwareTools ? 'developer' : 'voicecheck_testing')} />
      </SettingsGroup> : null}
      {page === 'sensi_voice' ? <>
      <Card>
        <Text style={st.note}>Sensi checks how you feel after confirmed sensor events. You can answer by voice, typing or buttons. Calling your saved contact requires your explicit agreement.</Text>
        <Text style={st.modeTitle}>VoiceCheck Language</Text>
        <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', gap: 12 }}>
          {(['en', 'es'] as const).map(language => <Btn key={language} title={language === 'es' ? 'Spanish' : 'English'}
            kind={d.driver?.language === language ? undefined : 'ghost'}
            accessibilityRole="radio" accessibilityState={{ selected: (d.driver?.language ?? 'en') === language }}
            disabled={languageBusy || d.hasActiveSession || !!sf.check || !!sf.demo || !d.driver}
            onPress={async () => {
              if (languageBusy || !d.driver || (d.driver.language ?? 'en') === language) return;
              setLanguageBusy(true); setLanguageError('');
              try { await d.updateVoiceCheckLanguage(language); }
              catch { setLanguageError('Could not save VoiceCheck language. Please try again.'); }
              finally { setLanguageBusy(false); }
            }} />)}
        </View>
        <SpeechCapabilityStatus language={d.driver?.language === 'es' ? 'es' : 'en'} blocked={!!sf.check || !!sf.demo} />
        {languageError ? <Text accessibilityRole="alert" style={st.note}>{languageError}</Text> : null}
      </Card>
      <Card>
        <Text style={st.voiceHead}>Voice</Text>
        {d.driver ? (
          <VoicePicker lang={d.driver.language === 'es' ? 'es' : 'en'} driverName={d.driver.display_name.split(' ')[0] ?? ''} />
        ) : null}
        <Text style={st.note}>
          Speech is processed on this phone. Audio follows the current speaker or Bluetooth route and the device volume.
          Use Voice to choose an installed system voice. Optional Premium or Enhanced voices can be downloaded in iPhone Settings → Accessibility → Read & Speak → Voices.
          VoiceCheck recognition stays on this phone.
        </Text>
      </Card>
      </> : null}
      {page === 'safety' ? <>
      <SettingsGroup>
        <SettingsRow title="Safety Testing" onPress={() => navigate('safety_testing')} />
        <SettingsRow divider title="Threshold details" onPress={() => navigate('thresholds')} />
        <SettingsRow divider title="Calibrate with a Reference Device" onPress={() => navigate('calibration')} />
      </SettingsGroup>
      <Text style={st.note}>Warnings use your driver's current thresholds. Voice, typing and buttons remain available.</Text>
      <Text style={st.note}>Oxygen is an estimate. A normal-looking value is not proof of normal oxygen.</Text>
      </> : null}
      {page === 'calibration' ? <CalibrationCard drive={d} /> : null}
      {page === 'thresholds' ? <>
      <Card>
        <SectionTitle>Safety checks</SectionTitle>
        {sf.th && sf.prior ? (
          <>
            <Row label="Warning if heart rate above" value={`${sf.th.highWarn} BPM`} />
            <Row label="Warning if heart rate below" value={`${sf.th.lowWarn} BPM`} />
            <Row label="Critical" value={`≤ ${sf.th.lowCrit} or ≥ ${sf.th.highCrit} BPM`} />
            <Row label="Warning if oxygen at or below" value={`${sf.th.spo2Warn}% (critical ≤ ${sf.th.spo2Crit}%)`} />
            <Row
              label="Expected heart rate for this driver"
              value={`${sf.band ? Math.round(sf.band.mean) : Math.round(sf.prior.hrMean)} ± ${Math.round(sf.band?.sd ?? sf.prior.hrSd)} BPM`}
            />
            <Row label="Learned from own drives" value={`${Math.round((sf.band?.weight ?? 0) * 100)}%`} />
            {sf.ack.high !== null || sf.ack.low !== null ? (
              <>
                <Row
                  label={`Adjusted by your "I'm OK" answers`}
                  value={[sf.ack.high !== null ? `high line ${sf.th.highWarn}` : null, sf.ack.low !== null ? `low line ${sf.th.lowWarn}` : null]
                    .filter(Boolean)
                    .join(' · ')}
                  tone="brand"
                />
                <Btn title="Reset these adjustments" kind="ghost" onPress={() => void d.resetAck()} />
              </>
            ) : null}
            <InformationButton title="Personalized thresholds" body={`How the profile sets this: ${sf.prior.explain.filter(line => !line.startsWith('BMI ') || displayBmi(d.driver?.weight_kg ?? null, d.driver?.height_cm ?? null) !== null).join(' · ')}.`} />
            <InformationButton title="How safety checks work" body={'A warning is watched for 15 s (8 s if critical). Only if readings stay out of range does the phone ask "Are you feeling OK?" out loud. Sources: NEWS2 (Royal College of Physicians 2017), Avram et al. 2019 real-world heart-rate norms, alarm-delay studies (Görges 2009). Oxygen is an estimate: pulse oximeters can read several points high on darker skin (Sjoding et al. 2020), so a normal-looking value is not proof of normal oxygen.'} />
            <Text style={st.note}>Oxygen is an estimate. A normal-looking value is not proof of normal oxygen.</Text>
          </>
        ) : (
          <Text style={st.note}>Pick a driver to see their thresholds.</Text>
        )}
        <Row
          label="Voice check"
          value={
            d.driver?.language === 'es' ? 'Check Spanish capability in Sensi Assistant' : !d.voice ? 'permission prepared at driver selection' : !d.voice.granted ? 'off — buttons only' : d.voice.onDevice ? 'on, fully on-device' : 'on'
          }
          tone={d.voice && !d.voice.granted ? 'warn' : 'good'}
        />
        {d.driver ? (
          <>
            <Text style={st.voiceHead}>How your thresholds changed</Text>
            <ThresholdHistory profileId={d.driver.id} refreshKey={`${sf.th?.highWarn}:${sf.th?.lowWarn}:${d.baseline?.sessions ?? 0}`} />
          </>
        ) : null}
        <Btn
          title="Try the voice check"
          kind="ghost"
          disabled={d.hasActiveSession}
          onPress={async () => {
            setRehearsal('Listen and answer out loud…');
            const r = await d.rehearseVoice();
            setRehearsal(
              r.outcome === 'no_response'
                ? 'No answer heard. In a real check this counts as an emergency.'
                : `Understood: ${r.outcome === 'ok' ? 'you are OK' : 'you are NOT OK'}${r.urgent ? ' (urgent words heard)' : ''} — via ${r.channel}. ${simulationCompletion(r)}`,
            );
          }}
        />
        <Text style={st.note}>This is a simulation. Consent is practiced, but the phone interface will never open.</Text>
        {__DEV__ ? <Text style={st.id}>Simulation safety revision: {REHEARSAL_SAFETY_REVISION}</Text> : null}
        {rehearsal ? <Text style={st.note}>{rehearsal}</Text> : null}
        {rehearsal && sf.last?.episode.id === 'rehearsal' && sf.last.handoff ? (
          <Text style={st.note}>{
            sf.last.handoff === 'simulated' ? simulationCompletion(sf.last.result)
            : sf.last.handoff === 'opened' ? 'Phone interface opened. Call connection is not confirmed.'
            : sf.last.handoff === 'missing_contact' ? 'No emergency contact number is saved.'
            : sf.last.handoff === 'invalid_phone' ? 'The saved emergency contact number is invalid.'
            : sf.last.handoff === 'open_failed' ? 'Could not open the phone interface.'
            : 'Phone handoff was cancelled.'
          }</Text>
        ) : null}
      </Card>

      </> : null}
      {page === 'data' ? <>
      <SectionTitle>Data Storage</SectionTitle>
      <SettingsGroup>
        <SettingsRow title="What to Save" subtitle={MODES.find(mode => mode.key === d.storageMode)?.title} onPress={() => navigate('what_to_save')} />
      </SettingsGroup>
      <SectionTitle>Cloud & Sync</SectionTitle>
      <SettingsGroup>
        <SettingsRow title="Cloud Synchronization" subtitle={cloudMode !== 'available' ? cloudNotice : d.live?.lastError || waiting && (waiting.profiles + waiting.sessions + waiting.events) > 0
          ? 'Waiting to sync' : d.live?.lastPushAt ? 'Dashboard reached' : undefined}
          onPress={() => navigate('cloud_sync')} />
      </SettingsGroup>
      <SectionTitle>Your data</SectionTitle>
      <SettingsGroup>
        <SettingsRow title="Review Introduction & Setup" onPress={props.onShowIntro} />
        <SettingsRow divider title="Delete Local Data" subtitle={STANDALONE_DEMO ? 'Deletes records from this phone only.' : 'Also requests deletion from the dashboard'} tone="danger" action disabled={d.hasActiveSession}
          onPress={() =>
            Alert.alert(
              'Wipe everything?',
              STANDALONE_DEMO ? 'This removes every local driver, drive, reading, alert and waveform from this phone. Cloud copies and existing cloud deletion requests are kept.'
                : 'Deletes every driver, drive, reading, alert and waveform this phone has recorded — here and on the dashboard. Other phones\' data is not touched. This cannot be undone.',
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Wipe everything',
                  style: 'destructive',
                  onPress: async () => {
                    const r = await wipeEverything();
                    await props.onWiped();
                    Alert.alert(
                      'Wiped',
                      `${r.drivers} driver(s) deleted.` +
                        (r.queued ? ` ${r.queued} will be removed from the dashboard when the phone is next online.` : ''),
                    );
                  },
                },
              ],
            )
          } />
      </SettingsGroup>
      </> : null}
      {page === 'what_to_save' ? <>
        <SettingsGroup>
          {MODES.map((m, index) => <SettingsRow key={m.key} divider={index > 0}
            title={m.title} subtitle={STANDALONE_DEMO && m.key === 'full' ? 'Saves raw sensor waveforms on this phone only. Use only with the driver’s consent.' : m.body} selected={d.storageMode === m.key} disabled={d.hasActiveSession}
            onPress={() => void d.setStorageMode(m.key)} />)}
        </SettingsGroup>
        {d.hasActiveSession ? <Text style={st.note}>Applies from the next drive.</Text> : null}
      </> : null}
      {page === 'cloud_sync' ? cloudMode !== 'available' ? <>
        <Text style={st.note}>{cloudNotice}</Text>
        {cloudMode === 'held' ? <Btn title="Resume cloud synchronization" onPress={() => Alert.alert(
          'Resume cloud synchronization?', 'Waiting uploads and removals may be sent to the cloud after you resume.',
          [{ text: 'Cancel', style: 'cancel' }, { text: 'Resume', onPress: () => {
            void resumeTelemetry().then(resumed => { if (resumed) setCloudMode('available'); })
              .catch(() => Alert.alert('Could not resume cloud synchronization.'));
          } }])} /> : null}
      </> : <>
        <SettingsGroup>
          <SettingsRow title="Upload waiting profiles and drives" disabled={syncing} onPress={uploadBacklog} />
          {waiting ? <>
            <SettingsRow divider title="Waiting profiles" subtitle={String(waiting.profiles)} />
            <SettingsRow divider title="Waiting drives" subtitle={String(waiting.sessions)} />
            <SettingsRow divider title="Waiting readings" subtitle={String(waiting.events)} />
          </> : null}
        </SettingsGroup>
        <Text style={st.note}>Drives stream to the dashboard live while you have signal. Anything recorded offline waits on the phone; upload it here.</Text>
        {d.live?.lastError ? <Text style={[st.note, { color: C.warn }]}>{d.live.lastError}</Text> : null}
        {syncMsg ? <Text style={st.note}>{syncMsg}</Text> : null}
      </> : null}
      {page === 'connections' ? <>
      <Card>
        <SectionTitle>Connection</SectionTitle>
        <Row label="Auto-connect to the Pi" value={<Switch {...settingsSwitchColors(tokens)} value={props.autoOn} onValueChange={(v) => {
          if (v) d.autoConnect();
          else void d.stopConnecting();
          props.setAutoOn(v);
        }} />} />
        <Row label="Status" value={d.connection} />
        {d.link ? (
          <>
            <Row label="Device" value={`${d.link.name} (${d.link.source === 'relay' ? 'Pi relay' : 'ESP32 direct'})`} />
            <Row label="Connected at" value={fmtClock(d.link.connectedAt)} />
            <Row label="Connected for" value={fmtDuration(now - d.link.connectedAt.getTime())} />
          </>
        ) : null}
        {d.relay ? (
          <Row
            label="Wheel → Pi"
            value={d.relay.esp ? `up since ${d.relay.espSince ? fmtClock(new Date(d.relay.espSince * 1000)) : '?'}` : 'not connected'}
            tone={d.relay.esp ? 'good' : 'bad'}
          />
        ) : null}
        <Row
          label="Last packet"
          value={d.lastRx ? `${((now - d.lastRx.getTime()) / 1000).toFixed(1)} s ago (#${d.lastSeq})` : '—'}
        />
      </Card>

      <Card>
        <SectionTitle>Link health</SectionTitle>
        <DiagnosticResult title="Packet evidence" status={!d.packets ? 'NOT TESTED' : d.crcErrors || d.lost ? 'WARNING' : 'PASS'}><Text style={st.note}>Packet receipt and error counters only; sensor accuracy is not established.</Text></DiagnosticResult>
        <DiagnosticDetails title="Packet and link details">
        <Row label="Packets received" value={String(d.packets)} />
        <Row label="Samples per packet" value={d.samplesPerPacket ? `${d.samplesPerPacket} @ ${d.sampleRate ?? '?'} Hz` : '—'} />
        <Row label="Lost packets" value={String(d.lost)} tone={d.lost ? 'warn' : 'good'} />
        <Row label="CRC errors" value={String(d.crcErrors)} tone={d.crcErrors ? 'bad' : 'good'} />
        <Row label="Duplicates ignored" value={String(d.duplicates)} />
        {d.relay ? <Row label="Pi: from wheel / lost / CRC" value={`${d.relay.rx} / ${d.relay.lost} / ${d.relay.crc}`} /> : null}
        {d.rollovers ? <Row label="Sensor restarts this drive" value={String(d.rollovers)} /> : null}
        {!STANDALONE_DEMO ? <Row label="Rows in cloud (this drive)" value={String(d.live?.pushed ?? 0)} /> : null}
        <View style={st.bench}>
          <Text style={[st.note, { flex: 1 }]}>
            Bench testing: connect straight to the ESP32 when no Pi is around. Never in the car — it locks the Pi out.
          </Text>
          <Switch {...settingsSwitchColors(tokens)}
            value={direct}
            onValueChange={(v) => {
              setDirect(v);
              d.setAllowDirect(v);
            }}
          />
        </View>
        {d.driver ? <Text style={st.id}>driver {d.driver.id}</Text> : null}
        {d.session ? <Text style={st.id}>session {d.session.id}</Text> : null}
        </DiagnosticDetails>
      </Card>
      </> : null}
      {page === 'advanced' ? <>
      <Card><SectionTitle>More settings</SectionTitle>
        <Btn title="Voice & Language" kind="ghost" onPress={() => navigate('sensi_voice')} />
        <Btn title="Monitoring information" kind="ghost" onPress={() => navigate('safety')} />
        <Btn title="Emergency assistance" kind="ghost" onPress={() => navigate('profile')} />
        <Btn title="Device & Connectivity" kind="ghost" onPress={() => navigate('connections')} />
        <Btn title="Data & Privacy" kind="ghost" onPress={() => navigate('data')} />
      </Card>
      {hardwareTools ? <Card><SectionTitle>Developer Tools</SectionTitle>
        <Text style={st.note}>{STANDALONE_DEMO ? 'Hardware diagnostics for the standalone demonstration.' : 'Recognition and audio diagnostics. Debug builds only.'}</Text>
        <Btn title="Open Developer Tools" kind="ghost" onPress={() => navigate('developer')} />
      </Card> : null}
      </> : null}
      {page === 'developer' && hardwareTools ? <>
      <SettingsGroup>
        {HardwareSafetyDiagnostic ? <SettingsRow title="Real Hardware Safety Test" onPress={() => navigate('hardware_safety_test')} /> : null}
        {SensiVoicePlaybackDiagnostic ? <SensiVoicePlaybackDiagnostic blocked={!!sf.check || !!sf.demo} /> : null}
        {ResponsivenessDiagnostics ? <DiagnosticDetails title="Timing and Spanish recognition">
          <ResponsivenessDiagnostics blocked={d.hasActiveSession || !!sf.check || !!sf.demo} />
        </DiagnosticDetails> : null}
      </SettingsGroup>

      </> : null}
      {page === 'hardware_safety_test' && hardwareTools && HardwareSafetyDiagnostic ? <Card><HardwareSafetyDiagnostic drive={d} /></Card> : null}
      {page === 'safety_testing' ? <>
      <Btn title="VoiceCheck Testing" disabled={d.hasActiveSession || !!sf.check || !!sf.demo} onPress={() => navigate('voicecheck_testing')} />
      <View onLayout={event => {
        if (props.initialPage === 'safety_testing' && !focusedDemo.current) {
          focusedDemo.current = true;
          scroll.current?.scrollTo({ y: event.nativeEvent.layout.y, animated: false });
        }
      }}>
      <Card>
        <SectionTitle>Simulate a Warning</SectionTitle>
        <Text style={st.note}>Park before testing. Choose a scenario below.</Text>
        <Row label="Enable real-contact demonstration" value={<Switch {...settingsSwitchColors(tokens)}
          value={realContact} disabled={!preferenceReady || preferenceBusy || startingScenario || d.hasActiveSession || !!sf.check || !!sf.demo || (!savedContact.phone && !realContact)}
          onValueChange={changeRealContact} />} />
        <Text accessibilityLiveRegion="polite" style={st.note}>{realContact ? 'Real-contact run: consent to the contact offer is required. iOS asks before dialing.' : 'Noncalling run: no saved-contact phone interface will open.'}</Text>
        <Text style={st.note}>Off by default. Stays enabled until you turn it off. Consent to Sensi’s contact offer can open the iOS phone confirmation.</Text>
        {!savedContact.phone ? <><Text style={st.note}>Save a valid emergency contact to enable this demonstration.</Text>
          <Btn title="Edit Driver Profile" kind="ghost" disabled={d.hasActiveSession || !!sf.check || !!sf.demo} onPress={() => props.onEditProfile(page)} /></> : null}
        {realContact && savedContact.phone ? <Text localize={false} style={st.note}>{d.driver?.emergency_name || '—'} · {maskedContactPhone(savedContact.phone)}</Text> : null}
        {preferenceError ? <Text accessibilityRole="alert" style={st.note}>{preferenceError}</Text> : null}
        <Text style={st.note}>Simulated readings in Safety Testing use current thresholds and are never saved, uploaded, or used for learning.</Text>
        <InformationButton title="Simulation details" body="Plays fabricated readings through the real warning engine with this driver's thresholds, 4× faster than real time: a few normal seconds, then abnormal ones until the warning flag is raised, confirmed, and the voice check asks if you're OK. The simulated readings are never saved, uploaded, or used for learning." />
        {(
          [
            ['high_critical', 'Very high heart rate'],
            ['high_warning', 'High heart rate'],
            ['low', 'Very low heart rate'],
            ['spo2', 'Low oxygen'],
          ] as const
        ).map(([key, label]) => {
          const expanded = selectedScenario === key;
          const demo = sf.demo?.scenario === key ? sf.demo : null;
          const readings = demo ?? (sf.th ? simulationReading(sf.th, key, FIRST_ABNORMAL_SIMULATION_SECOND) : null);
          return <View key={key} style={{ padding: 12, borderRadius: 14, borderWidth: 1,
            borderColor: expanded ? tokens.primary : tokens.border, gap: 8 }}>
            <Pill tone={key === 'high_warning' ? 'warn' : 'bad'}>{key === 'high_warning' ? 'Warning' : 'Critical'}</Pill>
            <Btn title={label} kind="ghost" accessibilityState={{ expanded }}
              onPress={() => setSelectedScenario(current => current === key ? null : key)} />
            {expanded ? <>
              <Text accessibilityRole="header" style={st.note}>{demo ? 'SIMULATED readings' : 'First simulated abnormal sample'}</Text>
              <Row label="Heart rate" value={readings?.bpm == null ? 'Not available in this simulation' : `${readings.bpm} BPM`} />
              <Row label="SpO₂" value={readings?.spo2 == null ? 'Not available in this simulation' : `${readings.spo2}%`} />
              {demo ? <SimulationProgress demo={demo} /> : null}
              <Btn title="Start safety check" disabled={simulationBlocked || startingScenario} onPress={() => void startSimulation(key)} />
            </> : null}
          </View>;
        })}
        {demoResult ? <Text style={st.note}>{demoResult}</Text> : null}
      </Card>
      </View>
      {!sf.conversation ? <RealContactDemoConfirmation drive={d} /> : null}

      </> : null}
      {!isSensiDetail(page) || page === 'sensi_voice' ? <Text style={st.disclaimer}>Prototype — not a medical device. Oxygen is an estimate. Ordinary simulations never open your saved contact. A real-contact demonstration requires an enabled preference, fresh consent to the contact offer and iOS confirmation.</Text> : null}
    </ScrollView>
    </View>
  );
}

const makeStyles = (tokens: ThemeTokens) => {
  const C = presentationColors(tokens);
  return StyleSheet.create({
    secondary: { minHeight: 44, justifyContent: 'center', paddingVertical: 10 },
    container: { padding: 16, gap: 14, paddingBottom: 40 },
    modeTitle: { fontSize: 16, fontWeight: '700', color: C.ink },
    note: { fontSize: 13, color: C.sub, lineHeight: 18 },
    bench: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 6 },
    id: { fontSize: 10, color: C.faint },
    voiceHead: { fontSize: 14, fontWeight: '700', color: C.ink, marginTop: 6 },
    disclaimer: { fontSize: 12, color: C.faint, textAlign: 'center' },
  });
};

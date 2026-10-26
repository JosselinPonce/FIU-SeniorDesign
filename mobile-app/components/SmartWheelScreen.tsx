import { SENSI_MODE } from '../lib/assistant/mode';
import { sensiSetup } from '../lib/onboarding/phone';
import { SensiStandby } from './SensiStandby';
import { openSensi, sensiDestination } from '../lib/assistant/sensiStandby';
import { SensiSafetyConversation } from './SensiSafetyConversation';
import { VitalsDetailView } from './VitalsDetailView';
import { drivePageAfter, type DrivePage } from '../lib/ui/dashboard';
import { BrandMark } from './BrandMark';
import { DraggableSensiLauncher } from './DraggableSensiLauncher';
import { AppearanceMenu } from './AppearanceMenu';
import { DashboardAssistantEntry } from './DashboardAssistantEntry';
import { InformationHost } from './Information';
import { useTheme } from '../lib/theme/ThemeProvider';
import { presentationColors, type ThemeTokens } from '../lib/theme/tokens';
/**
 * Smart Wheel app shell: driver picker, then three tabs (Drive, History,
 * Settings) under a header that always shows who is driving and lets you
 * switch drivers.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, Pressable, StyleSheet, Text, View, SafeAreaView, Platform, StatusBar as NativeStatusBar } from 'react-native';
import { StatusBar } from 'expo-status-bar';

import { useDriveSession } from '../lib/hooks/useDriveSession';
import * as repo from '../lib/db/repositories';
import type { DriverProfile } from '../lib/db/repositories';
import { Btn } from './ui';
import { DriverPicker } from './DriverPicker';
import { DriveView, VoiceCheckModal } from './DriveView';
import { HistoryView } from './HistoryView';
import { SettingsView } from './SettingsView';
import { Onboarding } from './Onboarding';



type Tab = 'drive' | 'history' | 'settings';

const GemmaDiagnostic = __DEV__ ? (require('../modules/gemma-poc/GemmaDiagnostic') as typeof import('../modules/gemma-poc/GemmaDiagnostic')).GemmaDiagnostic : null;

export default function SmartWheelScreen() {
  const { colors: C, tokens, name: themeName } = useTheme();
  const st = makeStyles(tokens);
  const drive = useDriveSession();
  const [profiles, setProfiles] = useState<DriverProfile[] | null>(null);
  const [drivePage, setDrivePage] = useState<DrivePage>('dashboard');
  useEffect(() => { setDrivePage('dashboard'); }, [drive.driver?.id]);
  const [vitalsAnchor, setVitalsAnchor] = useState<{ y: number; height: number } | null>(null);
  const updateVitalsAnchor = useCallback((next: { y: number; height: number }) => {
    setVitalsAnchor(previous => previous?.y === next.y && previous?.height === next.height ? previous : next);
  }, []);
  const [tab, setTab] = useState<Tab>('drive');
  const [busy, setBusy] = useState(false);
  const [editingProfile, setEditingProfile] = useState<DriverProfile | null>(null);
  const [editOpening, setEditOpening] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [gemmaOpen, setGemmaOpen] = useState(false);
  const [autoOn, setAutoOn] = useState(true);
  useEffect(() => { if (drive.safety.check) setAssistantOpen(false); }, [drive.safety.check]);
  useEffect(() => { if (drive.hasActiveSession || drive.safety.check || drive.safety.demo) setGemmaOpen(false); }, [drive.hasActiveSession, drive.safety.check, drive.safety.demo]);

  function openAssistant() {
    // Preserve any current safety modal; opening never restarts the check.
    openSensi(drive.safety, setAssistantOpen);
  }
  // First run: mandatory, versioned setup. An already-active safety/recording
  // lifecycle is never interrupted to re-run installation or launch checks.
  const [setupState, setSetupState] = useState(sensiSetup.state);
  const [reviewIntro, setReviewIntro] = useState(false);
  const ongoing = drive.hasActiveSession || !!drive.safety.check || !!drive.safety.demo || drive.safety.monitoring === 'active';
  const showIntro = reviewIntro || (setupState.booted && !setupState.ready && !ongoing);
  useEffect(() => sensiSetup.subscribe(setSetupState), []);
  useEffect(() => {
    // Covers returning-user launch checks before the onboarding view is mounted.
    const app = AppState.addEventListener('change', next => { if (next !== 'active') sensiSetup.cancel(); });
    return () => { app.remove(); };
  }, []);
  useEffect(() => { if (!ongoing) void sensiSetup.boot(); }, [ongoing]);
  const finishIntro = useCallback(() => { if (sensiSetup.state.ready) setReviewIntro(false); }, []);
  // Re-render once a second so timers and "x s ago" stay current.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const reload = useCallback(async () => setProfiles(await repo.listProfiles()), []);
  useEffect(() => {
    void reload();
  }, [reload]);

  // Early-return routes cannot host the safety modal. Pause before they are
  // presented, revoking active capture/consent rather than running invisibly.
  useLayoutEffect(() => {
    drive.setSafetyPresentationEnabled(!!drive.driver && !!profiles && showIntro === false && (setupState.ready || ongoing)
      && !editingProfile && !editOpening && !gemmaOpen);
  }, [drive.driver?.id, profiles, setupState.ready, ongoing, showIntro, editingProfile, editOpening, gemmaOpen, drive.setSafetyPresentationEnabled]);

  const guard = useCallback((fn: () => Promise<unknown>) => {
    setBusy(true);
    void fn().finally(() => setBusy(false));
  }, []);

  function switchDriver() {
    if (!drive.hasActiveSession) {
      void drive.leaveDriver();
      return;
    }
    Alert.alert('End this drive?', 'Switching drivers ends and saves the current drive first.', [
      { text: 'Keep driving', style: 'cancel' },
      { text: 'End & switch', style: 'destructive', onPress: () => guard(drive.leaveDriver) },
    ]);
  }

  async function openProfileEditor(afterSave = false) {
    if (editOpening) return;
    if (drive.safety.check || drive.safety.demo) {
      Alert.alert('Safety check active', 'Finish the safety check before editing the driver profile.');
      return;
    }
    if (drive.hasActiveSession && !afterSave) {
      Alert.alert('End and save this drive?', 'Profile editing is available after the drive has been saved.', [
        { text: 'Keep driving', style: 'cancel' },
        { text: 'End & save', onPress: () => guard(async () => {
          try { await drive.endSession(); await openProfileEditor(true); }
          catch (e) { Alert.alert('Could not finish saving the drive', e instanceof Error ? e.message : String(e)); }
        }) },
      ]);
      return;
    }
    setEditOpening(true);
    setAssistantOpen(false);
    try { setEditingProfile(await drive.beginProfileEdit()); }
    catch (e) { Alert.alert('Cannot edit profile', e instanceof Error ? e.message : String(e)); }
    finally { setEditOpening(false); }
  }

  function closeEditor() { drive.closeProfileEdit(); setEditingProfile(null); }

  if (showIntro) {
    return (
      <>
        <StatusBar style={themeName === 'dark' ? 'light' : 'dark'} />
        <Onboarding controller={sensiSetup} review={setupState.ready} onDone={finishIntro} />
      </>
    );
  }

  if (!profiles || (!setupState.booted && !ongoing)) {
    return (
      <View style={st.center}>
        <ActivityIndicator />
      </View>
    );
  }

  if (__DEV__ && gemmaOpen && GemmaDiagnostic && !drive.hasActiveSession && !drive.safety.check && !drive.safety.demo) return <GemmaDiagnostic
    blocked={drive.hasActiveSession || !!drive.safety.check || !!drive.safety.demo}
    onClose={() => setGemmaOpen(false)} />;

  if (!drive.driver) {
    return (
      <>
        <StatusBar style={themeName === 'dark' ? 'light' : 'dark'} />
        <View style={{ flex: 1, backgroundColor: tokens.background }}>
        <DriverPicker profiles={profiles} onPick={drive.selectDriver} onCreated={reload} />
        <InformationHost blocked={!!drive.safety.check || !!drive.safety.demo} />
        </View>
      </>
    );
  }

  if (editOpening) return <View style={st.center}><ActivityIndicator /><Text style={{ color: C.ink }}>Loading driver profile…</Text></View>;

  if (editingProfile) return <>
    <StatusBar style={themeName === 'dark' ? 'light' : 'dark'} />
    <DriverPicker profiles={[editingProfile]} editProfile={editingProfile} onPick={() => {}} onCreated={reload}
      onCancelEdit={closeEditor} onSaveProfile={async input => {
        await drive.saveProfileEdit(editingProfile, input);
        await reload();
        closeEditor();
      }} />
    <InformationHost blocked={!!drive.safety.check || !!drive.safety.demo} />
  </>;

  return (
    <SafeAreaView style={st.root}>
      <StatusBar style={themeName === 'dark' ? 'light' : 'dark'} />
      <View style={st.header}>
        <View style={{ flex: 1, minWidth: 0 }}><BrandMark /></View>
        <Pressable onPress={switchDriver} style={[st.switch, { maxWidth: '43%', flexDirection: 'row', alignItems: 'center', gap: 6 }]}
          accessibilityRole="button" accessibilityLabel={`Switch driver. Current driver: ${drive.driver.display_name}`}>
          <Text style={[st.driver, { flexShrink: 1 }]}>{drive.driver.display_name}</Text>
          <Text accessible={false} style={st.switchText}>⌄</Text>
        </Pressable>
        <AppearanceMenu />
      </View>


      <View style={{ flex: 1 }}>
        {tab === 'drive' ? drivePage === 'vitals'
          ? <VitalsDetailView drive={drive} onBack={() => setDrivePage(drivePageAfter('back'))} />
          : <View style={{ flex: 1 }}>
            <View style={{ flex: 1, minWidth: 0 }}><DriveView drive={drive} busy={busy} guard={guard} onOpenVitals={() => setDrivePage(drivePageAfter('details'))} onVitalsAnchor={updateVitalsAnchor} /></View>
            {!assistantOpen ? <DraggableSensiLauncher defaultAnchor={vitalsAnchor}><DashboardAssistantEntry mode={SENSI_MODE} language={drive.driver.language ?? 'en'}
              disabled={false}
              error="" onPress={openAssistant} /></DraggableSensiLauncher> : null}
          </View> : null}
        {tab === 'history' ? <HistoryView refreshKey={`${drive.session?.id ?? ''}:${drive.session?.status ?? ''}:${drive.fold.state}`} /> : null}
        {tab === 'settings' ? (
          <SettingsView
            drive={drive}
            gemmaDiagnostics={__DEV__ ? <Btn title="Gemma diagnostics" kind="ghost"
              disabled={drive.hasActiveSession || !!drive.safety.check || !!drive.safety.demo || assistantOpen}
              onPress={() => { if (!drive.hasActiveSession && !drive.safety.check && !drive.safety.demo) setGemmaOpen(true); }} /> : null}
            autoOn={autoOn}
            setAutoOn={setAutoOn}
            onWiped={async () => {
              await drive.leaveDriver();
              await reload();
              setAssistantOpen(false);
              setTab('drive');
            }}
            onEditProfile={() => { void openProfileEditor(); }}
            onShowIntro={() => {
              if (ongoing) { Alert.alert('Safety monitoring active', 'Finish the current recording or safety check and pause the sensor connection before reviewing setup.'); return; }
              setReviewIntro(true);
            }}
          />
        ) : null}
      </View>

      <InformationHost blocked={!!drive.safety.check || !!drive.safety.demo || assistantOpen} />
      <VoiceCheckModal drive={drive} />
      <SensiSafetyConversation drive={drive} onContinue={() => { /* Event-only Sensi. */ }}
        onStandbyClose={() => setAssistantOpen(false)}
        standby={assistantOpen && sensiDestination(drive.safety) === 'standby'
          ? <SensiStandby visible drive={drive} mode={SENSI_MODE} onClose={() => setAssistantOpen(false)} /> : null} />

      <View style={st.tabs}>
        {(
          [
            ['drive', 'Drive'],
            ['history', 'History'],
            ['settings', 'Settings'],
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <Pressable
            key={key}
            onPress={() => { setDrivePage(drivePageAfter('tab')); setTab(key); }}
            style={[st.tab, tab === key && { backgroundColor: tokens.surfaceMuted }]}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === key }}
          >
            <View style={[st.tabBar, tab === key && { backgroundColor: tokens.accent }]} />
            <Text style={[st.tabText, tab === key && { color: C.brand }]}>{label}</Text>
            {key === 'drive' && drive.hasActiveSession ? <View style={st.recDot} /> : null}
          </Pressable>
        ))}
      </View>
    </SafeAreaView>
  );
}

const makeStyles = (tokens: ThemeTokens) => {
  const C = presentationColors(tokens);
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: C.bg },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: C.bg },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingTop: Platform.OS === 'android' ? (NativeStatusBar.currentHeight ?? 0) + 8 : 8,
      paddingHorizontal: 18,
      paddingBottom: 8,
      backgroundColor: C.card,
      borderBottomWidth: 1,
      borderBottomColor: C.line,
    },
    brand: { fontSize: 12, fontWeight: '800', color: C.ink, letterSpacing: 1, textTransform: 'uppercase', borderLeftWidth: 3, borderLeftColor: tokens.accent, paddingLeft: 8 },
    driver: { fontSize: 14, fontWeight: '700', color: C.ink, textAlign: 'right' },
    cid: { fontSize: 12, fontWeight: '600', color: C.sub },
    switch: { minHeight: 44, minWidth: 44, justifyContent: 'center', paddingHorizontal: 4, paddingVertical: 4 },
    switchText: { color: C.sub, fontSize: 12, fontWeight: '600' },
    tabs: {
      flexDirection: 'row',
      backgroundColor: C.card,
      borderTopWidth: 1,
      borderTopColor: C.line,
      paddingBottom: 8,
      paddingHorizontal: 10,
      gap: 6,
    },
    tab: { flex: 1, minHeight: 48, borderRadius: 14, alignItems: 'center', paddingTop: 0, gap: 6 },
    tabBar: { height: 3, width: 18, borderRadius: 2, backgroundColor: 'transparent' },
    tabText: { fontSize: 13, fontWeight: '700', color: C.faint },
    recDot: { position: 'absolute', top: 10, right: '28%', width: 8, height: 8, borderRadius: 4, backgroundColor: tokens.heartAccent },
  });
};

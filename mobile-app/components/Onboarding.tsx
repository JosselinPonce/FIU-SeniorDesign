import { useEffect, useState } from 'react';
import { AppState, Image, Linking, Modal, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../lib/theme/ThemeProvider';
import type { SensiSetup } from '../lib/onboarding/setup';
import { GEMMA_TERMS_URL, GEMMA_POLICY_URL } from '../lib/onboarding/setup';
import { GEMMA_TERMS_TEXT, GEMMA_POLICY_TEXT } from '../lib/onboarding/gemmaTerms';
import { GEMMA_ARTIFACT } from '../modules/gemma-poc/artifact';
import { prepareVoice } from '../lib/voice/speechIO';
import { BrandMark } from './BrandMark';
import { DashboardAssistantEntry } from './DashboardAssistantEntry';
import { VoicePicker } from './VoicePicker';
import { Btn } from './ui';

const TITLES = ['Welcome to DriveSense', 'How DriveSense Works', 'Safety and Privacy', 'Meet Sensi', 'Gemma License and Download', 'Setup Complete'];
export function Onboarding({ onDone, controller, review = false }: { onDone(): void; controller: SensiSetup; review?: boolean }) {
  const { tokens: t } = useTheme();
  const [state, setState] = useState(controller.state);
  const [reviewPage, setReviewPage] = useState(0);
  const [legal, setLegal] = useState<'terms' | 'policy' | null>(null);
  const [linkError, setLinkError] = useState('');
  const [voice, setVoice] = useState<'unknown' | 'granted' | 'denied'>('unknown');
  useEffect(() => {
    const unsubscribe = controller.subscribe(setState);
    const app = AppState.addEventListener('change', next => { if (next !== 'active' && controller.state.busy) controller.cancel(); });
    return () => { unsubscribe(); app.remove(); if (controller.state.busy) controller.cancel(); };
  }, [controller]);
  const page = review ? reviewPage : state.page;
  const model = controller.runtime.state;
  const progress = model.progress;
  const percent = progress ? Math.min(100, Math.max(0, progress.completed / progress.total * 100)) : 0;
  const text = { color: t.textSecondary, fontSize: 16, lineHeight: 24 };
  const heading = { color: t.text, fontSize: 18, fontWeight: '700' as const };
  const point = (title: string, body: string) => <View key={title} style={{ padding: 16, borderRadius: 16, backgroundColor: t.surface, gap: 5 }}><Text style={heading}>{title}</Text><Text style={text}>{body}</Text></View>;
  function acknowledgment(kind: 'notices' | 'terms', label: string) {
    const checked = state[kind];
    return <Pressable accessibilityRole="checkbox" accessibilityLabel={label} accessibilityState={{ checked, disabled: state.busy || review }}
      disabled={state.busy || review} onPress={() => void controller.acknowledge(kind, !checked)}
      style={{ minHeight: 52, padding: 16, borderWidth: 1, borderColor: checked ? t.accent : t.border, borderRadius: 14, flexDirection: 'row', gap: 12, alignItems: 'center' }}>
      <Text accessible={false} style={{ color: t.text, fontSize: 22 }}>{checked ? '☑' : '☐'}</Text><Text style={[text, { flex: 1, color: t.text }]}>{label}</Text>
    </Pressable>;
  }
  const go = (next: number) => { if (review) setReviewPage(next); else void controller.go(next); };
  const nextDisabled = state.busy || (!review && ((page === 2 && !state.notices) || (page === 4 && !state.modelReady)));
  return <SafeAreaView style={{ flex: 1, backgroundColor: t.background }}>
    <View style={{ paddingHorizontal: 24, paddingVertical: 12, gap: 10 }}>
      <Text style={{ color: t.textSecondary }}>DriveSense setup · {page + 1} of 6{review ? ' · Review' : ''}</Text>
      <View accessible={false} style={{ flexDirection: 'row', gap: 6 }}>{TITLES.map((title, i) => <View key={title} style={{ height: 4, flex: 1, borderRadius: 2, backgroundColor: i <= page ? t.accent : t.border }} />)}</View>
    </View>
    <ScrollView key={page} contentContainerStyle={{ padding: 24, paddingTop: 12, gap: 18, flexGrow: 1 }}>
      <Text accessibilityRole="header" style={{ color: t.text, fontSize: 29, lineHeight: 36, fontWeight: '800' }}>{TITLES[page]}</Text>
      {page === 0 ? <>
        <View style={{ alignSelf: 'center', width: '100%', maxWidth: 390, paddingVertical: 20 }}>
          <View style={{ alignItems: 'center', marginBottom: 20 }}><BrandLogo /></View>
          <BrandMark />
        </View>
        <Text style={text}>DriveSense monitors steering-wheel sensor readings and offers driver-safety assistance through Sensi.</Text>
        {point('Safety assistance, with you in control', 'Connect your steering-wheel sensors and keep DriveSense open. Sensi checks how you feel when readings remain concerning.')}
      </> : null}
      {page === 1 ? <>
        {point('1 · Measure', 'Steering-wheel sensors collect heart rate and blood oxygen (SpO₂) measurements.')}
        {point('2 · Connect', 'The Raspberry Pi communicates sensor data to this mobile application.')}
        {point('3 · Evaluate', 'DriveSense checks accepted readings for persistent, concerning changes.')}
        {point('4 · Check in', 'Sensi automatically begins a safety check when supported foreground monitoring detects an event.')}
        <Text style={text}>Start Drive controls trip recording. It is not required for safety monitoring. A configured driver, connected sensors and fresh valid readings are required.</Text>
        <Text style={text}>Keep DriveSense open on a supported screen. Background and locked-phone VoiceCheck are not supported.</Text>
      </> : null}
      {page === 2 ? <>
        {point('A prototype, not a diagnosis', 'DriveSense is a prototype driver-safety system, not a medical device or diagnostic service. Measurements may be inaccurate or temporarily unavailable.')}
        {point('Road safety comes first', 'Prioritize the road. Pull over somewhere safe before interacting with the screen.')}
        {point('Calls require your authorization', 'Emergency-contact phone handoff requires your explicit request or agreement. Opening the iPhone dialer does not guarantee a connected call.')}
        {point('On-device inference, connected application features', 'Gemma inference runs locally on your device. Other features may use Supabase for authentication, storage or synchronization. Not all application data stays on-device.')}
        {point('Your profile and recordings', 'Your profile helps set your starting range. Start Drive records a trip: vitals only by default, or optional full waveform. Existing recording, synchronization and deletion controls remain in Settings.')}
        <Text style={[text, { fontSize: 13 }]}>These are prototype safety and privacy notices, not a legally reviewed agreement.</Text>
        {acknowledgment('notices', 'I have read and acknowledge these DriveSense safety and privacy notices.')}
      </> : null}
      {page === 3 ? <>
        <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ alignSelf: 'center', padding: 12 }}>
          <DashboardAssistantEntry mode="local" language="en" disabled={false} error="" onPress={() => {}} />
        </View>
        <Text style={[heading, { fontSize: 24 }]}>Hi, I'm Sensi!</Text>
        <Text style={text}>I'm your offline safety assistant. I respond to concerning sensor readings, not general chat. You can answer by voice, typed response or the available buttons.</Text>
        {point('A brief acknowledgment', 'Gemma helps select brief, approved acknowledgments. Safety decisions, pull-over guidance, contact offers and call authorization follow fixed rules.')}
        {point('A familiar voice', 'Sensi uses the system voices installed on your device. Premium voices can be selected when available.')}
        {!review ? <Btn title={voice === 'granted' ? 'Voice permission allowed' : voice === 'denied' ? 'Retry voice permission' : 'Allow voice responses (optional)'}
          disabled={voice === 'granted'} onPress={() => { void prepareVoice().then(result => setVoice(result.granted ? 'granted' : 'denied')); }} /> : null}
        {voice === 'denied' ? <Text style={text}>Voice access is unavailable. Typed and button responses remain available; permission can be changed in system Settings.</Text> : null}
        <VoicePicker lang="en" driverName="" />
      </> : null}
      {page === 4 ? <>
        <Text style={text}>Gemma 3 270M Instruct · QAT Q4_0 GGUF · approximately 241 MB. Download once, then use offline. Existing verified installations are reused.</Text>
        <Text style={text}>Gemma is subject to Google's Gemma Terms of Use and Prohibited Use Policy. By accepting, you agree to comply with those terms and use restrictions.</Text>
        <Btn title="Read Gemma Terms of Use" kind="ghost" onPress={() => setLegal('terms')} />
        <Btn title="Read Gemma Prohibited Use Policy" kind="ghost" onPress={() => setLegal('policy')} />
        {acknowledgment('terms', 'I accept the Gemma Terms of Use, including the Prohibited Use Policy and its use restrictions.')}
        <Text selectable style={[text, { fontSize: 12 }]}>{GEMMA_ARTIFACT.filename}</Text>
        {!review ? <>
          <Text accessibilityLiveRegion="polite" style={heading}>{state.busy ? model.phase : state.modelReady ? 'Sensi model ready' : state.recovery ? 'Setup needs attention' : 'Ready to install'}</Text>
          {progress ? <View style={{ gap: 8 }}>
            <Text style={text}>{progress.stage === 'download' ? 'Downloaded' : 'SHA-256 checked'} {(progress.completed / 1_000_000).toFixed(1)} / {(progress.total / 1_000_000).toFixed(1)} MB · {percent.toFixed(1)}%</Text>
            <View accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.round(percent) }} style={{ height: 8, borderRadius: 4, overflow: 'hidden', backgroundColor: t.border }}>
              <View style={{ width: `${percent}%`, height: 8, backgroundColor: t.accent }} />
            </View>
          </View> : null}
          <Text style={text}>Verification: {model.installed ? 'complete' : 'required'} · Installation: {model.installed ? 'verified file available' : 'not complete'}</Text>
          <Text style={text}>Runtime: {state.modelReady ? 'readiness confirmed' : model.loaded ? 'initialized; finishing cleanup' : state.busy && model.phase === 'Loading model' ? 'initializing…' : 'not yet confirmed'}</Text>
          <Text style={[text, { fontSize: 13 }]}>Keep the app open during setup. An interrupted partial transfer is discarded safely; a retry uses the same storage location. A valid existing model is checked before any download.</Text>
          <Btn title={state.modelReady ? 'Sensi is ready' : state.error ? 'Retry setup' : 'Accept terms and install Sensi'} disabled={state.busy || state.modelReady || !state.terms || !state.notices} onPress={() => { void controller.prepare(); }} />
          {state.busy ? <Btn title="Cancel setup operation" kind="ghost" onPress={() => controller.cancel()} /> : null}
        </> : <Text style={text}>Setup was completed. Model availability is checked at application launch; safety interactions retain fixed fallback acknowledgments if inference becomes unavailable.</Text>}
      </> : null}
      {page === 5 ? <>
        {point(review ? 'Setup previously completed' : 'Sensi’s offline model is ready', review
          ? 'Readiness is checked on launch. Safety interactions retain fixed fallback acknowledgments if inference becomes unavailable.'
          : 'The approved model passed integrity verification and initialized successfully on this device. Setup did not start a safety conversation.')}
        <Text style={text}>Continue to select an existing driver or create your driver profile. Existing profiles and recordings are preserved.</Text>
      </> : null}
      {state.error && !review ? <Text accessibilityRole="alert" selectable style={{ color: t.danger, fontSize: 16, lineHeight: 24 }}>{state.error}</Text> : null}
    </ScrollView>
    <View style={{ flexDirection: 'row', gap: 12, padding: 20, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderColor: t.border }}>
      {page > 0 ? <Btn title="Back" kind="ghost" disabled={state.busy} onPress={() => go(page - 1)} style={{ flex: 1 }} /> : null}
      <Btn title={page === 5 ? 'Continue to DriveSense' : 'Next'} disabled={nextDisabled} style={{ flex: 2 }} onPress={() => {
        if (page < 5) go(page + 1);
        else if (review) onDone();
        else void controller.complete().then(done => { if (done) onDone(); });
      }} />
    </View>
    <Modal visible={legal !== null} animationType="slide" onRequestClose={() => setLegal(null)}>
      <SafeAreaView style={{ flex: 1, backgroundColor: t.background }}>
        <ScrollView contentContainerStyle={{ padding: 24, gap: 20 }}>
          <Text accessibilityRole="header" style={heading}>{legal === 'policy' ? 'Gemma Prohibited Use Policy' : 'Gemma Terms of Use'}</Text>
          <Text accessibilityRole="link" style={{ color: t.text, textDecorationLine: 'underline' }} onPress={() => {
            void Linking.openURL(legal === 'policy' ? GEMMA_POLICY_URL : GEMMA_TERMS_URL).catch(() => setLinkError('Could not open the website. The official text is available below.'));
          }}>Open official Google source</Text>
          {linkError ? <Text accessibilityRole="alert" style={text}>{linkError}</Text> : null}
          <Text selectable style={text}>{legal === 'policy' ? GEMMA_POLICY_TEXT : GEMMA_TERMS_TEXT}</Text>
        </ScrollView>
        <View style={{ padding: 20 }}><Btn title="Return to setup" onPress={() => setLegal(null)} /></View>
      </SafeAreaView>
    </Modal>
  </SafeAreaView>;
}

// Approved steering-wheel/heart original already supplied in assets/branding.
function BrandLogo() { return <Image source={require('../assets/branding/drivesense-logo.png')}
  accessibilityLabel="DriveSense steering wheel and heart logo" resizeMode="contain" style={{ width: 176, height: 176, borderRadius: 28 }} />; }

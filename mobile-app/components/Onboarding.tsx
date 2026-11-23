import { LocalizedPressable as Pressable, LocalizedText as Text } from '../lib/i18n/native';
import { useEffect, useRef, useState } from 'react';
import { Image, SafeAreaView, ScrollView, StyleSheet, View } from 'react-native';
import { useTheme } from '../lib/theme/ThemeProvider';
import type { sensiSetup } from '../lib/onboarding/builtInPhone';
import { prepareVoice } from '../lib/voice/speechIO';
import { BrandMark } from './BrandMark';
import { VoicePicker } from './VoicePicker';
import { Btn } from './ui';
import { LanguageMenu } from './LanguageMenu';
import * as repo from '../lib/db/repositories';

const TITLES = ['Welcome to DriveSense', 'How DriveSense Works', 'Safety and Privacy', 'Meet Sensi', 'Setup Complete'];
export function Onboarding({ onDone, onChooseDriver, controller, review = false }: { onDone(): void; onChooseDriver?(): void; controller: typeof sensiSetup; review?: boolean }) {
  const { tokens: t } = useTheme();
  const [state, setState] = useState(controller.state);
  const [reviewPage, setReviewPage] = useState(0);
  const [linkError, setLinkError] = useState('');
  const [voice, setVoice] = useState<'unknown' | 'granted' | 'denied'>('unknown');
  const [education, setEducation] = useState(0);
  const [voiceLanguage, setVoiceLanguage] = useState<'en' | 'es'>('en');
  const educationTouched = useRef(false);
  const voiceLanguageTouched = useRef(false);
  const preferenceWrites = useRef(Promise.resolve<unknown>(undefined));
  function savePreference(key: string, value: string) {
    const pending = preferenceWrites.current.then(() => repo.setSetting(key, value));
    preferenceWrites.current = pending.catch(() => setLinkError('Could not save setup progress.'));
  }
  useEffect(() => {
    let alive = true;
    void Promise.all([repo.getSetting('setup_education_step'), repo.getSetting('voicecheck_default_language')]).then(([step, language]) => {
      if (alive) {
        if (!educationTouched.current && !review) setEducation(step === '1' ? 1 : step === '2' ? 2 : 0);
        if (!voiceLanguageTouched.current) setVoiceLanguage(language === 'es' ? 'es' : 'en');
      }
    }).catch(() => {});
    return () => { alive = false; };
  }, []);
  function educationPage(next: number) {
    educationTouched.current = true;
    setEducation(next);
    if (!review) savePreference('setup_education_step', String(next));
  }
  useEffect(() => controller.subscribe(setState), [controller]);
  const page = review ? reviewPage : Math.min(state.page, 4);
  const text = { color: t.textSecondary, fontSize: 16, lineHeight: 24 };
  const heading = { color: t.text, fontSize: 18, fontWeight: '700' as const };
  const point = (title: string, body: string) => <View key={title} style={{ padding: 16, borderRadius: 16, backgroundColor: t.surface, gap: 5 }}><Text style={heading}>{title}</Text><Text style={text}>{body}</Text></View>;
  function acknowledgment(label: string) {
    const checked = state.notices;
    return <Pressable accessibilityRole="checkbox" accessibilityLabel={label} accessibilityState={{ checked, disabled: state.busy || review }}
      disabled={state.busy || review} onPress={() => void controller.acknowledge(!checked)}
      style={{ minHeight: 52, padding: 16, borderWidth: 1, borderColor: checked ? t.accent : t.border, borderRadius: 14, flexDirection: 'row', gap: 12, alignItems: 'center' }}>
      <Text accessible={false} style={{ color: t.text, fontSize: 22 }}>{checked ? '☑' : '☐'}</Text><Text style={[text, { flex: 1, color: t.text }]}>{label}</Text>
    </Pressable>;
  }
  const go = (next: number) => { if (review) setReviewPage(next); else void controller.go(next); };
  const nextDisabled = state.busy || (!review && (page === 2 || page === 4) && !state.notices);
  return <SafeAreaView style={{ flex: 1, backgroundColor: t.background }}>
    <View style={{ paddingHorizontal: 20, paddingVertical: 6, gap: 6 }}>
      <LanguageMenu />
      <Text style={{ color: t.textSecondary }}>DriveSense setup · {page + 1} of 5{review ? ' · Review' : ''}</Text>
      <View accessible={false} style={{ flexDirection: 'row', gap: 6 }}>{TITLES.map((title, i) => <View key={title} style={{ height: 4, flex: 1, borderRadius: 2, backgroundColor: i <= page ? t.accent : t.border }} />)}</View>
    </View>
    <ScrollView key={page} contentContainerStyle={{ padding: 20, paddingTop: 12, gap: 16, flexGrow: 1 }}>
      <Text accessibilityRole="header" style={{ color: t.text, fontSize: 26, fontWeight: '800' }}>{page === 1 && education > 0 ? education === 1 ? 'Monitoring That’s Personal to You' : 'Understanding Your Safety Alerts' : TITLES[page]}</Text>
      {page === 0 ? <>
        <View style={{ alignSelf: 'center', width: '100%', maxWidth: 390, paddingVertical: 20 }}>
          <View style={{ alignItems: 'center', marginBottom: 20 }}><BrandLogo /></View>
          <BrandMark />
        </View>
        <Text style={text}>DriveSense monitors steering-wheel sensor readings and offers driver-safety assistance through Sensi.</Text>
        {point('Safety assistance, with you in control', 'Connect your steering-wheel sensors and keep DriveSense open. Sensi checks how you feel when readings remain concerning.')}
      </> : null}
      {page === 1 && education === 0 ? <>
        {point('1 · Measure', 'Steering-wheel sensors collect heart rate and blood oxygen (SpO₂) measurements.')}
        {point('2 · Connect', 'The Raspberry Pi communicates sensor data to this mobile application.')}
        {point('3 · Evaluate', 'DriveSense checks accepted readings for persistent, concerning changes.')}
        {point('4 · Check in', 'Sensi automatically begins a safety check when supported foreground monitoring detects an event.')}
        <Text style={text}>Start Drive controls trip recording. It is not required for safety monitoring. A configured driver, connected sensors and fresh valid readings are required.</Text>
        <Text style={text}>Keep DriveSense open on a supported screen. Background and locked-phone VoiceCheck are not supported.</Text>
      </> : null}
      {page === 1 && education === 1 ? <>
        <Text style={text}>Your profile sets the initial ranges. Valid readings from finished drives build a personal reference after at least 60 heart-rate readings. Heart rate and available SpO₂ are summarized using recent drives (28 days, extending to the last 10 drives when needed). Poor-quality readings and periods around NOT OK or unanswered events are excluded.</Text>
        <Text style={text}>The reference refreshes after saved drives. Optional reference-device calibration corrects heart rate only; oxygen is compared, never corrected. Calibration is not required to start monitoring.</Text>
      </> : null}
      {page === 1 && education === 2 ? <Text style={text}>Persistent heart-rate or oxygen changes start a confirmation window: 15 seconds for warnings, 8 seconds for critical conditions. Only a confirmed event starts VoiceCheck. Answer by voice, typing or buttons. Contact assistance requires explicit consent; critical readings never automatically call emergency services. This is a monitoring prototype, not a medical diagnosis.</Text> : null}
      {page === 2 ? <>
        {point('A prototype, not a diagnosis', 'DriveSense is a prototype driver-safety system, not a medical device or diagnostic service. Measurements may be inaccurate or temporarily unavailable.')}
        {point('Road safety comes first', 'Prioritize the road. Pull over somewhere safe before interacting with the screen.')}
        {point('Calls require your authorization', 'Emergency-contact phone handoff requires your explicit request or agreement. Opening the iPhone dialer does not guarantee a connected call.')}
        {point('On-device safety checks', 'Sensi processes safety-check speech on this phone. Drive recording and dashboard synchronization are separate features.')}
        {point('Your profile and recordings', 'Your profile helps set your starting range. Start Drive records a trip: vitals only by default, or optional full waveform. Existing recording, synchronization and deletion controls remain in Settings.')}
        <Text style={[text, { fontSize: 13 }]}>These are prototype safety and privacy notices, not a legally reviewed agreement.</Text>
        {acknowledgment('I have read and acknowledge these DriveSense safety and privacy notices.')}
      </> : null}
      {page === 3 ? <>
        <Text style={text}>Sensi is your built-in driving safety assistant. After a confirmed warning, answer by voice, typing or buttons. Contact assistance requires your explicit authorization.</Text>
        {!review ? <Btn title={voice === 'granted' ? 'Voice permission allowed' : voice === 'denied' ? 'Retry voice permission' : 'Allow voice responses (optional)'}
          disabled={voice === 'granted'} onPress={() => { void prepareVoice().then(result => setVoice(result.granted ? 'granted' : 'denied')); }} /> : null}
        {voice === 'denied' ? <Text style={text}>Voice access is unavailable. Typed and button responses remain available; permission can be changed in system Settings.</Text> : null}
        <Text style={heading}>VoiceCheck language</Text>
        <Text style={text}>Choose the default spoken language for new driver profiles. Existing drivers keep their saved VoiceCheck language; edit their profile to change it. App language is independent.</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{(['en', 'es'] as const).map(language => <Btn key={language}
          title={`${voiceLanguage === language ? '✓ ' : ''}${language === 'es' ? 'Español' : 'English'}`} kind="ghost" onPress={() => {
            setVoiceLanguage(language);
            voiceLanguageTouched.current = true;
            savePreference('voicecheck_default_language', language);
          }} />)}</View>
        <VoicePicker lang={voiceLanguage} driverName="" />
      </> : null}
      {page === 4 ? <>
        {point(review ? 'Setup previously completed' : 'DriveSense is ready', 'Safety checks are available with voice and manual response options.')}
        <Text style={text}>Continue to select an existing driver or create your driver profile. Existing profiles and recordings are preserved.</Text>
      </> : null}
      {review ? <>
        <Btn title="Return to application" kind="ghost" onPress={onDone} />
        {onChooseDriver ? <Btn title="Choose or create a driver" kind="ghost" onPress={onChooseDriver} /> : null}
      </> : null}
      {state.error && !review ? <Text accessibilityRole="alert" selectable style={{ color: t.danger, fontSize: 16, lineHeight: 24 }}>{state.error}</Text> : null}
      {linkError ? <Text accessibilityRole="alert" style={text}>{linkError}</Text> : null}
    </ScrollView>
    <View style={{ flexDirection: 'row', gap: 12, padding: 20, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderColor: t.border }}>
      {page > 0 ? <Btn title="Back" kind="ghost" disabled={state.busy} onPress={() => { if (page === 1 && education > 0) educationPage(education - 1); else go(page - 1); }} style={{ flex: 1 }} /> : null}
      <Btn title={page === 4 ? 'Continue to DriveSense' : 'Next'} disabled={nextDisabled} style={{ flex: 2 }} onPress={() => {
        if (page === 1 && education < 2) educationPage(education + 1);
        else if (page < 4) go(page + 1);
        else if (review) onDone();
        else void controller.complete().then(done => { if (done) onDone(); });
      }} />
    </View>
  </SafeAreaView>;
}

// Approved steering-wheel/heart original already supplied in assets/branding.
function BrandLogo() { return <Image source={require('../assets/branding/drivesense-logo.png')}
  accessibilityLabel="DriveSense steering wheel and heart logo" resizeMode="contain" style={{ width: 176, height: 176, borderRadius: 28 }} />; }

import { LocalizedPressable as Pressable, LocalizedText as Text } from '../lib/i18n/native';
import { useEffect, useState } from 'react';
import { Image, SafeAreaView, ScrollView, StyleSheet, View } from 'react-native';
import Feather from 'expo/node_modules/@expo/vector-icons/Feather';
import { useTheme } from '../lib/theme/ThemeProvider';
import { useAppLanguage } from '../lib/i18n/LanguageProvider';
import type { sensiSetup } from '../lib/onboarding/builtInPhone';
import { prepareVoice } from '../lib/voice/speechIO';
import { SensiGlyph } from './DashboardAssistantEntry';
import { VoicePicker } from './VoicePicker';
import { Btn } from './ui';
import { LanguageMenu } from './LanguageMenu';
import { getSetting, setSetting } from '../lib/db/repositories';
import { AskSensi } from './AskSensi';

const TITLES = ['Welcome to DriveSense', 'How DriveSense Works', 'Personalized Monitoring', 'Meet Sensi', 'Ask Sensi', 'Safety and Privacy'];

export function Onboarding({ onDone, onLeave, controller, driverId, voiceLanguage = 'en', review = false }: {
  onDone(): void; onLeave(): void; controller: typeof sensiSetup; driverId?: string; voiceLanguage?: 'en' | 'es'; review?: boolean;
}) {
  const { tokens: t } = useTheme();
  const { t: translate } = useAppLanguage();
  const [state, setState] = useState(controller.state);
  const [reviewPage, setReviewPage] = useState(0);
  const [voice, setVoice] = useState<'unknown' | 'requesting' | 'granted' | 'denied'>('unknown');
  const [showAskSettings, setShowAskSettings] = useState(false);
  const [futureVoice, setFutureVoice] = useState<'en' | 'es' | null>(null);
  const [preferenceError, setPreferenceError] = useState(false);
  useEffect(() => {
    if (review) return;
    let active = true;
    void getSetting('voicecheck_default_language').then(value => {
      if (active) setFutureVoice(value === 'es' ? 'es' : 'en');
    }).catch(() => { if (active) setPreferenceError(true); });
    return () => { active = false; };
  }, [review]);
  useEffect(() => controller.subscribe(setState), [controller]);
  const page = review ? reviewPage : Math.min(state.page, TITLES.length - 1);
  const last = page === TITLES.length - 1;
  const text = { color: t.textSecondary, fontSize: 15, lineHeight: 22 };
  const heading = { color: t.text, fontSize: 16, fontWeight: '700' as const };
  const point = (icon: React.ComponentProps<typeof Feather>['name'], title: string, body: string) => (
    <View style={{ flexDirection: 'row', gap: 12, padding: 12, borderRadius: 14, backgroundColor: t.surfaceMuted }}>
      <Feather name={icon} size={19} color={t.primary} accessible={false} />
      <View style={{ flex: 1, gap: 3 }}><Text style={heading}>{title}</Text><Text style={text}>{body}</Text></View>
    </View>
  );
  const go = (next: number) => { if (review) setReviewPage(next); else void controller.go(next); };
  return <SafeAreaView style={{ flex: 1, backgroundColor: t.background }}>
    <View style={{ paddingHorizontal: 20, paddingVertical: 8, gap: 8 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <LanguageMenu />
        <Btn title={review ? 'Close review' : 'Finish later'} kind="ghost" disabled={state.busy} onPress={onLeave} />
      </View>
      <View accessible accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: TITLES.length, now: page + 1 }}
        style={{ flexDirection: 'row', gap: 5 }}>
        {TITLES.map((title, i) => <View key={title} style={{ height: 4, flex: 1, borderRadius: 2, backgroundColor: i <= page ? t.accent : t.border }} />)}
      </View>
      <Text localize={false} style={{ ...text, fontSize: 13 }}>{translate('Step {current} of {total}').replace('{current}', String(page + 1)).replace('{total}', String(TITLES.length))}</Text>
    </View>
    <ScrollView key={page} contentContainerStyle={{ padding: 20, paddingTop: 12, gap: 12, flexGrow: 1 }}>
      {page === 0 ? <View style={{ alignItems: 'center', gap: 9, paddingVertical: 16 }}>
        <Image source={require('../assets/branding/drivesense-logo.png')} accessibilityLabel={translate('DriveSense steering wheel and heart logo')}
          resizeMode="contain" style={{ width: 140, height: 140, borderRadius: 22 }} />
        <Text accessibilityRole="header" style={{ color: t.text, fontSize: 28, fontWeight: '800', textAlign: 'center' }}>Welcome to DriveSense</Text>
        <Text style={[text, { textAlign: 'center' }]}>Driven by Safety. Powered by Insight.</Text>
      </View> : <Text accessibilityRole="header" style={{ color: t.text, fontSize: 26, fontWeight: '800' }}>{TITLES[page]}</Text>}
      {page === 0 ? <>
        <Text style={[text, { textAlign: 'center' }]}>DriveSense pairs steering-wheel monitoring with Sensi, your driving safety companion.</Text>
        {point('shield', 'Safety assistance, with you in control', 'Connect your steering-wheel sensors and keep DriveSense open. Sensi checks how you feel when readings remain concerning.')}
      </> : null}
      {page === 1 ? <>
        {point('activity', 'Measure', 'Steering-wheel sensors collect heart rate and blood oxygen (SpO₂) measurements.')}
        {point('radio', 'Connect', 'The Raspberry Pi communicates sensor data to this mobile application.')}
        {point('check-circle', 'Evaluate', 'DriveSense checks accepted readings for persistent, concerning changes.')}
        <Text style={text}>Start Drive controls trip recording. It is not required for safety monitoring. A configured driver, connected sensors and fresh valid readings are required.</Text>
        <Text style={text}>Keep DriveSense open on a supported screen. Background and locked-phone VoiceCheck are not supported.</Text>
      </> : null}
      {page === 2 ? <>
        {point('sliders', 'Your personal reference', 'Your profile sets starting ranges. At least 60 qualifying heart-rate readings from finished drives are needed to establish a personal reference.')}
        {point('activity', 'Adaptive baseline', 'DriveSense uses recent drives from 28 days, extending to the last 10 drives when needed. Poor-quality readings and periods around NOT OK or unanswered events are excluded.')}
        {point('target', 'Reference-device calibration', 'The reference refreshes after saved drives. Optional reference-device calibration corrects heart rate only; oxygen is compared, never corrected. Calibration is not required to start monitoring.')}
        {point('clock', 'How alerts are confirmed', 'Tracking uses a 15-second warning window or an 8-second critical window. Only sustained, usable evidence can confirm an event and start VoiceCheck.')}
      </> : null}
      {page === 3 ? <>
        <View style={{ width: 52, height: 52, alignItems: 'center', justifyContent: 'center', borderRadius: 17, backgroundColor: t.primary }}><SensiGlyph color={t.onPrimary} /></View>
        {point('mic', 'On-device safety checks', 'After a confirmed concerning reading, Sensi automatically checks how you feel. Speech is processed on this phone. You can also type or use the response buttons.')}
        {point('phone', 'Calls require your authorization', 'Sensi only opens emergency-contact assistance after you explicitly agree. iOS asks for confirmation before dialing. A critical reading never automatically calls emergency services.')}
        {!review ? <Btn title={voice === 'granted' ? 'Voice permission allowed' : voice === 'denied' ? 'Retry voice permission' : 'Allow voice responses (optional)'}
          disabled={voice === 'granted' || voice === 'requesting'} onPress={() => {
            setVoice('requesting');
            void prepareVoice().then(result => setVoice(result.granted ? 'granted' : 'denied'), () => setVoice('denied'));
          }} /> : null}
        {voice === 'denied' ? <Text style={text}>Voice access is unavailable. Typed and button responses remain available; permission can be changed in system Settings.</Text> : null}
        {!review ? <>
          <VoicePicker lang={voiceLanguage} driverName="" />
          <Text style={text}>Default voice language for future drivers</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {(['en', 'es'] as const).map(lang => <Btn key={lang} kind="ghost"
              title={translate(lang === 'en' ? 'English' : 'Spanish')} accessibilityState={{ selected: futureVoice === lang }}
              onPress={() => { void setSetting('voicecheck_default_language', lang).then(() => setFutureVoice(lang), () => setPreferenceError(true)); }} />)}
          </View>
        </> : null}
      </> : null}
      {page === 4 ? <>
        {point('message-circle', 'Ask about DriveSense', 'Get AI-powered answers, recorded-drive summaries, and explanations of biometrics and your personal baseline when authorized.')}
        {point('cloud', 'Optional cloud assistance', 'Ask Sensi uses OpenAI and requires internet access and sign-in. Sharing drive or personal biometric data requires separate approval.')}
        <Text style={text}>You can decline or revoke cloud access at any time. Safety Sensi stays available offline. Finishing setup or enabling a preference does not send biometric or drive data.</Text>
        {driverId ? <Btn title="Ask Sensi settings" kind="ghost" onPress={() => setShowAskSettings(true)} /> : null}
      </> : null}
      {last ? <>
        {point('alert-circle', 'A prototype, not a diagnosis', 'DriveSense is a prototype driver-safety system, not a medical device or diagnostic service. Measurements may be inaccurate or temporarily unavailable.')}
        {point('navigation', 'Road safety comes first', 'Prioritize the road. Pull over somewhere safe before interacting with the screen.')}
        {point('phone', 'Calls require your authorization', 'Emergency-contact phone handoff requires your explicit request or agreement. Opening the iPhone dialer does not guarantee a connected call.')}
        {point('database', 'Your profile and recordings', 'Your profile helps set your starting range. Start Drive records a trip: vitals only by default, or optional full waveform. Existing recording, synchronization and deletion controls remain in Settings.')}
        <Text style={text}>Drive recording and dashboard synchronization are separate features. These are prototype safety and privacy notices, not a legally reviewed agreement.</Text>
        {!review ? <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: state.notices, disabled: state.busy }}
          disabled={state.busy} onPress={() => void controller.acknowledge(!state.notices)}
          style={{ flexDirection: 'row', gap: 10, alignItems: 'center', minHeight: 48 }}>
          <Feather name={state.notices ? 'check-square' : 'square'} size={21} color={t.primary} accessible={false} />
          <Text style={{ ...text, flex: 1, color: t.text }}>I have read and acknowledge these DriveSense safety and privacy notices.</Text>
        </Pressable> : null}
      </> : null}
      {preferenceError ? <Text accessibilityRole="alert" style={text}>Could not save setup progress.</Text> : null}
      {state.error && !review ? <Text accessibilityRole="alert" style={{ ...text, color: t.danger }}>{state.error}</Text> : null}
    </ScrollView>
    <View style={{ flexDirection: 'row', gap: 10, padding: 16, borderTopWidth: StyleSheet.hairlineWidth, borderColor: t.border }}>
      {page > 0 ? <Btn title="Back" kind="ghost" disabled={state.busy} onPress={() => go(page - 1)} style={{ flex: 1 }} /> : null}
      <Btn title={last ? 'Continue to DriveSense' : 'Next'} disabled={state.busy || (!review && last && !state.notices)} style={{ flex: 2 }} onPress={() => {
        if (!last) go(page + 1);
        else if (review) onDone();
        else void controller.complete().then(done => { if (done) onDone(); });
      }} />
    </View>
    {showAskSettings && driverId ? <AskSensi driverId={driverId} settingsOnly onBack={() => setShowAskSettings(false)} /> : null}
  </SafeAreaView>;
}

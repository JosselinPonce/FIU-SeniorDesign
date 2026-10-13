import { useTheme } from '../lib/theme/ThemeProvider';
import { presentationColors, type ThemeTokens } from '../lib/theme/tokens';
/**
 * First-run introduction: what Smart Wheel does, how the safety check works,
 * why the profile matters, what happens to the data, and voice setup.
 * Shown once (app_settings 'onboarded'); Settings → "Show the introduction
 * again" reopens it.
 */
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { prepareVoice } from '../lib/voice/speechIO';
import { Btn } from './ui';
import { VoicePicker } from './VoicePicker';

type Page = { eyebrow: string; title: string; body?: string; points?: [string, string][]; voice?: boolean };

const PAGES: Page[] = [
  {
    eyebrow: 'Welcome',
    title: 'Your steering wheel keeps an eye on your heart',
    body:
      'A small sensor on the wheel reads your heart rate and blood oxygen through your fingertip while you drive. The wheel sends it to the Raspberry Pi in the car, the Pi sends it to this phone, and the phone saves it and shares it with your team’s dashboard.',
    points: [
      ['Hands on the wheel', 'Rest a fingertip on the sensor. The app tells you when it has a good signal.'],
      ['Nothing to press', 'Once you pick who’s driving, the phone connects to the car by itself.'],
    ],
  },
  {
    eyebrow: 'How it looks out for you',
    title: 'It only speaks up when something stays unusual',
    points: [
      ['1 · Watch quietly', 'Every second is checked. Single odd readings from bumps or grip are ignored.'],
      ['2 · Confirm', 'If your heart rate or oxygen stays outside your range, it watches for 15 more seconds (8 if it’s far outside).'],
      ['3 · Ask you', 'Only then the phone vibrates and asks out loud: “Are you feeling okay?” Just say yes or no — or tap.'],
      ['4 · If you’re not OK', 'It tells you to pull over and call 911. No answer counts as not OK.'],
    ],
    body: 'This is a student prototype, not a medical device. It does not call anyone for you yet.',
  },
  {
    eyebrow: 'Your profile',
    title: 'Your details set what “normal” means for you',
    points: [
      ['Age, sex, height, weight', 'Set your starting range from real-world data on 66,000 people (Avram et al. 2019). BMI is worked out for you.'],
      ['Health conditions', 'Some conditions change your usual heart rate; COPD changes how oxygen is judged.'],
      ['It learns you', 'After about 10 minutes of your own driving, your range follows your real numbers.'],
      ['“I’m OK” teaches it', 'If it asks and you’re fine, it moves your line a little so it doesn’t ask again for the same thing.'],
    ],
  },
  {
    eyebrow: 'Your data',
    title: 'You decide what’s kept',
    points: [
      ['Vitals only (default)', 'Heart rate and oxygen once a second — nothing else.'],
      ['Full waveform (optional)', 'For research: every raw sample, packed into a small verified file when the drive ends.'],
      ['Live dashboard', 'Drives show up live on your team’s website while you have signal; saved on the phone first.'],
      ['Delete any time', 'Delete one drive, one driver, or everything — here and on the dashboard.'],
    ],
  },
  {
    eyebrow: 'Voice',
    title: 'Let it talk to you',
    body:
      'Allow the microphone so you can answer out loud. Speech is handled by the phone itself — nothing you say is recorded or stored. Tap a voice to hear it; Premium voices sound most natural.',
    voice: true,
  },
];

export function Onboarding(props: { onDone: () => void }) {
  const { colors: C, tokens } = useTheme();
  const st = makeStyles(tokens);
  const [i, setI] = useState(0);
  const [voice, setVoice] = useState<'unknown' | 'granted' | 'denied'>('unknown');
  const page = PAGES[i]!;
  const last = i === PAGES.length - 1;

  return (
    <View style={st.root}>
      <View style={st.top}>
        <View style={st.dots}>
          {PAGES.map((_, k) => (
            <View key={k} style={[st.dot, k === i && st.dotOn]} />
          ))}
        </View>
        {!last ? (
          <Pressable onPress={props.onDone} accessibilityRole="button">
            <Text style={st.skip}>Skip</Text>
          </Pressable>
        ) : null}
      </View>

      <ScrollView contentContainerStyle={st.body}>
        <Text style={st.eyebrow}>{page.eyebrow}</Text>
        <Text style={st.title}>{page.title}</Text>
        {page.body && !page.points ? <Text style={st.text}>{page.body}</Text> : null}
        {page.points?.map(([h, t]) => (
          <View key={h} style={st.point}>
            <Text style={st.pointHead}>{h}</Text>
            <Text style={st.text}>{t}</Text>
          </View>
        ))}
        {page.body && page.points ? <Text style={[st.text, st.small]}>{page.body}</Text> : null}
        {page.voice ? (
          <View style={{ gap: 12 }}>
            {voice !== 'granted' ? (
              <Btn
                title={voice === 'denied' ? 'Microphone not allowed — open iPhone Settings to change' : 'Allow microphone'}
                kind={voice === 'denied' ? 'ghost' : 'primary'}
                onPress={async () => setVoice((await prepareVoice()).granted ? 'granted' : 'denied')}
              />
            ) : (
              <Text style={[st.text, { color: C.good, fontWeight: '700' }]}>Microphone allowed ✓</Text>
            )}
            <VoicePicker lang="en" driverName="" />
          </View>
        ) : null}
      </ScrollView>

      <View style={st.nav}>
        {i > 0 ? <Btn title="Back" kind="ghost" onPress={() => setI(i - 1)} style={{ flex: 1 }} /> : <View style={{ flex: 1 }} />}
        <Btn title={last ? 'Get started' : 'Next'} onPress={() => (last ? props.onDone() : setI(i + 1))} style={{ flex: 2 }} />
      </View>
    </View>
  );
}

const makeStyles = (tokens: ThemeTokens) => {
  const C = presentationColors(tokens);
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: C.bg, paddingTop: 60 },
    top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 22 },
    dots: { flexDirection: 'row', gap: 6 },
    dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: C.line },
    dotOn: { width: 22, backgroundColor: C.brand },
    skip: { color: C.sub, fontWeight: '700', fontSize: 15 },
    body: { padding: 22, gap: 14 },
    eyebrow: { color: C.brand, fontWeight: '800', fontSize: 13, letterSpacing: 1, textTransform: 'uppercase' },
    title: { fontSize: 28, fontWeight: '800', color: C.ink, lineHeight: 34 },
    text: { fontSize: 16, color: C.sub, lineHeight: 23 },
    small: { fontSize: 13 },
    point: { backgroundColor: C.card, borderRadius: 16, padding: 14, gap: 4 },
    pointHead: { fontSize: 16, fontWeight: '700', color: C.ink },
    nav: { flexDirection: 'row', gap: 10, padding: 22, paddingBottom: 38 },
  });
};

/**
 * Settings → voice picker: every voice installed on the phone for the driver's
 * language, best first (Premium, Enhanced, Standard). Tap to hear it and use
 * it; "Automatic" goes back to picking the best one.
 */
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import * as repo from '../lib/db/repositories';
import { listVoices, previewVoice, setPreferredVoice, type VoiceChoice } from '../lib/voice/speechIO';
import type { Lang } from '../lib/voice/voiceCheck';
import { C } from './ui';

const SAMPLE: Record<Lang, (name: string) => string> = {
  en: (n) => `${n ? `${n}, ` : ''}this is how I'll sound if I ever need to check on you. Are you feeling okay?`,
  es: (n) => `${n ? `${n}, ` : ''}así sonaré si alguna vez necesito saber cómo estás. ¿Te sientes bien?`,
};

export function VoicePicker(props: { lang: Lang; driverName: string }) {
  const [voices, setVoices] = useState<VoiceChoice[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      setVoices(await listVoices(props.lang));
      setChosen(await repo.getSetting(`voice:${props.lang}`));
    })();
  }, [props.lang]);

  async function pick(id: string | null) {
    setChosen(id);
    setPreferredVoice(props.lang, id);
    await repo.setSetting(`voice:${props.lang}`, id ?? '');
    const voice = id ?? voices?.[0]?.id;
    if (voice) {
      setPlaying(voice);
      setError(null);
      try { await previewVoice(props.lang, voice, SAMPLE[props.lang](props.driverName)); }
      catch (error) { setError(error instanceof Error ? error.message : String(error)); }
      finally { setPlaying(null); }
    }
  }

  if (!voices) return null;
  if (!voices.length) return <Text style={st.note}>No voices found for this language on this phone.</Text>;
  const row = (id: string | null, title: string, sub: string) => {
    const on = (chosen || null) === id;
    return (
      <Pressable key={id ?? 'auto'} onPress={() => void pick(id)} style={[st.row, on && st.rowOn]} accessibilityRole="radio" accessibilityState={{ selected: on }}>
        <View style={[st.radio, on && st.radioOn]} />
        <View style={{ flex: 1 }}>
          <Text style={st.title}>{title}</Text>
          <Text style={st.sub}>{sub}</Text>
        </View>
        {playing === (id ?? voices[0]?.id) ? <Text style={st.playing}>▶︎ playing</Text> : null}
      </Pressable>
    );
  };
  return (
    <View style={{ gap: 6 }}>
      {row(null, 'Automatic', `Best installed: ${voices[0]!.name} (${voices[0]!.tier})`)}
      {voices.map((v) => row(v.id, v.name, `${v.tier} · ${v.language}`))}
      {error ? <Text style={{ color: C.bad }}>{error}</Text> : null}
      <Text style={st.note}>Tap a voice to hear it. Your choice is used for this driver's language on this phone.</Text>
    </View>
  );
}

const st = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderRadius: 12, borderWidth: 1.5, borderColor: C.line },
  rowOn: { borderColor: C.brand, backgroundColor: '#f0fdfa' },
  radio: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: C.faint },
  radioOn: { borderColor: C.brand, backgroundColor: C.brand },
  title: { fontSize: 15, fontWeight: '700', color: C.ink },
  sub: { fontSize: 12, color: C.sub },
  playing: { fontSize: 12, color: C.brand, fontWeight: '700' },
  note: { fontSize: 12, color: C.sub },
});

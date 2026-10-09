import { appAudio } from './audioOwnership';
import { responsiveness, responsivenessProbe } from './responsivenessDiagnostics';
/**
 * Phone implementation of VoiceIO: free, on-device speech in and out.
 *
 * Speaking: expo-speech → the phone's own text-to-speech (iOS
 * AVSpeechSynthesizer, Android TextToSpeech). No network, no cost. We pick the
 * best installed voice for the language: Premium, then Enhanced, then the
 * default -- never the novelty voices. Premium/Enhanced voices are free
 * downloads on iPhone: Settings → Accessibility → Read & Speak → Voices (iOS
 * 26; "Spoken Content" on iOS 17-18). expo-speech reports Premium voices as
 * "Default" quality, so they are recognised by their identifier.
 *
 * Loudness: before every prompt the iOS audio session is set to playback /
 * voicePrompt with duckOthers -- the mode navigation apps use: full speaker
 * volume (or the car's Bluetooth audio), music lowered underneath, and it
 * plays even with the ring/silent switch on silent. Without this, speech after
 * the microphone has been used can come out of the quiet earpiece. Listening
 * uses playAndRecord with defaultToSpeaker + Bluetooth, not the recogniser's
 * default "measurement" mode.
 *
 * Listening: expo-speech-recognition → iOS SFSpeechRecognizer / Android
 * SpeechRecognizer with requiresOnDeviceRecognition when the device supports
 * it for that language, so audio never leaves the phone. contextualStrings
 * bias the recogniser toward the expected answers ("yes", "no", "I need
 * help"...). If on-device recognition isn't available the OS's own free
 * service is used (no key, no charge). If recognition isn't possible at all
 * (permission denied), listen() simply waits out the window and returns
 * null -- the driver can still answer with the buttons, and silence counts as
 * no response.
 *
 * Nothing is recorded or stored: transcripts only live for the check.
 */
import { Platform } from 'react-native';
import * as Speech from 'expo-speech';
import { ExpoSpeechRecognitionModule } from 'expo-speech-recognition';

import type { Lang, VoiceIO } from './voiceCheck';

const LOCALE: Record<Lang, string> = { en: 'en-US', es: 'es-US' };

let voiceCache: Partial<Record<Lang, string | null>> = {};
/** Voices the driver picked in Settings (loaded from app_settings at start). */
let preferred: Partial<Record<Lang, string | null>> = {};

export type VoiceChoice = { id: string; name: string; language: string; tier: 'Premium' | 'Enhanced' | 'Standard' };

const rank = (v: Speech.Voice) => {
  const id = v.identifier.toLowerCase();
  if (id.includes('speech.synthesis') || id.includes('eloquence')) return 0; // novelty / robotic voices
  if (id.includes('.premium.')) return 3;
  if (id.includes('.enhanced.') || String(v.quality) === 'Enhanced') return 2;
  return 1;
};

/** Installed voices for a language, best first (for the Settings picker). */
export async function listVoices(lang: Lang): Promise<VoiceChoice[]> {
  try {
    const prefix = LOCALE[lang].slice(0, 2);
    const voices = (await Speech.getAvailableVoicesAsync()).filter(
      (v) => v.language?.toLowerCase().startsWith(prefix) && rank(v) > 0,
    );
    return voices
      .sort((a, b) => rank(b) - rank(a) || Number(b.language === LOCALE[lang]) - Number(a.language === LOCALE[lang]) || a.name.localeCompare(b.name))
      .map((v) => ({
        id: v.identifier,
        name: v.name,
        language: v.language,
        tier: rank(v) === 3 ? 'Premium' : rank(v) === 2 ? 'Enhanced' : 'Standard',
      }));
  } catch {
    return [];
  }
}

export function setPreferredVoice(lang: Lang, id: string | null) {
  preferred[lang] = id;
  delete voiceCache[lang];
}

/** Speaks a short sample with a specific voice, at prompt volume. */
export async function previewVoice(lang: Lang, id: string, text: string) {
  let finished: Promise<void> = Promise.resolve();
  const release = await appAudio.acquire('optional', async () => { await Speech.stop(); await finished; await waitForSpeechIdle(); });
  try {
    promptAudio();
    finished = new Promise<void>((resolve) =>
      Speech.speak(text, { language: LOCALE[lang], voice: id, rate: 0.95, volume: 1.0,
        onDone: () => resolve(), onStopped: () => resolve(), onError: () => resolve() }),
    );
    await finished;
  } finally {
    if (Platform.OS === 'ios') {
      try { ExpoSpeechRecognitionModule.setAudioSessionActiveIOS(false, { notifyOthersOnDeactivation: true }); } catch {}
    }
    release();
  }
}

async function bestVoice(lang: Lang): Promise<string | undefined> {
  if (lang in voiceCache) return voiceCache[lang] ?? undefined;
  const all = await listVoices(lang);
  const chosen = preferred[lang];
  // The driver's pick wins if it is still installed; otherwise the best one.
  voiceCache[lang] = (chosen && all.some((v) => v.id === chosen) ? chosen : all[0]?.id) ?? null;
  return voiceCache[lang] ?? undefined;
}

/** Ask for microphone + speech permission ahead of time (at drive start), so
 *  the first emergency is never blocked by a permission dialog. */
export async function prepareVoice(): Promise<{ granted: boolean; onDevice: boolean }> {
  try {
    const p = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    return { granted: p.granted, onDevice: ExpoSpeechRecognitionModule.supportsOnDeviceRecognition() };
  } catch {
    return { granted: false, onDevice: false };
  }
}

/** Loud prompt mode (see header). No-op off iOS. */
function promptAudio() {
  if (Platform.OS !== 'ios') return;
  try {
    ExpoSpeechRecognitionModule.setCategoryIOS({ category: 'playback', categoryOptions: ['duckOthers'], mode: 'voicePrompt' });
    ExpoSpeechRecognitionModule.setAudioSessionActiveIOS(true);
  } catch {
    // keep whatever session is active
  }
}

/** Let other audio (music, navigation) return to full volume afterwards. */
let releaseSafetyAudio: (() => void) | null = null;
let safetyReleasePending: Promise<void> = Promise.resolve();

async function waitForSpeechIdle() {
  for (let attempt = 0; attempt < 40; attempt++) {
    const [speaking, recognition] = await Promise.all([
      Speech.isSpeakingAsync(), ExpoSpeechRecognitionModule.getStateAsync(),
    ]);
    if (!speaking && recognition === 'inactive') return;
    await new Promise<void>(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Speech cleanup has not completed. Audio ownership remains reserved.');
}

export function releaseAudio() {
  const release = releaseSafetyAudio;
  if (!release) return; // no session was acquired; never deactivate optional audio
  const timing = responsivenessProbe('warning', 'release audio');
  safetyReleasePending = (async () => {
    await waitForSpeechIdle();
    timing('speech and recognition idle');
    if (Platform.OS === 'ios') {
      ExpoSpeechRecognitionModule.setAudioSessionActiveIOS(false, { notifyOthersOnDeactivation: true });
    }
    if (releaseSafetyAudio === release) releaseSafetyAudio = null;
    release();
    timing('session deactivation returned; ownership released');
  })();
  // Keep a failed cleanup lock rather than allowing overlapping audio. Later
  // checks still have on-screen buttons; restarting resets a stuck native session.
  void safetyReleasePending.catch(() => {});
}

export function phoneVoiceIO(): VoiceIO {
  let cancelListen: (() => void) | null = null;
  let cancelEpoch = 0;
  let cleanupNeeded = false;
  async function acquire() {
    const epoch = cancelEpoch;
    await safetyReleasePending;
    if (cleanupNeeded) { await waitForSpeechIdle(); cleanupNeeded = false; }
    if (epoch !== cancelEpoch) throw new Error("Voice check cancelled");
    if (!releaseSafetyAudio) {
      const release = await appAudio.acquire("safety", async () => {});
      if (epoch !== cancelEpoch) { release(); throw new Error("Voice check cancelled"); }
      releaseSafetyAudio = release;
    }
  }

  return {
    async speak(text, lang) {
      const timing = responsivenessProbe('warning', 'playback');
      const epoch = cancelEpoch;
      await acquire();
      timing('audio ownership acquired');
      const voice = await bestVoice(lang);
      timing('voice selected', { voiceId: voice ?? undefined, locale: LOCALE[lang] });
      if (epoch !== cancelEpoch) throw new Error("Voice check cancelled");
      promptAudio();
      timing('playback session setup returned');
      await new Promise<void>((resolve) => {
        Speech.speak(text, {
          language: LOCALE[lang],
          voice,
          rate: 0.95,
          volume: 1.0,
          useApplicationAudioSession: true,
          onStart: () => timing('playback started'),
          onDone: () => { timing('playback completed'); resolve(); },
          onStopped: () => { timing('playback stopped'); resolve(); },
          onError: () => { timing('playback error'); resolve(); },
        });
      });
    },

    async listen(lang, ms, hints) {
      const timing = responsivenessProbe('warning', 'recognition');
      const epoch = cancelEpoch;
      await acquire();
      timing('audio ownership acquired');
      if (epoch !== cancelEpoch) return null;
      return new Promise<string | null>((resolve) => {
        let best = '';
        let finished = false;
        const subs: { remove(): void }[] = [];
        const finish = (value: string | null) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          for (const s of subs) s.remove();
          cancelListen = null;
          cleanupNeeded = true;
          timing('listen resolved; abort requested', { hasText: !!value });
          try {
            ExpoSpeechRecognitionModule.abort();
          } catch {
            // already stopped
          }
          resolve(value);
        };
        const timer = setTimeout(() => { timing('window timeout', { hasText: !!best }); finish(best || null); }, ms);
        cancelListen = () => { timing('cancel requested'); finish(null); };

        try {
          if (__DEV__ && responsiveness.isEnabled()) {
            // Diagnostic registration failure must never prevent recognition.
            for (const [event, point] of [
              ['audiostart', 'microphone capture started'], ['audioend', 'microphone capture ended'],
              ['speechstart', 'speech activity started'], ['speechend', 'speech activity ended'],
            ] as const) {
              try { subs.push(ExpoSpeechRecognitionModule.addListener(event, () => timing(point))); }
              catch { /* Optional instrumentation only. */ }
            }
          }
          subs.push(
            ExpoSpeechRecognitionModule.addListener('result', (e) => {
              const text = e.results[0]?.transcript ?? '';
              if (text && !e.isFinal) timing('first partial received');
              if (e.isFinal) timing('final callback received', { isFinal: true, hasText: !!text });
              if (text) best = text;
              if (e.isFinal && best) finish(best);
            }),
            ExpoSpeechRecognitionModule.addListener('error', () => {
              timing('recognition error event');
              // no-speech, not-allowed, network...: keep the window open so the
              // buttons still work; resolve with whatever was heard at the end.
            }),
          );
          const onDevice = ExpoSpeechRecognitionModule.supportsOnDeviceRecognition();
          timing('recognition start requested', { locale: LOCALE[lang], onDeviceRequired: onDevice });
          ExpoSpeechRecognitionModule.start({
            lang: LOCALE[lang],
            interimResults: true,
            maxAlternatives: 1,
            continuous: false,
            requiresOnDeviceRecognition: onDevice,
            addsPunctuation: false,
            contextualStrings: hints,
            iosTaskHint: 'confirmation',
            iosCategory: {
              category: 'playAndRecord',
              categoryOptions: ['defaultToSpeaker', 'allowBluetooth', 'duckOthers'],
              mode: 'default',
            },
          });
          timing('recognition start call returned');
        } catch {
          timing('recognition setup threw');
          // Recognition unavailable: wait out the window (buttons still work).
        }
      });
    },

    cancel() {
      cancelEpoch += 1;
      cleanupNeeded = true;
      void Speech.stop();
      cancelListen?.();
    },
  };
}

/** For Settings: which languages can be recognised fully on this phone. */
export async function onDeviceLanguages(): Promise<string[]> {
  try {
    const r = await ExpoSpeechRecognitionModule.getSupportedLocales({});
    return r.installedLocales ?? [];
  } catch {
    return [];
  }
}

export function resetVoiceCache() {
  voiceCache = {};
}

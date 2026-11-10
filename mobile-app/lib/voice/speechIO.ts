import { appAudio } from './audioOwnership';
import { responsiveness, responsivenessProbe, debugSessionAlignmentEnabled } from './responsivenessDiagnostics';
import { voiceCheckSpokenText } from './voiceCheckPresentation';
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
 * Listening: iOS uses the existing strict native offline recognizer, preserving
 * genuine Apple final evidence. Expo iOS metadata-derived final flags are not
 * consent evidence. Other platforms retain their existing recognition adapter.
 * Only successful final recognition can guide wellness or authorize contact handoff.
 *
 * Nothing is recorded or stored: transcripts only live for the check.
 */
import { Platform } from 'react-native';
import * as Speech from 'expo-speech';
import { ExpoSpeechRecognitionModule } from 'expo-speech-recognition';

import { prepareVoiceCheckAlignedSession, prepareOfflineRecognition, listenOffline, cancelOfflineListening, subscribeOfflineSpeechProgress } from '../../modules/local-foundation-models';
import { recognitionEvidence, type CoreRecognition } from './coreRecognition';

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

async function bestVoice(lang: Lang, strict = false): Promise<string | undefined> {
  if (strict) {
    const installed = await listVoices(lang);
    const selected = preferred[lang];
    if (selected && !installed.some(voice => voice.id === selected)) throw new Error('Selected safety voice is unavailable. Choose an installed voice in Settings.');
    const voice = selected || installed[0]?.id;
    if (!voice) throw new Error('No installed safety voice is available. Use the on-screen response buttons.');
    return voice;
  }
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

let nativeRecognitionPending: Promise<unknown> = Promise.resolve();

async function bounded<T>(pending: Promise<T>, ms = 2500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Audio operation timed out.')), ms);
    })]);
  } finally { clearTimeout(timer); }
}

async function waitForSpeechIdle() {
  await bounded(nativeRecognitionPending);
  for (let attempt = 0; attempt < 40; attempt++) {
    const [speaking, recognition] = await bounded(Promise.all([
      Speech.isSpeakingAsync(), ExpoSpeechRecognitionModule.getStateAsync(),
    ]));
    if (!speaking && recognition === 'inactive') return;
    await new Promise<void>(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Speech cleanup has not completed. Audio ownership remains reserved.');
}

let cleanupFailed = false;
let safetyOwner: object | null = null;

export function releaseAudio() {
  const release = releaseSafetyAudio;
  if (!release) return; // no session was acquired; never deactivate optional audio
  const timing = responsivenessProbe('warning', 'release audio');
  safetyReleasePending = safetyReleasePending.catch(() => {}).then(async () => {
    if (releaseSafetyAudio !== release) return;
    if (cleanupFailed) await bounded(Speech.stop());
    await waitForSpeechIdle();
    // Another cleanup of this same lease may already have released it. Never
    // deactivate a session now owned by a subsequent optional conversation.
    if (releaseSafetyAudio !== release) return;
    timing('speech and recognition idle');
    if (Platform.OS === 'ios') {
      ExpoSpeechRecognitionModule.setAudioSessionActiveIOS(false, { notifyOthersOnDeactivation: true });
    }
    if (releaseSafetyAudio === release) { releaseSafetyAudio = null; safetyOwner = null; }
    release();
    cleanupFailed = false;
    timing('session deactivation returned; ownership released');
  }).catch(error => { cleanupFailed = true; throw error; });
  // Retain the lease on failure; a later safety acquisition retries cleanup.
  // Never release ownership merely because a deadline expired.
  void safetyReleasePending.catch(() => {});
}

export function phoneVoiceIO(): VoiceIO { return createPhoneVoiceIO(false); }

/** Sensi safety presentation honors the exact saved system voice; CORE is unchanged. */
export function phoneSensiVoiceIO(): VoiceIO { return createPhoneVoiceIO(true); }

function createPhoneVoiceIO(strictSelectedVoice: boolean): VoiceIO {
  const owner = {};
  let cancelListen: (() => void) | null = null;
  let cancelEpoch = 0;
  let cleanupNeeded = false;
  let prepared: { id: string; lang: Lang; pending?: Promise<void>; session?: Promise<boolean>; timing: ReturnType<typeof responsivenessProbe> } | null = null;
  async function acquire() {
    const epoch = cancelEpoch;
    await safetyReleasePending.catch(() => {});
    if (epoch !== cancelEpoch) throw new Error("Voice check cancelled");
    if (cleanupFailed) {
      releaseAudio();
      await safetyReleasePending;
    }
    if (releaseSafetyAudio && safetyOwner !== owner) throw new Error("Another safety check owns audio.");
    if (cleanupNeeded) { await waitForSpeechIdle(); cleanupNeeded = false; }
    if (epoch !== cancelEpoch) throw new Error("Voice check cancelled");
    if (!releaseSafetyAudio) {
      const release = await appAudio.acquire("safety", async () => {});
      if (epoch !== cancelEpoch) { release(); throw new Error("Voice check cancelled"); }
      releaseSafetyAudio = release;
      safetyOwner = owner;
    }
  }

  return {
    prepareRecognition(lang, captureId) {
      if (Platform.OS !== 'ios') return;
      if (prepared) throw new Error('A recognition preparation is already registered.');
      prepared = { id: captureId, lang, timing: responsivenessProbe('warning', 'capture preparation') };
      prepared.timing('prewarm registered', { locale: LOCALE[lang], captureId });
    },
    async speak(text, lang) {
      const timing = responsivenessProbe('warning', 'playback');
      const epoch = cancelEpoch;
      await acquire();
      timing('audio ownership acquired');
      const preparation = prepared;
      if (preparation && !preparation.pending && preparation.lang === lang) {
        preparation.pending = (async () => {
          preparation.timing('native prewarm requested');
          const result = typeof prepareOfflineRecognition === 'function'
            ? await prepareOfflineRecognition(LOCALE[lang], preparation.id) : { status: 'unavailable' };
          preparation.timing('native prewarm acknowledged', { status: result.status, reason: result.reason });
          if (result.status !== 'started' && result.status !== 'unavailable') throw new Error('Recognition preparation failed.');
        })();
        void preparation.pending.catch(() => {}); // Consumed by listen; never an unhandled rejection during TTS.
      }
      if (preparation && !preparation.session && typeof debugSessionAlignmentEnabled === 'function' && debugSessionAlignmentEnabled()) {
        preparation.session = (async () => {
          await preparation.pending;
          if (epoch !== cancelEpoch) return false;
          const result = await prepareVoiceCheckAlignedSession(preparation.id);
          preparation.timing('preprompt session setup returned', { sessionAlignment: result });
          return result.aligned;
        })();
      }
      const aligned = await preparation?.session ?? false;
      if (epoch !== cancelEpoch) throw new Error("Voice check cancelled");
      let voice: string | undefined;
      try { voice = await bestVoice(lang, strictSelectedVoice); }
      catch (error) {
        if (!strictSelectedVoice) throw error;
        timing('selected voice unavailable; retaining deterministic button and recognition path');
        return { status: 'unavailable' as const };
      }
      timing('voice selected', { voiceId: voice ?? undefined, locale: LOCALE[lang] });
      if (epoch !== cancelEpoch) throw new Error("Voice check cancelled");
      if (!aligned) promptAudio();
      timing('playback session setup returned');
      try { await bounded(new Promise<void>((resolve, reject) => {
        Speech.speak(voiceCheckSpokenText(text, lang), {
          language: LOCALE[lang],
          voice,
          rate: 0.95,
          volume: 1.0,
          useApplicationAudioSession: true,
          onStart: () => { timing('playback started'); preparation?.timing('TTS started (JS callback)'); },
          onDone: () => { timing('playback completed'); preparation?.timing('TTS completed (JS callback)'); resolve(); },
          onStopped: () => { timing('playback stopped'); reject(new Error('Prompt playback stopped')); },
          onError: () => { timing('playback error'); reject(new Error('Prompt playback failed')); },
        });
      }), 15000); }
      catch (error) {
        cleanupNeeded = true;
        void Speech.stop().catch(() => {});
        throw error;
      }
    },

    async listen(lang, ms, hints, captureId, onPhase) {
      const timing = responsivenessProbe('warning', 'recognition');
      const epoch = cancelEpoch;
      try { await acquire(); }
      catch (error) { timing('adapter acquisition rejected', { captureId, stage: 'ownership', current: epoch === cancelEpoch }); throw error; }
      timing('audio ownership acquired', { captureId });
      if (epoch !== cancelEpoch) { timing('adapter cancelled before capture', { captureId, current: false }); return null; }
      if (Platform.OS === 'ios') {
        cancelListen = () => {
          void cancelOfflineListening(captureId).catch(() => {});
        };
        let subscription: { remove(): void } | undefined;
        let acceptingProgress = true;
        let stage = 'preparation_identity';
        try {
          if (prepared && (prepared.id !== captureId || prepared.lang !== lang)) throw new Error('Stale preparation.');
          stage = 'preparation_acknowledgment';
          await prepared?.pending;
          if (epoch !== cancelEpoch) { timing('adapter cancelled before capture', { captureId, current: false }); return null; }
          stage = 'progress_subscription';
          prepared?.timing('native capture activation requested');
          onPhase?.('preparing');
          subscription = subscribeOfflineSpeechProgress(progress => {
            if (!acceptingProgress || epoch !== cancelEpoch || progress.requestId !== captureId) return;
            onPhase?.(progress.phase);
          });
          stage = 'native_capture';
          const pending = listenOffline(LOCALE[lang], captureId, ms);
          nativeRecognitionPending = pending.catch(() => {});
          const result = await pending;
          if (!result) { timing('adapter missing native result', { captureId }); return null; }
          prepared?.timing('native capture and cleanup completed');
          if (result.nativeTimingMs) timing('native monotonic milestones', { nativeTimingMs: result.nativeTimingMs, captureId });
          timing('native recognition completed', { captureId, status: result.status, reason: result.reason,
            ...(typeof __DEV__ !== 'undefined' && __DEV__ ? { endpointReason: result.endpointReason,
              englishFinalization: result.englishFinalizationDebug?.captureId === captureId ? result.englishFinalizationDebug : undefined } : {}),
            hasTranscript: !!result.transcript?.trim(), hasFinalText: !!result.finalTranscript?.trim(),
            isFinal: result.isFinal, finalResultReceived: result.finalResultReceived,
            localeMatches: result.locale === LOCALE[lang], onDeviceRequired: result.requiresOnDeviceRecognition === true,
            nativeRevision: result.nativeRevision, ...(result.sessionAlignment ? { sessionAlignment: result.sessionAlignment } : {}), cueFailed: !!result.listeningCueError,
            outputVolume: result.audioOutputVolume, outputRoute: result.audioOutputRoute?.join(', '),
            nativeMs: result.totalTimeMs, preparationMs: result.preparationTimeMs, listeningMs: result.listeningTimeMs, finalizingMs: result.finalizationTimeMs });
          stage = 'result_mapping';
          const evidence = recognitionEvidence(captureId, { ...result,
            status: result.locale === LOCALE[lang] && result.requiresOnDeviceRecognition === true ? result.status : 'error',
          }, epoch === cancelEpoch);
          timing('adapter outcome', { captureId, status: evidence.status, current: epoch === cancelEpoch,
            usable: evidence.status === 'success' && !evidence.cancelled && evidence.isFinal === true
              && evidence.finalResultReceived === true && !!evidence.finalTranscript?.trim()
              && evidence.transcript?.trim() === evidence.finalTranscript?.trim(), cancelled: evidence.cancelled,
            transcriptsMatch: evidence.transcript?.trim() === evidence.finalTranscript?.trim() });
          return evidence;
        } catch {
          timing('adapter outcome', { captureId, stage, status: epoch === cancelEpoch ? 'error' : 'stale', reason: 'native_adapter_failed', current: epoch === cancelEpoch });
          return recognitionEvidence(captureId, { status: 'error', reason: 'native_adapter_failed', transcript: '', isFinal: false }, epoch === cancelEpoch);
        } finally {
          prepared = null;
          acceptingProgress = false;
          subscription?.remove();
          cancelListen = null;
          cleanupNeeded = true;
        }
      }
      return new Promise<CoreRecognition>((resolve) => {
        let best = '';
        let failed = false;
        let finished = false;
        let capturing = false;
        const subs: { remove(): void }[] = [];
        const finish = (value: string | null, status: CoreRecognition['status'] = 'timeout', final = false) => {
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
          resolve(recognitionEvidence(captureId, { status: failed ? 'error' : status, transcript: value ?? '', finalTranscript: final ? value ?? '' : '', isFinal: final, finalResultReceived: final }, epoch === cancelEpoch));
        };
        let timer = setTimeout(() => { failed = true; finish(null, 'error'); }, 5000);
        cancelListen = () => { timing('cancel requested'); finish(null, 'cancelled'); };

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
          onPhase?.('preparing');
          subs.push(
            ExpoSpeechRecognitionModule.addListener('audiostart', () => {
              if (finished || capturing || epoch !== cancelEpoch) return;
              capturing = true;
              clearTimeout(timer);
              timer = setTimeout(() => { timing('window timeout', { hasText: !!best }); finish(best || null); }, ms);
              onPhase?.('listening');
            }),
            ExpoSpeechRecognitionModule.addListener('result', (e) => {
              if (finished || epoch !== cancelEpoch) return;
              const text = e.results[0]?.transcript ?? '';
              if (text && !e.isFinal) timing('first partial received');
              if (e.isFinal) timing('final callback received', { isFinal: true, hasText: !!text });
              if (text) best = text;
              if (e.isFinal) finish(text || null, text.trim() ? 'success' : 'incomplete', !!text.trim());
            }),
            ExpoSpeechRecognitionModule.addListener('error', () => {
              failed = true;
              timing('recognition error event');
              // no-speech, not-allowed, network...: keep the window open so the
              // buttons still work; resolve with whatever was heard at the end.
            }),
          );
          const onDevice = ExpoSpeechRecognitionModule.supportsOnDeviceRecognition();
          if (!onDevice) {
            failed = true;
            timing('offline recognition unavailable; retaining typed/button response window');
            return; // Never opt into server recognition for event-triggered Sensi.
          }
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
          failed = true;
          timing('recognition setup threw');
          // Recognition unavailable: wait out the window (buttons still work).
        }
      });
    },

    cancel() {
      cancelEpoch += 1;
      cleanupNeeded = true;
      void Speech.stop().catch(() => {});
      const preparation = prepared; prepared = null;
      if (preparation) {
        const cleanup = Promise.allSettled([preparation.pending, preparation.session]).then(() => cancelOfflineListening(preparation.id));
        nativeRecognitionPending = Promise.all([nativeRecognitionPending, cleanup]).then(() => {});
        void nativeRecognitionPending.catch(() => {});
      }
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

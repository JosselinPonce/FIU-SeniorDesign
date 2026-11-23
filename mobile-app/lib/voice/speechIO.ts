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
  if (id.includes('.premium.') || String(v.quality) === 'Premium') return 3;
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
    const voice = installed.find(voice => voice.id === selected)?.id ?? installed[0]?.id;
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

let voicePreparation: ReturnType<typeof requestVoiceReadiness> | undefined;

async function requestVoiceReadiness(): Promise<{ granted: boolean; onDevice: boolean }> {
  try {
    const p = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    return { granted: p.granted, onDevice: ExpoSpeechRecognitionModule.supportsOnDeviceRecognition() };
  } catch {
    return { granted: false, onDevice: false };
  }
}

/** Share an in-flight permission check across callers without caching permission state. */
export function prepareVoice() {
  return voicePreparation ??= requestVoiceReadiness().finally(() => { voicePreparation = undefined; });
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
let preGuidanceStop: Promise<void> | undefined;

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
  if (preGuidanceStop) await bounded(preGuidanceStop);
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
  let promptVoice: { lang: Lang; id: string } | undefined;
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
    async pause() {
      const epoch = cancelEpoch;
      await new Promise<void>(resolve => setTimeout(resolve, 120));
      if (epoch !== cancelEpoch) throw new Error('Voice check cancelled');
    },
    prepareRecognition(lang, captureId) {
      if (Platform.OS !== 'ios') return;
      if (prepared) throw new Error('A recognition preparation is already registered.');
      prepared = { id: captureId, lang, timing: responsivenessProbe('warning', 'capture preparation') };
      prepared.timing('prewarm registered', { locale: LOCALE[lang], captureId });
    },
    async speak(text, lang, delivery) {
      const timing = responsivenessProbe('warning', 'playback');
      const epoch = cancelEpoch;
      const beforeGuidance = delivery === 'pre_guidance_acknowledgment';
      // Optional speech never starts an audio session or attempts recovery.
      if (beforeGuidance && (!releaseSafetyAudio || safetyOwner !== owner || cleanupNeeded || cleanupFailed || promptVoice?.lang !== lang)) {
        return { status: 'unavailable' as const };
      }
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
      try { voice = beforeGuidance ? promptVoice?.id : await bestVoice(lang, strictSelectedVoice); }
      catch (error) {
        if (!strictSelectedVoice) throw error;
        timing('selected voice unavailable; retaining deterministic button and recognition path');
        return { status: 'unavailable' as const };
      }
      timing('voice selected', { voiceId: voice ?? undefined, locale: LOCALE[lang] });
      if (epoch !== cancelEpoch) throw new Error("Voice check cancelled");
      if (!beforeGuidance) promptVoice = voice ? { lang, id: voice } : undefined;
      if (!aligned) promptAudio();
      timing('playback session setup returned');
      try { await bounded(new Promise<void>((resolve, reject) => {
        Speech.speak(voiceCheckSpokenText(text, lang), {
          language: LOCALE[lang],
          voice,
          rate: Platform.OS === 'ios' && delivery === 'acknowledgment' ? 0.92 : 0.95,
          volume: 1.0,
          useApplicationAudioSession: true,
          onStart: () => { timing('playback started'); preparation?.timing('TTS started (JS callback)'); },
          onDone: () => { timing('playback completed'); preparation?.timing('TTS completed (JS callback)'); resolve(); },
          onStopped: () => { timing('playback stopped'); reject(new Error('Prompt playback stopped')); },
          onError: () => { timing('playback error'); reject(new Error('Prompt playback failed')); },
        });
      }), beforeGuidance ? 2500 : 15000); }
      catch (error) {
        cleanupNeeded = true;
        const stopping = Speech.stop().catch(() => {});
        if (beforeGuidance) {
          preGuidanceStop = stopping;
          void stopping.then(() => { if (preGuidanceStop === stopping) preGuidanceStop = undefined; });
        }
        throw error;
      }
    },

    async listen(lang, ms, hints, captureId, onPhase, onNativeDebug) {
      const timing = responsivenessProbe('warning', 'recognition');
      const epoch = cancelEpoch;
      const reportMilestones: NonNullable<typeof onNativeDebug> = milestones => {
        try { onNativeDebug?.(milestones); }
        catch { /* Debug evidence cannot change recognition. */ }
      };
      const reportFailure = (failure: 'audio_ownership' | 'adapter') => reportMilestones({
        cueCompletedMs: null, pcmGateOpenedMs: null, firstForwardedPcmMs: null, partial: false, final: false, failure,
      });
      const traceEarlyExit = (reason: string, adapterStatus: string) => {
        if (Platform.OS === 'ios' && typeof __DEV__ !== 'undefined' && __DEV__) {
          timing('capture summary', { captureId, recognitionSummary: {
            generation: epoch, language: LOCALE[lang], activation: 'not_started', engineStarted: false,
            nativeFinalCallback: false, usableNativeFinal: false, terminalReason: reason, adapterStatus,
          } });
        }
      };
      try { await acquire(); }
      catch (error) {
        reportFailure('audio_ownership');
        traceEarlyExit('ownership_rejected', epoch === cancelEpoch ? 'error' : 'stale');
        timing('adapter acquisition rejected', { captureId, stage: 'ownership', current: epoch === cancelEpoch });
        throw error;
      }
      timing('audio ownership acquired', { captureId });
      if (epoch !== cancelEpoch) {
        traceEarlyExit('cancelled_before_capture', 'stale');
        timing('adapter cancelled before capture', { captureId, current: false });
        return null;
      }
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
          if (epoch !== cancelEpoch) {
            traceEarlyExit('cancelled_before_capture', 'stale');
            timing('adapter cancelled before capture', { captureId, current: false });
            return null;
          }
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
          if (!result) {
            traceEarlyExit('missing_native_result', 'missing');
            timing('adapter missing native result', { captureId });
            return null;
          }
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
          if (onNativeDebug) reportMilestones({
            cueCompletedMs: result.nativeTimingMs?.cueCompleted ?? null,
            pcmGateOpenedMs: result.nativeTimingMs?.listeningGateOpened ?? null,
            firstForwardedPcmMs: result.captureDiagnostics?.pcm?.firstForwardedMs ?? null,
            finalizationStartedMs: result.nativeTimingMs?.finalizationStarted ?? null,
            firstPartialMs: result.nativeTimingMs?.firstPartialReceived ?? null,
            finalResultMs: result.nativeTimingMs?.finalResultReceived ?? null,
            terminalReason: (() => {
              switch (result.captureTerminalReason) {
                case 'finalization_incomplete': case 'empty_final_after_partial': case 'no_speech_timeout':
                case 'cancelled': case 'audio_interrupted': case 'audio_setup_failed': case 'recognition_failed':
                case 'audio_conversion_failed': case 'audio_cleanup_failed': return result.captureTerminalReason;
                default: return 'other';
              }
            })(),
            partial: result.firstPartialTimeMs != null,
            final: !!result.finalTranscript?.trim() && result.finalResultReceived === true,
            failure: null,
          });
          stage = 'result_mapping';
          const evidence = recognitionEvidence(captureId, { ...result,
            status: result.locale === LOCALE[lang] && result.requiresOnDeviceRecognition === true ? result.status : 'error',
          }, epoch === cancelEpoch);
          if (typeof __DEV__ !== 'undefined' && __DEV__) {
            const marks = result.nativeTimingMs ?? {};
            timing('capture summary', { captureId, recognitionSummary: {
              generation: epoch, language: LOCALE[lang], native: result.captureDiagnostics,
              preparationError: result.captureNativeError,
              activation: marks.sessionActivationCompleted !== undefined ? 'completed'
                : marks.alignedSessionReused !== undefined ? 'reused'
                  : marks.sessionActivationStarted !== undefined ? 'failed_or_interrupted' : 'not_started',
              engineStarted: marks.engineStartReturned !== undefined,
              firstPartialMs: result.firstPartialTimeMs,
              nativeFinalCallback: marks.finalResultReceived !== undefined || result.finalResultReceived === true,
              usableNativeFinal: !!result.finalTranscript?.trim() && result.isFinal,
              nativeStatus: result.status,
              terminalReason: result.captureTerminalReason ?? 'native_summary_unavailable',
              adapterStatus: evidence.status,
            } });
          }
          timing('adapter outcome', { captureId, status: evidence.status, current: epoch === cancelEpoch,
            usable: evidence.status === 'success' && !evidence.cancelled && evidence.isFinal === true
              && evidence.finalResultReceived === true && !!evidence.finalTranscript?.trim()
              && evidence.transcript?.trim() === evidence.finalTranscript?.trim(), cancelled: evidence.cancelled,
            transcriptsMatch: evidence.transcript?.trim() === evidence.finalTranscript?.trim() });
          return evidence;
        } catch {
          reportFailure('adapter');
          traceEarlyExit('native_adapter_failed', epoch === cancelEpoch ? 'error' : 'stale');
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

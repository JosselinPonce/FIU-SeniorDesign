import * as Speech from 'expo-speech';
import { Platform } from 'react-native';
import { listenOffline, cancelOfflineListening, subscribeOfflineSpeechProgress } from '../../modules/local-foundation-models';
import { appAudio } from './audioOwnership';
import { recognitionEvidence } from './coreRecognition';
import { listVoices } from './speechIO';
import { voiceCheckSpokenText } from './voiceCheckPresentation';
import type { DiagnosticIO } from './voiceCheckDiagnostic';

/** Optional audio only. Request identity prevents diagnostic cleanup stopping a later owner. */
export function phoneVoiceCheckDiagnostic(available: () => boolean): DiagnosticIO {
  let playback: { id: string; started: boolean; finish: (error?: Error) => void } | null = null;
  return {
    available,
    acquire: stop => appAudio.acquire('optional', stop),
    async listen(lang, id, progress) {
      if (Platform.OS !== 'ios') throw Error('On-device diagnostic requires iOS.');
      const locale = lang === 'es' ? 'es-US' : 'en-US';
      const subscription = subscribeOfflineSpeechProgress(event => {
        if (event.requestId === id) progress(event.phase, event.transcript);
      });
      try {
        const result = await listenOffline(locale, id, 15000);
        return recognitionEvidence(id, { ...result, status: result.locale === locale && result.requiresOnDeviceRecognition === true ? result.status : 'error' });
      } finally { subscription.remove(); }
    },
    async speak(text, lang, id) {
      try { await new Promise<void>((resolve, reject) => {
        const op = { id, started: false, finish(error?: Error) {
          if (error) reject(error); else resolve();
        } };
        playback = op;
        void listVoices(lang).then(voices => {
          if (playback !== op) return;
          if (!voices[0]) throw Error('No installed voice for this language.');
          op.started = true;
          Speech.speak(voiceCheckSpokenText(text, lang), { language: lang === 'es' ? 'es-US' : 'en-US', voice: voices[0].id,
            onDone: () => op.finish(), onStopped: () => op.finish(), onError: () => op.finish(Error('Playback failed.')) });
        }).catch(() => op.finish(Error('Voice unavailable.')));
      }); } finally {
      // Completion callbacks alone are insufficient to hand audio to safety.
      // Retain ownership if the platform has not drained speech yet.
      while (await Speech.isSpeakingAsync()) await new Promise(resolve => setTimeout(resolve, 50));
      if (playback?.id === id) playback = null;
      }
    },
    async cancel(kind, id) {
      if (kind === 'listening') { await cancelOfflineListening(id); return; }
      const op = playback;
      if (!op || op.id !== id) return;
      playback = null;
      if (op.started) await Speech.stop();
      op.finish();
    },
  };
}

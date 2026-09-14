import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import * as Speech from 'expo-speech';
import { File, Paths } from 'expo-file-system';

// TODO: Move provider credentials and requests server-side before production.
// Keep the existing environment-variable approach for the working prototype.
const ELEVENLABS_API_KEY = process.env.EXPO_PUBLIC_ELEVENLABS_API_KEY;
const VOICE_ID =
  process.env.EXPO_PUBLIC_ELEVENLABS_VOICE_ID ?? 'JBFqnCBsd6RMkjVDRZzb';
const TTS_MODEL = 'eleven_multilingual_v2';
const OUTPUT_FORMAT = 'mp3_44100_128';
let generation = 0;
let cancelPlayback: (() => void) | null = null;
let request: AbortController | null = null;

export async function stopSpeaking(): Promise<void> {
  generation += 1;
  request?.abort();
  request = null;
  cancelPlayback?.();
  cancelPlayback = null;
  await Speech.stop();
}

function fallback(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      cancelPlayback = null;
      resolve();
    };
    const timer = setTimeout(() => {
      void Speech.stop();
      finish();
    }, 60000);
    cancelPlayback = finish;
    Speech.speak(text, {
      onDone: finish,
      onStopped: finish,
      onError: () => {
        clearTimeout(timer);
        cancelPlayback = null;
        reject(new Error('Speech playback failed.'));
      },
    });
  });
}

/** ElevenLabs speech with local expo-speech fallback and playback cleanup. */
export async function speak(text: string): Promise<void> {
  if (!text.trim()) return;
  const current = generation;
  let file: File | null = null;
  try {
    await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false });
    if (current !== generation) return;
    if (!ELEVENLABS_API_KEY) {
      await fallback(text);
      return;
    }
    const controller = new AbortController();
    request = controller;
    const timeout = setTimeout(() => controller.abort(), 30000);
    let buffer: Uint8Array;
    try {
      const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=${OUTPUT_FORMAT}`,
        {
          method: 'POST',
          signal: controller.signal,
          headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, model_id: TTS_MODEL }),
        }
      );
      if (!response.ok) throw new Error(`Speech request failed: ${response.status}`);
      buffer = new Uint8Array(await response.arrayBuffer());
    } finally {
      clearTimeout(timeout);
      request = null;
    }
    if (current !== generation) return;
    file = new File(Paths.cache, `speech-${Date.now()}.mp3`);
    file.write(buffer);
    await new Promise<void>((resolve, reject) => {
      const player = createAudioPlayer(file!.uri);
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cancelPlayback = null;
        player.release();
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(() => finish(new Error('Speech playback timed out.')), 60000);
      cancelPlayback = () => finish();
      player.addListener('playbackStatusUpdate', (status) => {
        if (status.didJustFinish) finish();
      });
      try { player.play(); } catch { finish(new Error('Speech playback failed.')); }
    });
  } catch {
    if (current === generation) await fallback(text);
  } finally {
    if (file?.exists) file.delete();
  }
}

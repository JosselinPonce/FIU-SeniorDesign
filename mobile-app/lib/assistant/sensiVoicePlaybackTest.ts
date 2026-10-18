import { AssistantConversation, type AssistantDeps, type ConversationState } from '../../modules/local-foundation-models/assistantConversation.ts';
import { connectedAdvisory } from './connectedProvider.ts';
import type { LocalPlaybackResult, LocalVoice, OfflineTranscription } from '../../modules/local-foundation-models/index.ts';
import type { AudioOwnership } from '../voice/audioOwnership.ts';

export const SENSI_VOICE_TRANSCRIPT = 'I feel comfortable and alert today.';
export const SENSI_VOICE_RESPONSE = "That's great to hear! Stay focused and drive safely.";

/** Loaded only from development diagnostics. No Auth, transport or contacts.
 * Recognition is synthetic unless strict on-device I/O is explicitly injected. */
export function createSensiVoicePlaybackTest(io: {
  development: boolean;
  audio: AudioOwnership;
  prepare(): Promise<LocalVoice>;
  speak(text: string, voiceId: string, requestId: string): Promise<LocalPlaybackResult>;
  cancelSpeech(requestId: string): Promise<void>;
  listen?: AssistantDeps['listen'];
  useMicrophone?(): boolean;
  cancelListening?(requestId: string): Promise<void>;
  onChange(state: ConversationState): void;
  onPlayback(text: string, result: LocalPlaybackResult): void;
}) {
  if (!io.development) throw new Error('Sensi voice fixture is development-only.');
  let voice: LocalVoice | undefined;
  let disposed = false;
  let ownsAudio = false;
  const capture = (): OfflineTranscription => ({
    status: 'success', locale: 'en-US', requiresOnDeviceRecognition: true,
    transcript: SENSI_VOICE_TRANSCRIPT, finalTranscript: SENSI_VOICE_TRANSCRIPT,
    isFinal: true, finalResultReceived: true, hasFinalTranscript: true,
    reason: 'complete', message: 'Synthetic development fixture; no microphone used.',
    totalTimeMs: 0, recognitionTimeMs: 0, listeningTimeMs: 0, finalizationTimeMs: 0,
    firstPartialTimeMs: 0, endpointReason: 'audio_silence', silenceTargetMs: 0, finalizationGraceMs: 0,
  });
  const conversation = new AssistantConversation({
    mode: 'connected',
    prepare: async () => { voice = await io.prepare(); },
    acquire: async stop => {
      const release = await io.audio.acquire('optional', stop);
      ownsAudio = true;
      return () => { ownsAudio = false; release(); };
    },
    speak: async (text, id) => {
      if (!voice || disposed) throw new Error('Voice fixture closed.');
      const result = await io.speak(text, voice.id, id);
      io.onPlayback(text, result);
      if (result.status !== 'completed' || result.voiceId !== voice.id)
        throw new Error(`Native playback ${result.reason}: ${result.message}`);
    },
    listen: (id, progress) => io.listen && (io.useMicrophone?.() ?? true)
      ? io.listen(id, progress) : Promise.resolve(capture()),
    interpret: async () => ({ status: 'success', processingTimeMs: 0, interpretation: {
      wellness: 'uncertain', requestsSavedEmergencyContact: false, explicitContactRequest: false,
      suggestedReply: connectedAdvisory({ version: 1, advisoryOnly: true, callAuthorized: false,
        status: 'ok', code: 'advisory', message: SENSI_VOICE_RESPONSE }),
      advisoryOnly: true, callAuthorized: false,
    } }),
    cancel: async (kind, id) => {
      if (kind === 'speech') await io.cancelSpeech(id);
      if (kind === 'listening') await io.cancelListening?.(id);
    },
    contactAvailability: () => 'missing_contact',
    handoff: async () => { throw new Error('Contact handoff is forbidden in the voice fixture.'); },
    onChange: io.onChange,
  });
  return {
    async start() {
      if (disposed) throw new Error('Voice fixture closed.');
      await conversation.start();
    },
    stop: () => conversation.stop(),
    async close() { disposed = true; await conversation.stop(); },
    async preemptWithSafety() {
      if (disposed) throw new Error('Voice fixture closed.');
      if (!ownsAudio) throw new Error('Start fixture playback before testing preemption.');
      // Exercise the real safety handover without a safety alert, speech, or call.
      // Release immediately; never hold a simulated lease over real safety work.
      const release = await io.audio.acquire('safety', async () => {});
      release();
    },
  };
}

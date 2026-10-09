import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

export type AvailabilityReason =
  | 'available'
  | 'unsupported_os'
  | 'device_not_eligible'
  | 'apple_intelligence_not_enabled'
  | 'model_not_ready'
  | 'unknown_unavailable'
  | 'unknown_availability'
  | 'framework_not_in_build'
  | 'unsupported_platform'
  | 'native_module_missing';

export type FoundationModelsAvailability = {
  available: boolean;
  reason: AvailabilityReason;
  message: string;
};

type NativeAvailabilityModule = {
  checkAvailability(): Promise<FoundationModelsAvailability>;
  interpretDriverResponse?(text: string, requestId: string): Promise<DriverInterpretationResponse>;
  cancelInterpretation?(requestId: string): Promise<void>;
  checkOfflineSpeechCapability?(locale: string): Promise<OfflineSpeechCapability>;
  listenOffline?(locale: string, requestId: string, timeoutMs: number): Promise<OfflineTranscription>;
  cancelOfflineListening?(requestId: string): Promise<void>;
  listLocalVoices?(): Promise<LocalVoice[]>;
  speakLocal?(text: string, voiceId: string, requestId: string): Promise<LocalPlaybackResult>;
  cancelLocalSpeech?(requestId: string): Promise<void>;
  interpretConversation?(text: string, context: string, requestId: string): Promise<DriverInterpretationResponse>;
  addListener?(event: 'offlineSpeechProgress', listener: (progress: OfflineSpeechProgress) => void): { remove(): void };
};

export type LocalVoice = { id: string; name: string; language: string; quality: 'Premium' | 'Enhanced' | 'Standard' };
export type LocalPlaybackResult = {
  status: 'completed' | 'cancelled' | 'error';
  reason: string;
  message: string;
  voiceId: string;
  elapsedMs: number;
};

function playbackModule(): NativeAvailabilityModule {
  if (Platform.OS !== 'ios') throw new Error('The local assistant supports iOS only.');
  const native = requireOptionalNativeModule<NativeAvailabilityModule>('LocalFoundationModels');
  if (!native?.listLocalVoices || !native.speakLocal || !native.cancelLocalSpeech) {
    throw new Error('Local playback methods are missing. Rebuild the native app with local speech playback.');
  }
  return native;
}

export async function listLocalVoices(): Promise<LocalVoice[]> {
  return playbackModule().listLocalVoices!();
}

export async function speakLocal(text: string, voiceId: string, requestId: string): Promise<LocalPlaybackResult> {
  return playbackModule().speakLocal!(text, voiceId, requestId);
}

export async function cancelLocalSpeech(requestId: string): Promise<void> {
  await playbackModule().cancelLocalSpeech!(requestId);
}

export type OfflineSpeechCapability = {
  locale: string;
  supportsOnDeviceRecognition: boolean;
  recognizerAvailable: boolean;
  reason: string;
  message: string;
  speechPermission: string;
  microphonePermission: string;
};

export type OfflineTranscription = {
  status: 'success' | 'incomplete' | 'timeout' | 'cancelled' | 'error';
  locale: string;
  requiresOnDeviceRecognition: true;
  transcript: string;
  isFinal: boolean;
  /** Optional for older native binaries; never used to promote partial results. */
  partialTranscript?: string;
  finalTranscript?: string;
  finalResultReceived?: boolean;
  hasFinalTranscript?: boolean;
  audioLevelDb?: number;
  activityThresholdDb?: number;
  measuredActivityMs?: number;
  silenceMs?: number;
  reason: string;
  message: string;
  totalTimeMs: number;
  recognitionTimeMs: number;
  listeningTimeMs: number;
  finalizationTimeMs: number;
  firstPartialTimeMs: number | null;
  endpointReason: string;
  silenceTargetMs: number;
  finalizationGraceMs: number;
};

export type OfflineSpeechProgress = {
  requestId: string;
  phase: 'preparing' | 'listening' | 'finalizing';
  transcript: string;
  elapsedMs: number;
  audioLevelDb: number;
  activityThresholdDb: number;
  silenceMs: number;
  measuredActivityMs: number;
  endpointReason: string;
};

export function subscribeOfflineSpeechProgress(listener: (progress: OfflineSpeechProgress) => void): { remove(): void } {
  const native = offlineSpeechModule();
  if (!native.addListener) throw new Error('Native speech progress events are missing. Rebuild the Debug app.');
  return native.addListener('offlineSpeechProgress', listener);
}

function offlineSpeechModule(): NativeAvailabilityModule {
  if (Platform.OS !== 'ios') throw new Error('Offline speech diagnostics support iOS only.');
  const native = requireOptionalNativeModule<NativeAvailabilityModule>('LocalFoundationModels');
  if (!native?.checkOfflineSpeechCapability || !native.listenOffline || !native.cancelOfflineListening) {
    throw new Error('Offline speech methods are missing. Rebuild the native app with offline speech methods.');
  }
  return native;
}

export async function checkOfflineSpeechCapability(locale: string): Promise<OfflineSpeechCapability> {
  return offlineSpeechModule().checkOfflineSpeechCapability!(locale);
}

export async function listenOffline(locale: string, requestId: string, timeoutMs = 15000): Promise<OfflineTranscription> {
  return offlineSpeechModule().listenOffline!(locale, requestId, timeoutMs);
}

export async function cancelOfflineListening(requestId: string): Promise<void> {
  await offlineSpeechModule().cancelOfflineListening!(requestId);
}

export type DriverInterpretation = {
  wellness: 'ok' | 'not_ok' | 'uncertain';
  requestsSavedEmergencyContact: boolean;
  /** Model assessment only; deterministic production consent rules remain authoritative. */
  explicitContactRequest: boolean;
  suggestedReply: string;
  advisoryOnly: true;
  callAuthorized: false;
};

export type DriverInterpretationResponse =
  | { status: 'success'; processingTimeMs: number; interpretation: DriverInterpretation }
  | { status: 'error'; processingTimeMs: number; error: { code: string; message: string } };

function interpretationModule(): NativeAvailabilityModule {
  if (Platform.OS !== 'ios') throw new Error('This prototype supports iOS only.');
  const native = requireOptionalNativeModule<NativeAvailabilityModule>('LocalFoundationModels');
  if (!native?.interpretDriverResponse || !native.cancelInterpretation) {
    throw new Error('Native interpretation methods are missing. Rebuild the native app.');
  }
  return native;
}

/** No side effects beyond on-device generation. requestId owns cancellation. */
export async function interpretDriverResponse(text: string, requestId: string): Promise<DriverInterpretationResponse> {
  const native = interpretationModule();
  return native.interpretDriverResponse!(text, requestId);
}

export async function cancelDriverInterpretation(requestId: string): Promise<void> {
  const native = interpretationModule();
  await native.cancelInterpretation!(requestId);
}

/** Explicit diagnostic only: importing this file does not check or generate anything. */
export async function checkFoundationModelsAvailability(): Promise<FoundationModelsAvailability> {
  if (Platform.OS !== 'ios') {
    return { available: false, reason: 'unsupported_platform', message: 'This prototype supports iOS only.' };
  }
  const native = requireOptionalNativeModule<NativeAvailabilityModule>('LocalFoundationModels');
  if (!native) {
    return { available: false, reason: 'native_module_missing', message: 'Rebuild the native app with LocalFoundationModels included. Expo Go and existing binaries do not contain this module.' };
  }
  return native.checkAvailability();
}

/** Bounded, in-memory conversation context; no consent or app services are passed to AI. */
export async function interpretConversation(text: string, context: string, requestId: string): Promise<DriverInterpretationResponse> {
  const native = interpretationModule();
  if (!native.interpretConversation) throw new Error('Conversation method missing. A native rebuild is required.');
  return native.interpretConversation(text, context, requestId);
}

/** Check the complete runtime bridge before the assistant starts any audio. */
export async function checkDriverAssistantAvailability(): Promise<FoundationModelsAvailability> {
  if (Platform.OS !== 'ios') return checkFoundationModelsAvailability();
  const native = requireOptionalNativeModule<NativeAvailabilityModule>('LocalFoundationModels');
  if (!native?.interpretConversation || !native.cancelInterpretation || !native.checkOfflineSpeechCapability
      || !native.listenOffline || !native.cancelOfflineListening || !native.listLocalVoices
      || !native.speakLocal || !native.cancelLocalSpeech || !native.addListener) {
    return { available: false, reason: 'native_module_missing',
      message: 'The Driver Assistant bridge is missing or outdated. Rebuild the native app; Expo Go cannot run it.' };
  }
  return native.checkAvailability();
}

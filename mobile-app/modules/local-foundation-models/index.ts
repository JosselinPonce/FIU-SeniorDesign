import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

type NativeSpeechModule = {
  checkOfflineSpeechCapability?(locale: string): Promise<OfflineSpeechCapability>;
  listenOffline?(locale: string, requestId: string, timeoutMs: number): Promise<OfflineTranscription>;
  cancelOfflineListening?(requestId: string): Promise<void>;
  listLocalVoices?(): Promise<LocalVoice[]>;
  speakLocal?(text: string, voiceId: string, requestId: string): Promise<LocalPlaybackResult>;
  cancelLocalSpeech?(requestId: string): Promise<void>;
  addListener?(event: 'offlineSpeechProgress', listener: (progress: OfflineSpeechProgress) => void): { remove(): void };
};

export type LocalVoice = { id: string; name: string; language: string; quality: 'Premium' | 'Enhanced' | 'Standard' };
export type LocalPlaybackResult = {
  nativeRevision?: string;
  playbackStarted?: boolean;
  completionEvent?: string;
  status: 'completed' | 'cancelled' | 'error';
  reason: string;
  message: string;
  voiceId: string;
  elapsedMs: number;
};

function playbackModule(): NativeSpeechModule {
  if (Platform.OS !== 'ios') throw new Error('Native system playback supports iOS only.');
  const native = requireOptionalNativeModule<NativeSpeechModule>('LocalFoundationModels');
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

/** Numeric/state-only endpoint diagnostics; never recognition or consent evidence. */
export type OfflineEndpointDiagnostics = {
  noiseFloorDb: number;
  noiseCalibration: string;
  calibrationWindowMs: number;
  activityThresholdMinDb: number;
  activityThresholdMaxDb: number;
  aboveThresholdFraction: number;
  bufferedAudioMs: number;
  bufferAgeMs: number | null;
  audioLevelDb: number;
  activityThresholdDb: number;
  measuredActivityMs: number;
  silenceMs: number;
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
  endpointDiagnostics?: OfflineEndpointDiagnostics;
  endpointSelectionMeasurements?: Partial<OfflineEndpointDiagnostics>;
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
  endpointDiagnostics?: OfflineEndpointDiagnostics;
  endpointSelectionMeasurements?: Partial<OfflineEndpointDiagnostics>;
};

export function subscribeOfflineSpeechProgress(listener: (progress: OfflineSpeechProgress) => void): { remove(): void } {
  const native = offlineSpeechModule();
  if (!native.addListener) throw new Error('Native speech progress events are missing. Rebuild the Debug app.');
  return native.addListener('offlineSpeechProgress', listener);
}

function offlineSpeechModule(): NativeSpeechModule {
  if (Platform.OS !== 'ios') throw new Error('Offline speech diagnostics support iOS only.');
  const native = requireOptionalNativeModule<NativeSpeechModule>('LocalFoundationModels');
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

/** Speech/playback bridge availability is independent of Apple Intelligence. */
export function checkDriverAssistantSpeechAvailability(): { available: boolean; message: string } {
  if (Platform.OS !== 'ios') return { available: false, message: 'The Driver Assistant requires iOS offline speech and Apple voice playback.' };
  const native = requireOptionalNativeModule<NativeSpeechModule>('LocalFoundationModels');
  if (!native?.checkOfflineSpeechCapability || !native.listenOffline || !native.cancelOfflineListening
    || !native.listLocalVoices || !native.speakLocal || !native.cancelLocalSpeech || !native.addListener) {
    return { available: false, message: 'The offline speech/playback bridge is missing. Rebuild the native app.' };
  }
  return { available: true, message: 'Native offline speech and playback are available.' };
}

import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

type NativeSpeechModule = {
  prepareVoiceCheckAlignedSession?(requestId: string): Promise<{ aligned: boolean; reason: string; timingMs?: Record<string, number> }>;
  playVoiceCheckListeningCue?(requestId: string): Promise<void>;
  cancelVoiceCheckListeningCue?(requestId: string): Promise<void>;
  checkSpanishTranscriberCapability?(): Promise<SpanishTranscriberCapability>;
  testSpanishOfflineTranscription?(requestId: string): Promise<SpanishTranscriptionTestResult>;
  cancelSpanishOfflineTranscription?(requestId: string): Promise<void>;
  checkOfflineSpeechCapability?(locale: string): Promise<OfflineSpeechCapability>;
  prepareOfflineRecognition?(locale: string, requestId: string): Promise<{ status: string; reason?: string }>;
  listenOffline?(locale: string, requestId: string, timeoutMs: number): Promise<OfflineTranscription>;
  cancelOfflineListening?(requestId: string): Promise<void>;
  listLocalVoices?(): Promise<LocalVoice[]>;
  speakLocal?(text: string, voiceId: string, requestId: string): Promise<LocalPlaybackResult>;
  cancelLocalSpeech?(requestId: string): Promise<void>;
  addListener?(event: 'offlineSpeechProgress', listener: (progress: OfflineSpeechProgress) => void): { remove(): void };
};

/** Optional cue: missing/failed playback must never disable the safety response controls. */
export async function playVoiceCheckListeningCue(requestId: string): Promise<void> {
  if (Platform.OS !== 'ios') return;
  await requireOptionalNativeModule<NativeSpeechModule>('LocalFoundationModels')?.playVoiceCheckListeningCue?.(requestId);
}
export async function cancelVoiceCheckListeningCue(requestId: string): Promise<void> {
  if (Platform.OS !== 'ios') return;
  await requireOptionalNativeModule<NativeSpeechModule>('LocalFoundationModels')?.cancelVoiceCheckListeningCue?.(requestId);
}

export type SpanishTranscriberCapability = {
  status: 'available' | 'hardware_unavailable' | 'requires_ios_26';
  osVersion: string;
  deviceAvailable: boolean;
  supportedSpanishLocales: string[];
  installedSpanishLocales: string[];
  reservedLocales: string[];
  maximumReservedLocales: number;
  requestedLocales: { locale: string; exactSupported: boolean; equivalentLocale: string | null }[];
  assets: { locale: string; installedLocale: boolean; assetStatus: 'installed' | 'supported' | 'downloading' | 'unsupported' | 'unknown' }[];
};

export function spanishTranscriberReadiness(row: SpanishTranscriberCapability['assets'][number]): string {
  if (row.assetStatus === 'installed' && row.installedLocale) return 'Readiness reported; offline test required';
  if (row.installedLocale || row.assetStatus === 'installed') return 'Inventory signals differ; readiness uncertain';
  if (row.assetStatus === 'supported') return 'Supported; not listed as installed';
  return 'Readiness not established';
}

export type SpanishTranscriptionTestResult = {
  status: 'success' | 'incomplete' | 'cancelled' | 'error';
  transcript: string;
  locale?: string;
  reason?: string;
  nativeTimingMs?: Record<string, number>;
  sessionAlignment?: Record<string, unknown>;
  preparationTimeMs?: number;
  recognitionTimeMs?: number;
  captureTimeMs?: number;
  totalTimeMs?: number;
  reservationsBefore?: string[];
  introducedReservation?: boolean;
  reservationReleased?: boolean;
  assetStatusBefore?: string;
  assetStatusAfter?: string;
  error?: { domain: string; code: number; message: string };
  conversionError?: string;
  cleanupErrors?: string[];
};

function spanishTestModule(): NativeSpeechModule {
  if (!__DEV__) throw new Error('Spanish microphone diagnostics require a development build.');
  if (Platform.OS !== 'ios') throw new Error('Spanish microphone diagnostics support iOS only.');
  const native = requireOptionalNativeModule<NativeSpeechModule>('LocalFoundationModels');
  if (!native?.testSpanishOfflineTranscription || !native.cancelSpanishOfflineTranscription) {
    throw new Error('Spanish microphone diagnostic bridge is missing. Rebuild the Debug app in Xcode.');
  }
  return native;
}

export async function testSpanishOfflineTranscription(requestId: string): Promise<SpanishTranscriptionTestResult> {
  return spanishTestModule().testSpanishOfflineTranscription!(requestId);
}

export async function cancelSpanishOfflineTranscription(requestId: string): Promise<void> {
  await spanishTestModule().cancelSpanishOfflineTranscription!(requestId);
}

export function subscribeSpanishTranscriberTestProgress(listener: (event: { requestId: string; phase: 'preparing' | 'recording' | 'finalizing' }) => void): { remove(): void } {
  spanishTestModule();
  const native = requireOptionalNativeModule<{
    addListener(event: 'spanishTranscriberTestProgress', callback: typeof listener): { remove(): void };
  }>('LocalFoundationModels');
  if (!native?.addListener) throw new Error('Spanish microphone progress bridge is missing. Rebuild the Debug app.');
  return native.addListener('spanishTranscriberTestProgress', listener);
}

export async function checkSpanishTranscriberCapability(): Promise<SpanishTranscriberCapability> {
  if (!__DEV__) throw new Error('SpeechTranscriber capability diagnostics require a development build.');
  if (Platform.OS !== 'ios') throw new Error('SpeechTranscriber capability diagnostics support iOS only.');
  const native = requireOptionalNativeModule<NativeSpeechModule>('LocalFoundationModels');
  if (!native?.checkSpanishTranscriberCapability) throw new Error('SpeechTranscriber diagnostic bridge is missing. Rebuild the Debug app in Xcode.');
  return native.checkSpanishTranscriberCapability();
}

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
  engine?: 'speech_transcriber';
  resolvedLocale?: string | null;
  assetStatus?: string;
  installedLocale?: boolean;
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

/** Bounded Debug energy summaries. Early/later are time windows, not speech labels. */
export type ShadowEnergyDistribution = {
  durationMs: number; rms: number | null; powerDb: number | null; minDb: number | null; maxDb: number | null;
  aboveThresholdFraction: number | null; histogramMs: number[];
};
export type ShadowEnergyGroup = {
  sampled: ShadowEnergyDistribution; full: ShadowEnergyDistribution; dcCentered: ShadowEnergyDistribution;
  meanAbsDC: number | null; maxAbsDC: number | null;
};
export type EnglishShadowAudioDiagnostics = {
  version: 'english-shadow-energy-v1'; thresholdDb: number; earlyAudioWindowMs: number; windowBasis: 'accepted_pcm_duration';
  histogramUpperEdgesDb: number[]; bufferCount: number; invalidBufferCount: number; unsupportedBufferCount: number;
  sampleRateMin: number | null; sampleRateMax: number | null; channelCountMin: number | null; channelCountMax: number;
  frameCountMin: number | null; frameCountMax: number; omittedChannelSummaries: number;
  all: ShadowEnergyGroup; early: ShadowEnergyGroup; later: ShadowEnergyGroup;
  channels: { index: number; energy: ShadowEnergyGroup }[];
};

export type EnglishRecognitionResultMetadata = {
  resultPresent: boolean; rawIsFinal?: boolean; bestTrimmedPresent?: boolean; bestAlphanumericPresent?: boolean;
  segmentCount?: number; hasNonemptySegment?: boolean; transcriptionCount?: number; nonemptyTranscriptionCount?: number;
};

/** Debug-only English metadata; never final evidence or driver text. */
export type EnglishFinalizationDiagnostics = {
  resultMetadataRevision?: 'english-result-metadata-v1';
  requestConfiguration?: { requiresOnDeviceRecognition: boolean; shouldReportPartialResults: boolean; taskHintRawValue: number;
    recognizerLocale: string; contextualStringCount: number; addsPunctuation?: boolean };
  resultSnapshots?: Partial<Record<'firstPartialAtCallback' | 'firstPartialHandled' | 'finalAtCallback' | 'finalHandled' | 'terminalAtCallback' | 'terminalHandled', EnglishRecognitionResultMetadata>>;
  captureId: string;
  rawAppleIsFinal: boolean | null;
  applicationFinalizationStarted: boolean;
  completionOrigin: 'final_after_application_endpoint' | 'apple_final_before_application_endpoint' | 'terminal_without_final';
  callbackError: { domain?: string; code?: number };
  taskSnapshots: Record<string, { state: number; isCancelled: boolean; isFinishing: boolean; errorDomain?: string; errorCode?: number }>;
  endpointAtCompletion: OfflineEndpointDiagnostics;
  endpointAtSelection: Partial<OfflineEndpointDiagnostics>;
  endpointSelectionChecks: Partial<Record<'calibrationReady' | 'speechRecognized' | 'minimumActivity' | 'freshPCM' | 'silenceSatisfied' | 'deadlineExpired', boolean>>;
  endpointReady: boolean;
  hadPartial: boolean;
  deadlineRemainingMs: number;
  shadowAudio?: EnglishShadowAudioDiagnostics;
};

export type OfflineTranscription = {
  englishFinalizationDebug?: EnglishFinalizationDiagnostics;
  nativeTimingMs?: Record<string, number>;
  sessionAlignment?: Record<string, unknown>;
  nativeRevision?: string;
  listeningCueError?: string | null;
  audioOutputVolume?: number;
  audioOutputRoute?: string[];
  status: 'success' | 'incomplete' | 'timeout' | 'cancelled' | 'error';
  locale: string;
  /** Apple's resolved Spanish model locale; locale remains the requested adapter locale. */
  recognitionLocale?: string;
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
  preparationTimeMs?: number;
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
  phase: 'preparing' | 'ready' | 'listening' | 'finalizing';
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

/** Debug-only opt-in; older binaries and Release retain sequential session setup. */
export async function prepareVoiceCheckAlignedSession(requestId: string): Promise<{ aligned: boolean; reason: string; timingMs?: Record<string, number> }> {
  if (typeof __DEV__ === 'undefined' || !__DEV__ || Platform.OS !== 'ios') return { aligned: false, reason: 'sequential_release_or_platform' };
  const native = offlineSpeechModule();
  return native.prepareVoiceCheckAlignedSession ? native.prepareVoiceCheckAlignedSession(requestId) : { aligned: false, reason: 'sequential_bridge_unavailable' };
}

/** Optional for compatibility with a previously built binary; absence retains serial recognition. */
export async function prepareOfflineRecognition(locale: string, requestId: string): Promise<{ status: string; reason?: string }> {
  const native = offlineSpeechModule();
  return native.prepareOfflineRecognition ? native.prepareOfflineRecognition(locale, requestId) : { status: 'unavailable' };
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

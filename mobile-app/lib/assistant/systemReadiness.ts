import type { GemmaFileStatus } from './sensiStandby.ts';
import type { PocState } from '../../modules/gemma-poc/controller.ts';
import type { OfflineSpeechCapability } from '../../modules/local-foundation-models/index.ts';

export type ReadinessItem = Readonly<{ id: 'sensors' | 'gemma' | 'recognition' | 'responses' | 'manual'; label: string; status: string; detail?: string; percent?: number }>;
export type VoiceResponseStatus = 'checking' | 'available' | 'unavailable' | 'unknown';
export type ReadinessSnapshot = Readonly<{
  file: GemmaFileStatus;
  installation?: 'checking' | 'installed' | 'missing' | 'unverified' | 'unavailable';
  runtime: Pick<PocState, 'busy' | 'phase' | 'error' | 'installed' | 'loaded' | 'cleanupRequired' | 'progress'>;
  speech: OfflineSpeechCapability | null;
  installedLocales: readonly string[];
  responses: VoiceResponseStatus;
  foreground: boolean;
}>;
export type SensorReadiness = { connection?: string; source?: 'relay' | 'esp32'; relayConnected?: boolean; monitoring?: string; hasDriver: boolean };
const canonical = (locale: string) => locale.replace(/_/g, '-').toLowerCase();

/** Presentation projection only. Simulation values and cached vitals are not inputs. */
export function sensorReadiness(input: SensorReadiness): ReadinessItem {
  const row = { id: 'sensors' as const, label: 'Steering-wheel sensors' };
  if (['scanning', 'connecting', 'discovering', 'waiting'].includes(input.connection ?? '')) return { ...row, status: 'Connecting' };
  if (input.connection === 'failed') return { ...row, status: 'Connection unavailable' };
  if (input.connection !== 'connected') return { ...row, status: input.connection ? 'Not connected' : 'Connection not verified' };
  if (input.source === 'relay') {
    if (input.relayConnected === false) return { ...row, status: 'Not connected', detail: 'Relay connected; wheel sensors disconnected.' };
    if (input.relayConnected !== true) return { ...row, status: 'Connection not verified', detail: 'Waiting for the relay sensor-link status.' };
  } else if (input.source !== 'esp32') return { ...row, status: 'Connection not verified' };
  return { ...row, status: 'Connected' };
}

/** Installed means an unchanged approved-artifact receipt, never runtime readiness. */
export function gemmaReadiness(snapshot: ReadinessSnapshot): ReadinessItem {
  const row = { id: 'gemma' as const, label: 'Sensi AI (Gemma)' };
  const runtime = snapshot.runtime;
  if (runtime.busy && (runtime.progress?.stage === 'download' || !runtime.progress && runtime.phase === 'Downloading and verifying model')) {
    const { completed, total } = runtime.progress ?? { completed: NaN, total: NaN };
    const valid = Number.isFinite(completed) && Number.isFinite(total) && completed >= 0 && total > 0 && completed <= total;
    return { ...row, status: 'Downloading', ...(valid ? { percent: Math.floor(completed / total * 100) } : {}) };
  }
  if (snapshot.file === 'present' && snapshot.installation === 'installed') return { ...row, status: 'Installed' };
  if (snapshot.installation === 'unavailable' || runtime.error || runtime.cleanupRequired) return { ...row, status: 'Unavailable', detail: 'Fixed safety responses remain available.' };
  if (snapshot.file === 'missing' || snapshot.installation === 'missing') return { ...row, status: 'Not installed' };
  if (snapshot.file === 'checking' || snapshot.installation === 'checking') return { ...row, status: 'Checking model status' };
  if (snapshot.file !== 'present') return { ...row, status: 'Unavailable', detail: 'Model status could not be verified.' };
  return { ...row, status: 'Installation unverified', detail: 'Integrity and runtime availability are checked before use.' };
}

/** Text and icons share a semantic tone; status words remain the accessible meaning. */
export function readinessIndicator(status: string) {
  if (['Connected', 'Available', 'Installed'].includes(status)) return { tone: 'success', icon: 'check-circle' } as const;
  if (['Connecting', 'Downloading'].includes(status)) return { tone: 'warning', icon: 'clock' } as const;
  if (['Unavailable', 'Error', 'Connection unavailable'].includes(status)) return { tone: 'danger', icon: 'alert-circle' } as const;
  return { tone: 'neutral', icon: 'minus-circle' } as const;
}

export function recognitionReadiness(snapshot: ReadinessSnapshot, language: 'en' | 'es'): ReadinessItem {
  const row = { id: 'recognition' as const, label: 'Voice recognition' };
  const capability = snapshot.speech;
  const unknown = { ...row, status: 'Checked when a safety check starts' };
  const locale = language === 'es' ? 'es-US' : 'en-US';
  if (!snapshot.foreground || !capability || typeof capability.locale !== 'string' || canonical(capability.locale) !== canonical(locale)) return unknown;
  if (!capability.supportsOnDeviceRecognition || !capability.recognizerAvailable) return { ...row, status: 'Unavailable', detail: 'Typed and button responses remain available.' };
  const speech = capability.speechPermission?.toLowerCase(), mic = capability.microphonePermission?.toLowerCase();
  if (['denied', 'restricted', 'notdetermined', 'undetermined'].includes(speech) || ['denied', 'notdetermined', 'undetermined'].includes(mic)) return { ...row, status: 'Permission required' };
  if (speech !== 'authorized' || mic !== 'granted') return unknown;
  const assets = language === 'es'
    ? capability.engine === 'speech_transcriber' && capability.installedLocale === true && capability.assetStatus === 'installed'
    : snapshot.installedLocales.some(installed => canonical(installed) === canonical(locale));
  if (!assets) return unknown;
  return { ...row, status: 'Available', detail: 'Capability reported; microphone capture is checked at use.' };
}

export function systemReadiness(input: SensorReadiness, snapshot: ReadinessSnapshot, language: 'en' | 'es') {
  const sensors = sensorReadiness(input);
  const overall = !input.hasDriver ? 'Select a driver'
    : !snapshot.foreground ? 'Readiness not verified'
    : sensors.status === 'Connecting' ? 'Connecting sensors'
    : sensors.status !== 'Connected' ? 'Sensor connection needed'
    : input.monitoring === 'unavailable' ? 'Safety monitoring unavailable'
    : input.monitoring !== 'active' ? 'Awaiting valid readings' : 'Safety checks available';
  const responses: ReadinessItem = { id: 'responses', label: 'Voice responses',
    status: !snapshot.foreground || ['checking', 'unknown'].includes(snapshot.responses) ? 'Checked when a safety check starts'
      : snapshot.responses === 'available' ? 'Available' : 'Unavailable',
    ...(snapshot.responses === 'available' && snapshot.foreground ? { detail: 'Installed voice found; playback is checked at use.' } : {}) };
  return { overall, items: [sensors, gemmaReadiness(snapshot), recognitionReadiness(snapshot, language), responses,
    { id: 'manual', label: 'Manual responses', status: 'Available', detail: 'Typed and button responses.' } as ReadinessItem] };
}

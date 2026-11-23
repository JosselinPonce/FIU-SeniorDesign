import type { OfflineSpeechCapability } from '../../modules/local-foundation-models/index.ts';

export type ReadinessItem = Readonly<{ id: 'sensors' | 'recognition' | 'responses' | 'manual'; label: string; status: string; detail?: string }>;
export type VoiceResponseStatus = 'checking' | 'available' | 'unavailable' | 'unknown';
export type ReadinessSnapshot = Readonly<{
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

/** Text and icons share a semantic tone; status words remain the accessible meaning. */
export function readinessIndicator(status: string) {
  if (['Connected', 'Available'].includes(status)) return { tone: 'success', icon: 'check-circle' } as const;
  if (['Connecting'].includes(status)) return { tone: 'warning', icon: 'clock' } as const;
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
  return { overall, items: [sensors, recognitionReadiness(snapshot, language), responses,
    { id: 'manual', label: 'Manual responses', status: 'Available', detail: 'Typed and button responses.' } as ReadinessItem] };
}

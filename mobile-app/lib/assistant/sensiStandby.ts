/** Navigation is independent of model/voice readiness. This never starts a check. */
export function sensiDestination(safety: { check: unknown; conversation: unknown }): 'safety' | 'standby' {
  return safety.check || safety.conversation ? 'safety' : 'standby';
}
export function openSensi(safety: { check: unknown; conversation: unknown }, showStandby: (open: boolean) => void) {
  const destination = sensiDestination(safety);
  showStandby(destination === 'standby');
  return destination;
}
export type GemmaFileStatus = 'checking' | 'present' | 'missing' | 'unavailable';
export function standbyReadiness(input: {
  hasDriver: boolean; activeDrive: boolean; connected: boolean;
  voice: { granted: boolean; onDevice: boolean } | null;
  model: GemmaFileStatus; core: boolean;
  monitoring?: 'disconnected' | 'waiting' | 'active' | 'unavailable';
}): string[] {
  return [
    !input.hasDriver ? 'Select a driver before starting a drive.'
      : !input.connected ? 'Waiting for the steering-wheel sensor connection.'
      : input.monitoring === 'unavailable' ? 'Safety monitoring temporarily unavailable.'
      : input.monitoring !== 'active' ? 'Sensors connected. Awaiting fresh, valid readings.'
      : 'Safety monitoring active. Safety checks start from accepted sensor readings.',
    input.activeDrive ? 'Trip recording active.' : 'Trip recording inactive. Start Drive records a trip; safety monitoring is independent.',
    input.voice === null ? 'Voice readiness is checked when selecting a driver.'
      : input.voice.granted && input.voice.onDevice ? 'On-device voice responses are available.'
      : 'Voice access or offline recognition is unavailable. Safety checks retain typed and button responses.',
    input.model === 'checking' ? 'Checking whether the Gemma model is installed…'
      : input.model === 'present' ? 'Gemma model file present. Integrity and runtime availability are checked before use.'
      : input.model === 'missing' ? 'Gemma model unavailable. Fixed acknowledgments remain available.'
      : 'Gemma availability could not be checked. Fixed acknowledgments remain available.',
  ];
}

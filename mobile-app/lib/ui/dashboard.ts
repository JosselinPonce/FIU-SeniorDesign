/** Presentation only: no monitoring, consent, persistence or transport side effects. */
export function vitalPresentation(value: number | null, lastRx: Date | null, connected: boolean, now: number) {
  const available = value !== null && Number.isFinite(value) && lastRx !== null;
  if (!available) return { value: null, state: 'unavailable' as const, label: 'Unavailable' };
  const age = now - lastRx.getTime();
  return connected && age >= 0 && age < 3000
    ? { value, state: 'live' as const, label: 'Live sensor reading' }
    : { value, state: 'stale' as const, label: 'Stale · last reading' };
}

/** A personal-reference comparison is available only for a reliable, current drive reading. */
export function liveBaselineHeartRate(input: {
  bpm: number | null;
  lastRx: Date | null;
  connected: boolean;
  now: number;
  active: boolean;
  reliable: boolean;
}) {
  if (!input.active || !input.reliable) return null;
  const reading = vitalPresentation(input.bpm, input.lastRx, input.connected, input.now);
  return reading.state === 'live' ? reading.value : null;
}

export type WarningBounds = { low?: number; high?: number };
/** Instantaneous display qualification only; never emits a monitoring episode. */
export function vitalRangePresentation(value: number | null, lastRx: Date | null, connected: boolean, now: number, bounds?: WarningBounds) {
  const reading = vitalPresentation(value, lastRx, connected, now);
  if (reading.state !== 'live' || reading.value === null || !bounds) return reading;
  const outside = (bounds.low !== undefined && reading.value <= bounds.low) || (bounds.high !== undefined && reading.value >= bounds.high);
  return { ...reading, state: outside ? 'warning' as const : 'live' as const,
    label: outside ? 'Outside personalized range' : 'Live · within personalized range' };
}
export type DrivePage = 'dashboard' | 'vitals';
export function drivePageAfter(action: 'details' | 'back' | 'tab'): DrivePage {
  return action === 'details' ? 'vitals' : 'dashboard';
}

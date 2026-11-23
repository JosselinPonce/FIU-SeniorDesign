import type { Frame } from '../ble/protocol.ts';

export const SENSOR_STALE_MS = 3000;
export type ContinuityBreak = {
  previousSequence: number | null;
  currentSequence: number;
  sequenceDelta: number | null;
  missingFrames: number;
  phoneIntervalMs: number | null;
  deviceIntervalMs: number | null;
  failedChecks: ('sequence_delta' | 'missing_frames' | 'phone_interval_short' | 'phone_interval_stale'
    | 'device_timestamp_unchanged' | 'device_interval_stale' | 'transport_restart')[];
};

/** Safety-only continuity, after existing CRC decoding. Frames represent ~1 second.
 * Device uptime is relative, not a trustworthy absolute acquisition timestamp. */
export class SensorContinuity {
  private last: { seq: number; endMs: number; at: number } | null = null;
  reset() { this.last = null; }
  get lastAt() { return this.last?.at ?? null; }
  describeBreak(f: Frame, at: number, missing: number, failedChecks: ContinuityBreak['failedChecks']): ContinuityBreak {
    const previous = this.last;
    return { previousSequence: previous?.seq ?? null, currentSequence: f.seq,
      sequenceDelta: previous ? (f.seq - previous.seq) >>> 0 : null, missingFrames: missing,
      phoneIntervalMs: previous ? at - previous.at : null,
      deviceIntervalMs: previous ? (f.endMs - previous.endMs) >>> 0 : null, failedChecks };
  }

  accept(f: Frame, at: number, missing: number, observeBreak?: (evidence: ContinuityBreak) => void): { accepted: boolean; broken: boolean } {
    const previous = this.last;
    if (!previous) {
      if (missing > 0) observeBreak?.(this.describeBreak(f, at, missing, ['missing_frames']));
      this.last = { seq: f.seq, endMs: f.endMs, at };
      return { accepted: true, broken: false };
    }
    const delta = (f.seq - previous.seq) >>> 0;
    if (delta === 0) return { accepted: false, broken: false };
    const elapsed = at - previous.at;
    const deviceElapsed = (f.endMs - previous.endMs) >>> 0;
    const staleDevice = (f.endMs !== 0 || previous.endMs !== 0) && (deviceElapsed === 0 || deviceElapsed > SENSOR_STALE_MS);
    const sequenceGap = delta !== 1;
    const missingFrames = missing > 0;
    const shortPhoneInterval = elapsed < 500;
    const stalePhoneInterval = elapsed >= SENSOR_STALE_MS;
    const broken = sequenceGap || missingFrames || stalePhoneInterval || shortPhoneInterval || staleDevice;
    if (broken && observeBreak) {
      const failedChecks: ContinuityBreak['failedChecks'] = [];
      if (sequenceGap) failedChecks.push('sequence_delta');
      if (missingFrames) failedChecks.push('missing_frames');
      if (shortPhoneInterval) failedChecks.push('phone_interval_short');
      if (stalePhoneInterval) failedChecks.push('phone_interval_stale');
      if (staleDevice) failedChecks.push(deviceElapsed === 0 ? 'device_timestamp_unchanged' : 'device_interval_stale');
      observeBreak(this.describeBreak(f, at, missing, failedChecks));
    }
    this.last = { seq: f.seq, endMs: f.endMs, at };
    // A discontinuity is only a new anchor, never confirmation evidence.
    return { accepted: !broken, broken };
  }
}

export type MonitoringStatus = 'disconnected' | 'waiting' | 'active' | 'unavailable';
export function monitoringMessage(status: MonitoringStatus): string {
  return status === 'disconnected' ? 'Sensors disconnected. Safety monitoring is waiting.'
    : status === 'waiting' ? 'Sensors connected. Awaiting fresh, valid readings.'
    : status === 'active' ? 'Safety monitoring active.'
    : 'Safety monitoring temporarily unavailable. Keep DriveSense open on a supported screen.';
}

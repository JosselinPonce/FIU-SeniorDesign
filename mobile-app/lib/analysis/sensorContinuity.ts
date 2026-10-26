import type { Frame } from '../ble/protocol.ts';

export const SENSOR_STALE_MS = 3000;
/** Safety-only continuity, after existing CRC decoding. Frames represent ~1 second.
 * Device uptime is relative, not a trustworthy absolute acquisition timestamp. */
export class SensorContinuity {
  private last: { seq: number; endMs: number; at: number } | null = null;
  reset() { this.last = null; }
  get lastAt() { return this.last?.at ?? null; }
  accept(f: Frame, at: number, missing: number): { accepted: boolean; broken: boolean } {
    const previous = this.last;
    if (!previous) {
      this.last = { seq: f.seq, endMs: f.endMs, at };
      return { accepted: true, broken: false };
    }
    const delta = (f.seq - previous.seq) >>> 0;
    if (delta === 0) return { accepted: false, broken: false };
    const elapsed = at - previous.at;
    const deviceElapsed = (f.endMs - previous.endMs) >>> 0;
    const staleDevice = (f.endMs !== 0 || previous.endMs !== 0) && (deviceElapsed === 0 || deviceElapsed > SENSOR_STALE_MS);
    const broken = delta !== 1 || missing > 0 || elapsed >= SENSOR_STALE_MS || elapsed < 500 || staleDevice;
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

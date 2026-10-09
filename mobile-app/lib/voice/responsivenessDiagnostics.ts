/** Opt-in, bounded RAM only. No transcript, prompt, reply, contact or error text. */
export type TimingDetails = {
  voiceId?: string; locale?: string; onDeviceRequired?: boolean;
  isFinal?: boolean; hasText?: boolean; finalResultReceived?: boolean; hasFinalTranscript?: boolean;
  status?: string; endpointReason?: string; nativeMs?: number; listeningMs?: number;
  finalizingMs?: number; firstPartialMs?: number | null;
};
export type TimingRecord = {
  id: number; lane: 'warning' | 'assistant'; operation: string; startedMs: number;
  events: { point: string; elapsedMs: number; details: TimingDetails }[];
};
export class ResponsivenessRecorder {
  private enabled = false;
  private epoch = 0;
  private sequence = 0;
  private origin = 0;
  private records: TimingRecord[] = [];
  private readonly now: () => number;
  constructor(now: () => number = () => performance.now()) { this.now = now; }
  isEnabled() { return this.enabled; }
  setEnabled(value: boolean) { this.enabled = value; this.clear(); }
  clear() { this.epoch++; this.records = []; this.origin = this.now(); }
  snapshot(): TimingRecord[] {
    return this.records.map(r => ({ ...r, events: r.events.map(e => ({ ...e, details: { ...e.details } })) }));
  }
  begin(lane: TimingRecord['lane'], operation: string) {
    const epoch = this.epoch;
    const enabled = this.enabled;
    const start = this.now();
    const record: TimingRecord = { id: ++this.sequence, lane, operation, startedMs: start - this.origin, events: [] };
    if (enabled) { this.records.push(record); if (this.records.length > 80) this.records.shift(); }
    const seen = new Set<string>();
    return (point: string, details: TimingDetails = {}) => {
      if (!enabled || !this.enabled || epoch !== this.epoch || seen.has(point) || !this.records.includes(record)) return;
      // First occurrence only: progress callbacks cannot fill memory indefinitely.
      if (record.events.length < 24) {
        seen.add(point);
        record.events.push({ point, elapsedMs: this.now() - start, details: { ...details } });
      }
    };
  }
}
export const responsiveness = new ResponsivenessRecorder();
export function responsivenessProbe(lane: TimingRecord['lane'], operation: string) {
  return typeof __DEV__ !== 'undefined' && __DEV__ ? responsiveness.begin(lane, operation) : (_point: string, _details?: TimingDetails) => {};
}

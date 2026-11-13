/** Opt-in, bounded RAM only. No transcript, prompt, reply, contact or error text. */
export type TimingDetails = {
  englishFinalization?: import('../../modules/local-foundation-models').EnglishFinalizationDiagnostics;
  captureId?: string;
  question?: string; phase?: string; source?: string; channel?: string; outcome?: string;
  stage?: string; current?: boolean; captureMatches?: boolean; usable?: boolean;
  hasTranscript?: boolean; hasFinalText?: boolean; transcriptsMatch?: boolean;
  localeMatches?: boolean; cancelled?: boolean; settled?: boolean; fallbackText?: boolean;
  sessionAlignment?: Record<string, unknown>;
  nativeTimingMs?: Record<string, number>;
  cueFailed?: boolean; outputVolume?: number; outputRoute?: string;
  nativeRevision?: string; playbackStarted?: boolean; completionEvent?: string;
  voiceId?: string; locale?: string; onDeviceRequired?: boolean;
  isFinal?: boolean; hasText?: boolean; finalResultReceived?: boolean; hasFinalTranscript?: boolean;
  reason?: string; status?: string; endpointReason?: string; nativeMs?: number; listeningMs?: number;
  preparationMs?: number; finalizingMs?: number; firstPartialMs?: number | null;
  decisionSource?: string;
};
export type TimingRecord = {
  id: number; lane: 'warning' | 'assistant'; operation: string; startedMs: number;
  events: { point: string; elapsedMs: number; details: TimingDetails }[];
};
type PublicationDetails = Pick<TimingDetails, 'captureId' | 'question' | 'phase' | 'fallbackText'>;
export class ResponsivenessRecorder {
  private enabled = false;
  private epoch = 0;
  private sequence = 0;
  private origin = 0;
  private records: TimingRecord[] = [];
  private lastPublication: PublicationDetails | null = null;
  private readonly now: () => number;
  constructor(now: () => number = () => performance.now()) { this.now = now; }
  isEnabled() { return this.enabled; }
  setEnabled(value: boolean) { this.enabled = value; this.clear(); }
  clear() { this.epoch++; this.records = []; this.lastPublication = null; this.origin = this.now(); }
  /** Deduplicate observation only; the controller still publishes every update. */
  voiceCheckPublication(details: PublicationDetails) {
    if (!this.enabled) return;
    const next = { captureId: details.captureId, question: details.question,
      phase: details.phase, fallbackText: !!details.fallbackText };
    const previous = this.lastPublication;
    if (previous && previous.captureId === next.captureId && previous.question === next.question
        && previous.phase === next.phase && previous.fallbackText === next.fallbackText) return;
    this.lastPublication = next;
    this.begin('warning', 'VoiceCheck UI publication')('state published', next);
  }
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
export function traceVoiceCheckPublication(details: PublicationDetails) {
  if (typeof __DEV__ !== 'undefined' && __DEV__) responsiveness.voiceCheckPublication(details);
}

// Explicit RAM-only opt-in. Release never requests the native aligned-session bridge.
let alignedSessionEnabled = false;
export function debugSessionAlignmentEnabled() {
  return typeof __DEV__ !== 'undefined' && __DEV__ && alignedSessionEnabled;
}
export function setDebugSessionAlignmentEnabled(enabled: boolean) {
  alignedSessionEnabled = typeof __DEV__ !== 'undefined' && __DEV__ && enabled;
}

/** Metadata only, called after React commits; never observes text or audio. */
export function traceVoiceCheckUI(check: { captureId: string; question: string; phase: string; fallbackText?: string }, source: 'drive' | 'conversation') {
  responsivenessProbe('warning', 'VoiceCheck UI commit')('state committed', {
    captureId: check.captureId, question: check.question, phase: check.phase,
    source, fallbackText: !!check.fallbackText,
  });
}

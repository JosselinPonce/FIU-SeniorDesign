import type { DriverProfile } from '../db/repositories';
import type { Baseline } from '../analysis/baseline';
import { deriveDiagnosticThresholds, diagnosticReference, type DiagnosticThresholds } from './personalizedHardwareThreshold.ts';
import { FLAG_HR_VALID, type Frame } from '../ble/protocol.ts';
import { FlagEngine, CONFIRM_WARNING_S, COVERAGE_MIN, QUALITY_MIN, type ConfirmationObservation, type Episode, type Reading as EngineReading, type Thresholds } from '../analysis/flagEngine.ts';
import { SafetyController, contactPhone, type SafetyState } from '../analysis/safetyController.ts';
import { SENSOR_STALE_MS, SensorContinuity, type ContinuityBreak } from '../analysis/sensorContinuity.ts';
import { openConfirmedDemoPhoneInterface } from '../voice/phoneHandoff.ts';
import { RealContactDemoPermit } from '../voice/realContactDemo.ts';
import { news2Pulse } from '../analysis/profileModel.ts';
import { AGREE_BPM, SKEW_MIN, TEMPLATE_R_MIN, type SignalQuality } from '../analysis/signal.ts';
import type { CheckQuestion, ContactCallDecision, VoiceCaptureMilestones, VoiceDebugEvent, VoiceIO } from '../voice/voiceCheck';

const SESSION_MS = 180_000;
const PERMIT_MS = 30_000;
const RECOVERY_STRICT_FRAMES = 3;
const COOLDOWN_MS = 10_000;
// Session-level signal timeout. FlagEngine owns all confirmation windows.
const COLLECTION_TIMEOUT_MS = 15_000;
const BENCH_QUALIFICATION_TIMEOUT_MS = 30_000;
export const FAST_DEMO_WARNING_SLOTS = 5;

export type HardwareWaveformQuality = 'passed' | 'rejected' | 'warming' | 'unavailable';
type SequenceStatus = 'unchecked' | 'accepted' | 'duplicate' | 'replayed' | 'gap' | 'restart' | 'stale';
type Rejection = 'context' | 'stale' | 'sequence' | 'contact' | 'vitals' | 'firmware' | 'waveform' | 'handoff_quality' | 'bench_quality';
type FrameEvidence = {
  at: number;
  seq: number;
  version: number;
  bpm: number | null;
  spo2: number | null;
  firmwareQuality: number | null;
  waveform: HardwareWaveformQuality;
  sequence: SequenceStatus;
  rejection: Rejection | null;
};
type WaveformFailure = {
  frameSequence: number;
  measuredHr: number | null;
  phoneHr: number | null;
  beats: number;
  templateCorrelation: number | null;
  skewness: number | null;
  perfusion: number | null;
  failedChecks: ('beat_feasibility' | 'beat_template' | 'skewness' | 'estimator_agreement')[];
};
type BenchNullReason = 'unsupported_version' | 'contact' | 'vitals' | 'firmware'
  | 'waveform_not_ready' | 'beat_feasibility' | 'estimator_disagreement' | 'waveform' | 'critical_hr';
type BenchSlot = {
  sequence: number;
  suppliedBpm: number | null;
  acceptedBpm: number | null;
  result: 'null_hr' | 'hampel' | 'below_threshold' | 'at_or_above_threshold';
  reason: BenchNullReason | null;
};
type BenchReset = 'transport_stale' | 'sequence_gap' | 'pending_confirmation_expired';

type BenchEvidence = {
  morphologyOnlyFailures: number;
  invalidFirmwareHr: number;
  beatFeasibilityFailures: number;
  estimatorDisagreements: number;
  otherRejections: number;
  acceptedThroughRelaxation: number;
  confirmationWindow: ConfirmationObservation | null;
  warningSlots: number;
  minimumAccepted: number;
  slotEvidence: BenchSlot[];
  trackId: string | null;
  lastTrackEvent: { event: 'opened' | 'confirmed' | 'recovered' | 'unconfirmed'; at: number; sequence: number } | null;
  lastReset: { reason: BenchReset; at: number } | null;
};
type AttemptEvidence = {
  bench?: BenchEvidence;
  diagnosticQualifiedFrames: number;
  waveformRejectedFrames: number;
  evaluatorInputs: number;
  missingEvaluatorInputs: number;
  hampelRejections: number;
  confirmationWindows: Partial<Record<ConfirmationObservation['kind'], ConfirmationObservation>>;
  lastWaveformFailure: WaveformFailure | null;
  lastContinuityBreak: (ContinuityBreak & {
    voiceCheckActive: boolean;
    episodeId: string | null;
    captureId: string | null;
  }) | null;
};

function waveformFailure(frame: FrameEvidence, quality: SignalQuality): WaveformFailure {
  const failedChecks: WaveformFailure['failedChecks'] = [];
  if (!quality.feasible) failedChecks.push('beat_feasibility');
  if (!((quality.templateR ?? 0) >= TEMPLATE_R_MIN)) failedChecks.push('beat_template');
  if (!((quality.skewness ?? -1) >= SKEW_MIN)) failedChecks.push('skewness');
  if (quality.agree === false) failedChecks.push('estimator_agreement');
  return { frameSequence: frame.seq, measuredHr: frame.bpm, phoneHr: quality.hrBeats, beats: quality.beats,
    templateCorrelation: quality.templateR, skewness: quality.skewness, perfusion: quality.perfusion, failedChecks };
}

type ActivationStage = 'confirmed' | 'starting' | 'active' | 'unavailable' | 'setup_failed' | 'cancelled';
type ActivationRecord = {
  lane: 'strict' | 'bench';
  threshold: number;
  window: ConfirmationObservation | null;
  confirmationMet: boolean;
  episodeId: string | null;
  confirmedAt: number | null;
  confirmationAgeMs: number | null;
  blocker: HardwareSafetySnapshot['triggerBlock'] | 'voicecheck';
  cancellationSource: CancellationSource | null;
  pendingExpiry: { episodeId: string; confirmationAgeMs: number } | null;
  stage: 'collecting' | ActivationStage;
  transitions: Partial<Record<ActivationStage, number>>;
  production: { monitoring: SafetyState['monitoring']; tracking: boolean; preempting: boolean };
};

type AnswerEvent = Extract<VoiceDebugEvent, { kind: 'answer' }>;
type RejectedAnswer = Extract<VoiceDebugEvent, { kind: 'rejected_answer' }>;
type CaptureEvidence = {
  episodeId: string;
  captureId: string;
  question: CheckQuestion;
  openedAt: number;
  uiListeningAt?: number;
  cancelledAt?: number;
  prompt?: { at: number; status: Extract<VoiceDebugEvent, { kind: 'prompt' }>['status'] };
  native?: VoiceCaptureMilestones;
  recognition?: { at: number; status: Extract<VoiceDebugEvent, { kind: 'recognition' }>['status']; final: boolean };
  answer?: { at: number; channel: AnswerEvent['channel']; cancelled: boolean };
};

export type HandoffUnavailable = 'not_enabled' | 'contact_unavailable' | 'signal_lost'
  | 'episode_expired' | 'ownership_lost';
type HandoffMoment = 'response_rejected' | 'decision' | 'revoked' | 'permit' | 'invalidated'
  | 'confirmation_published' | 'confirmation_visible' | 'dialer_tapped' | 'native_result';
type HandoffRecovery = {
  frames: number;
  consecutive: number;
  lastStrictAt: number | null;
  lastRejection: Rejection | 'monitoring_inactive' | 'reading_stale' | null;
  qualifiedAt: number | null;
  requestedAt: number | null;
  permit: { at: number; result: 'created' | 'blocked'; reason?: HandoffUnavailable | 'profile_read_failed'; expiresAt?: number } | null;
  confirmationPublishedAt: number | null;
};
type HandoffEvidence = {
  order: Partial<Record<HandoffMoment, number>>;
  recovery: HandoffRecovery | null;
  episodeId: string | null;
  offerCaptureId: string | null;
  optIn: boolean;
  savedContactAvailable: boolean;
  decision: { at: number; result: ContactCallDecision; channel: AnswerEvent['channel'] } | null;
  rejectedResponse: { at: number; channel: RejectedAnswer['channel']; reason: RejectedAnswer['reason'] } | null;
  firstRevocation: { at: number; reason: CancellationSource | Rejection | 'monitoring_inactive' | 'reading_stale' } | null;
  permit: { at: number; result: 'created' | 'blocked'; expiresAt?: number; reason?: HandoffUnavailable } | null;
  invalidation: { at: number; reason: CancellationSource | Rejection | 'monitoring_inactive' | 'reading_stale' | 'consumed' | 'permit_closed' } | null;
  confirmationPublishedAt: number | null;
  confirmationVisibleAt: number | null;
  dialerTappedAt: number | null;
  nativeResult: { at: number; result: 'requested' | 'native_open_failed' | 'permit_invalid' | 'contact_changed' | 'profile_read_failed' } | null;
};
type Reading = { bpm: number; spo2: number; at: number };
type Contact = { name: string; phone: string };
type Run = {
  driver: DriverProfile;
  contact: Contact | null;
  expires: number;
  lastQualifiedAt: number;
  handoffRevoked: boolean;
  limits: DiagnosticThresholds;
  engine: FlagEngine;
  benchEngine: FlagEngine | null;
  benchEpisode: boolean;
  lastDecodedFrameAt: number;
  observations: AttemptEvidence;
  activation: ActivationRecord;
  handoff: HandoffEvidence;
  handoffSequence: number;
  recoveryPermit: RealContactDemoPermit | null;
  captures: Partial<Record<string, CaptureEvidence>>;
  episode?: Episode;
};
export type HardwareStartBlock = 'platform' | 'foreground' | 'hardware' | 'recording' | 'profile' | 'safety'
  | 'active' | 'cleanup' | 'cooldown' | 'contact' | 'baseline' | 'thresholds';
type CancellationSource = 'explicit' | 'reset' | 'disconnect' | 'context' | 'timeout' | 'lifecycle' | 'other_safety_test'
  | 'transport_restart' | 'transport_silence' | 'qualified_signal' | 'frame_rejected' | 'voicecheck' | 'profile_changed';
type CancellationRecord = {
  episodeId: string | null;
  captureId: string | null;
  source: CancellationSource;
  reason: 'timeout' | 'signal' | CancellationSource;
  at: number;
  frameSequence: number | null;
  frameAgeMs: number | null;
  lastQualifiedAgeMs: number | null;
  waveform: HardwareWaveformQuality | null;
  rejection: Rejection | null;
  continuity: SequenceStatus | null;
  lastContinuousAgeMs: number | null;
  monitoringActive: boolean;
  contextBlock: HardwareStartBlock | null;
};
export type HardwareSafetySnapshot = {
  attemptEvidence: AttemptEvidence | null;
  activation: ActivationRecord | null;
  handoffEvidence: HandoffEvidence | null;
  recoveryReady: boolean;
  captureEvidence: Partial<Record<string, CaptureEvidence>> | null;
  lastCancellation: CancellationRecord | null;
  phase: 'idle' | 'waiting' | 'collecting' | 'recovering' | 'confirmed' | 'checking' | 'confirming' | 'opening' | 'finished' | 'cancelled';
  reading: Reading | null;
  startBlock: HardwareStartBlock | null;
  lastFrame: FrameEvidence | null;
  lastQualifiedAt: number | null;
  triggerBlock: 'monitoring' | 'handoff_quality' | 'qualified_signal' | null;
  contactReady: boolean;
  limits: DiagnosticThresholds | null;
  detection: ReturnType<FlagEngine['inspect']> | null;
  confirmed: Episode | null;
  continuityResets: number;
  voiceCheck: 'idle' | 'starting' | 'active' | 'completed' | 'unavailable' | 'setup_failed';
  cancellation: 'timeout' | 'signal' | null;
  frameSilence: boolean;
  allowsContact: boolean;
  benchMode: boolean;
  fastDemo: boolean;
  confirmation: (Contact & { id: string }) | null;
  result: 'requested' | 'failed' | null;
  safety: SafetyState | null;
};
type Dependencies = {
  contextBlock: () => HardwareStartBlock | null;
  monitoringActive: () => boolean;
  productionState: () => Pick<ActivationRecord['production'], 'monitoring' | 'tracking'>;
  driver: () => DriverProfile | null;
  baseline: (driverId: string) => Baseline | null;
  thresholds: () => Thresholds | null;
  readDriver: (id: string) => Promise<DriverProfile | null>;
  change: (snapshot: HardwareSafetySnapshot) => void;
  voiceIO: () => VoiceIO;
  releaseAudio: () => void;
  openURL: (url: string) => Promise<unknown>;
  id: () => string;
  now?: () => number;
};
const initial = (): HardwareSafetySnapshot => ({
  attemptEvidence: null, activation: null, handoffEvidence: null, recoveryReady: false, captureEvidence: null, lastCancellation: null, phase: 'idle', reading: null, startBlock: 'profile', contactReady: false, detection: null, confirmed: null, continuityResets: 0, limits: null, voiceCheck: 'idle', cancellation: null, frameSilence: false,
  allowsContact: false, benchMode: false, fastDemo: false, confirmation: null, result: null, safety: null, lastFrame: null, lastQualifiedAt: null, triggerBlock: null,
});

function sameProfile(a: DriverProfile, b: DriverProfile | null) {
  return !!b && a.id === b.id && a.updated_at === b.updated_at
    && a.emergency_name === b.emergency_name && a.emergency_phone === b.emergency_phone;
}

export class HardwareSafetyTest {
  private snapshot = initial();
  private run: Run | null = null;
  private engines = new Map<string, FlagEngine>();
  private benchEngines = new Map<string, FlagEngine>();
  private permit: RealContactDemoPermit | null = null;
  private controller: SafetyController | null = null;
  private release: (() => void) | null = null;
  private permitExpires = 0;
  private continuity = new SensorContinuity();
  private lastSequence: number | null = null;
  private cooldownUntil = 0;
  private settling = false;
  private readonly now: () => number;

  private readonly deps: Dependencies;
  constructor(deps: Dependencies) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  private contact(driver = this.deps.driver()): Contact | null {
    const name = driver?.emergency_name?.trim();
    const phone = contactPhone(driver?.emergency_phone).phone;
    return name && phone ? { name, phone } : null;
  }

  private limits() {
    const driver = this.deps.driver();
    return driver ? deriveDiagnosticThresholds(this.deps.baseline(driver.id), this.deps.thresholds()) : null;
  }

  startBlock(allowContact = false): HardwareStartBlock | null {
    const context = this.deps.contextBlock();
    if (context) return context;
    const driver = this.deps.driver();
    if (!driver) return 'profile';
    if (this.run) return 'active';
    if (this.settling) return 'cleanup';
    if (this.now() < this.cooldownUntil) return 'cooldown';
    if (!diagnosticReference(this.deps.baseline(driver.id))) return 'baseline';
    if (!this.limits()) return 'thresholds';
    if (allowContact && !this.contact()) return 'contact';
    return null;
  }

  private productionObservation(): ActivationRecord['production'] {
    return { ...this.deps.productionState(), preempting: this.deps.contextBlock() === 'safety' };
  }

  private recordActivation(run: Run, updates: Partial<ActivationRecord>, stage = run.activation.stage) {
    const at = this.now();
    const record = { ...run.activation, ...updates };
    run.activation = { ...record, stage, production: this.productionObservation(),
      confirmationAgeMs: record.confirmedAt === null ? null : at - record.confirmedAt,
      transitions: stage !== 'collecting' && record.transitions[stage] === undefined
        ? { ...record.transitions, [stage]: at } : record.transitions };
  }

  private set(updates: Partial<HardwareSafetySnapshot>) {
    const run = this.run;
    const stage = updates.voiceCheck;
    if (run && stage !== this.snapshot.voiceCheck
      && (stage === 'starting' || stage === 'active' || stage === 'unavailable' || stage === 'setup_failed')) {
      this.recordActivation(run, stage === 'unavailable' || stage === 'setup_failed' ? { blocker: 'voicecheck' } : {}, stage);
    }
    const next = { ...this.snapshot, ...updates,
      ...(run ? { attemptEvidence: run.observations, activation: run.activation, handoffEvidence: run.handoff, captureEvidence: run.captures,
        recoveryReady: this.recoveryCurrent(run) && run.handoff.recovery?.requestedAt === null
          && (updates.phase ?? this.snapshot.phase) === 'finished' } : {}) };
    next.startBlock = this.startBlock();
    next.contactReady = this.contact() !== null;
    this.snapshot = next;
    this.deps.change(next);
  }

  private isFresh(at: number) {
    const age = this.now() - at;
    return age >= 0 && age < SENSOR_STALE_MS;
  }

  private current(run: Run) {
    return this.run === run && this.now() < run.expires && !this.deps.contextBlock() && sameProfile(run.driver, this.deps.driver());
  }

  private fresh(run: Run) {
    const at = this.snapshot.reading?.at;
    return this.current(run) && this.deps.monitoringActive() && at !== undefined && this.isFresh(at);
  }

  private dialogueActive(run: Run) {
    return this.run === run && this.snapshot.phase === 'checking' && this.snapshot.voiceCheck === 'active';
  }

  private dialogueCurrent(run: Run) {
    if (!this.dialogueActive(run)) {
      const at = this.snapshot.reading?.at;
      return run.benchEpisode
        ? this.current(run) && at !== undefined && this.isFresh(at)
          && this.continuity.lastAt !== null && this.isFresh(this.continuity.lastAt)
        : this.fresh(run);
    }
    // Once speech starts, continuous transport owns dialogue; qualified vitals still own handoff.
    const at = this.continuity.lastAt;
    return this.current(run) && at !== null && this.isFresh(at);
  }

  private markHandoff(run: Run, moment: HandoffMoment) {
    run.handoff = { ...run.handoff, order: { ...run.handoff.order, [moment]: ++run.handoffSequence } };
  }

  private revokeHandoff(run: Run, reason: NonNullable<HandoffEvidence['firstRevocation']>['reason']) {
    const at = this.now();
    if (!run.handoff.firstRevocation) this.markHandoff(run, 'revoked');
    if (this.permit) this.markHandoff(run, 'invalidated');
    run.handoff = { ...run.handoff, firstRevocation: run.handoff.firstRevocation ?? { at, reason },
      invalidation: this.permit ? { at, reason } : run.handoff.invalidation };
    run.handoffRevoked = true;
    this.permit?.revoke();
    this.permit = null;
  }

  private handoffBlock(run: Run): HandoffUnavailable | null {
    if (!run.handoff.optIn) return 'not_enabled';
    if (!run.contact) return 'contact_unavailable';
    if (this.now() >= run.expires) return 'episode_expired';
    if (!this.current(run)) return 'ownership_lost';
    if (!this.handoffCurrent(run)) return 'signal_lost';
    return null;
  }

  private canObserveRecovery(run: Run) {
    return !!run.episode && !!run.contact && run.handoff.decision?.result === 'accepted_offer'
      && run.handoff.permit?.reason === 'signal_lost'
      && this.snapshot.result === null && (this.snapshot.phase === 'finished' || !!run.recoveryPermit);
  }

  private recoveryCurrent(run: Run) {
    const recovery = run.handoff.recovery;
    const transportAt = this.continuity.lastAt;
    return this.canObserveRecovery(run) && this.current(run) && this.deps.monitoringActive()
      && transportAt !== null && this.isFresh(transportAt)
      && !!recovery && recovery.consecutive >= RECOVERY_STRICT_FRAMES
      && recovery.lastStrictAt !== null && this.isFresh(recovery.lastStrictAt);
  }

  private observeRecovery(run: Run, at: number, rejection: HandoffRecovery['lastRejection'], countFrame = true) {
    const previous = run.handoff.recovery;
    const consecutive = rejection ? 0 : (previous?.consecutive ?? 0) + 1;
    run.handoff = { ...run.handoff, recovery: {
      frames: (previous?.frames ?? 0) + Number(countFrame), consecutive, lastStrictAt: rejection ? null : at,
      lastRejection: rejection, qualifiedAt: consecutive >= RECOVERY_STRICT_FRAMES ? previous?.qualifiedAt ?? at : null,
      requestedAt: previous?.requestedAt ?? null, permit: previous?.permit ?? null,
      confirmationPublishedAt: previous?.confirmationPublishedAt ?? null,
    } };
  }

  private blockRecovery(run: Run, reason: NonNullable<HandoffRecovery['permit']>['reason']) {
    const recovery = run.handoff.recovery!;
    run.handoff = { ...run.handoff, recovery: { ...recovery, permit: { at: this.now(), result: 'blocked', reason } } };
    if (this.run === run) this.set({});
  }

  async requestRecoveredHandoff(episodeId: string) {
    const run = this.run;
    const recovery = run?.handoff.recovery;
    const contact = run?.contact;
    if (!run || run.episode?.id !== episodeId || !contact || !recovery || recovery.requestedAt !== null
      || this.settling || this.snapshot.phase !== 'finished' || !this.recoveryCurrent(run)) return;
    run.handoff = { ...run.handoff, recovery: { ...recovery, requestedAt: this.now() } };
    this.set({});
    let saved: DriverProfile | null;
    try { saved = await this.deps.readDriver(run.driver.id); }
    catch {
      if (this.run === run) this.blockRecovery(run, 'profile_read_failed');
      return;
    }
    if (this.run !== run) return;
    if (!sameProfile(run.driver, saved)) {
      this.blockRecovery(run, 'contact_unavailable');
      this.cancel(null, 'profile_changed');
      return;
    }
    if (!this.recoveryCurrent(run) || run.handoff.recovery?.qualifiedAt !== recovery.qualifiedAt) {
      this.blockRecovery(run, this.now() >= run.expires ? 'episode_expired' : !this.current(run) ? 'ownership_lost' : 'signal_lost');
      return;
    }
    const at = this.now();
    const expiresAt = this.permitExpires = Math.min(run.expires, at + PERMIT_MS);
    const permit = new RealContactDemoPermit(() => this.recoveryCurrent(run) && run.episode?.id === episodeId, expiresAt, this.now);
    run.recoveryPermit = permit;
    this.permit = permit;
    this.markHandoff(run, 'confirmation_published');
    run.handoff = { ...run.handoff, confirmationPublishedAt: at, recovery: { ...run.handoff.recovery!,
      permit: { at, result: 'created', expiresAt }, confirmationPublishedAt: at } };
    this.set({ confirmation: { ...contact, id: `${episodeId}-recovered` }, phase: 'confirming' });
  }

  markListeningVisible(episodeId: string, captureId: string) {
    const run = this.run;
    const check = this.snapshot.safety?.check;
    const capture = run?.captures[captureId];
    if (!run || check?.episode.id !== episodeId || check.captureId !== captureId
      || check.phase !== 'listening' || !capture || capture.uiListeningAt !== undefined) return;
    run.captures = { ...run.captures, [captureId]: { ...capture, uiListeningAt: this.now() } };
    this.set({});
  }

  private observeVoice(run: Run, episode: Episode, event: VoiceDebugEvent) {
    if (this.run !== run) return;
    const at = this.now();
    const { captureId, question } = event;
    const capture = run.captures[captureId];
    if (event.kind === 'opened') {
      const opened = { captureId, question, openedAt: at, episodeId: episode.id };
      run.captures = Object.fromEntries([...Object.entries(run.captures), [captureId, opened]].slice(-4));
      if (question === 'contact_offer') run.handoff = { ...run.handoff, offerCaptureId: captureId };
    } else if (event.kind === 'rejected_answer') {
      if (question !== 'contact_offer') return;
      this.markHandoff(run, 'response_rejected');
      run.handoff = { ...run.handoff, rejectedResponse: { at, channel: event.channel, reason: event.reason } };
    } else if (capture?.captureId === captureId) {
      if (event.kind === 'prompt') {
        run.captures = { ...run.captures, [captureId]: { ...capture, prompt: { at, status: event.status } } };
      } else if (event.kind === 'recognition') {
        run.captures = { ...run.captures, [captureId]: { ...capture, recognition: { at, status: event.status, final: event.final } } };
      } else if (event.kind === 'answer') {
        run.captures = { ...run.captures, [captureId]: { ...capture, answer: { at, channel: event.channel, cancelled: event.cancelled } } };
      } else if (event.kind === 'offer') {
        this.markHandoff(run, 'decision');
        run.handoff = { ...run.handoff, decision: { at, result: event.decision, channel: capture.answer?.channel ?? 'none' } };
      }
    }
    this.set({});
  }

  private handoffCurrent(run: Run) {
    return !run.handoffRevoked && this.fresh(run);
  }

  start(allowContact = false, benchMode = false, fastDemo = false) {
    const driver = this.deps.driver();
    const limits = this.limits();
    if (!driver || !limits || this.startBlock(allowContact)) { this.tick(); return false; }
    const now = this.now();
    const existing = this.engines.get(driver.id);
    const engine = existing ?? new FlagEngine(limits.test, () => `hardware-${this.deps.id()}`);
    if (existing) {
      engine.resetContinuity();
      engine.setThresholds(limits.test);
    } else this.engines.set(driver.id, engine);
    const warningSlots = benchMode && fastDemo ? FAST_DEMO_WARNING_SLOTS : CONFIRM_WARNING_S;
    let benchEngine = null;
    if (benchMode) {
      benchEngine = this.benchEngines.get(driver.id) ?? new FlagEngine(limits.test,
        () => `hardware-${this.deps.id()}`, { highWarningOnly: true });
      benchEngine.resetContinuity();
      benchEngine.setWarningConfirmationWindow(warningSlots);
      benchEngine.setThresholds(limits.test);
      this.benchEngines.set(driver.id, benchEngine);
    }
    this.run = { driver: { ...driver }, contact: allowContact ? this.contact(driver) : null,
      expires: now + SESSION_MS, lastQualifiedAt: now, handoffRevoked: false, limits, engine, benchEngine, benchEpisode: false, lastDecodedFrameAt: now,
      handoffSequence: 0, recoveryPermit: null, handoff: { order: {}, recovery: null, episodeId: null, offerCaptureId: null, optIn: allowContact, savedContactAvailable: !!this.contact(driver),
        decision: null, rejectedResponse: null, firstRevocation: null, permit: null, invalidation: null,
        confirmationPublishedAt: null, confirmationVisibleAt: null, dialerTappedAt: null, nativeResult: null },
      captures: {},
      activation: { lane: benchMode ? 'bench' : 'strict', threshold: limits.high, window: null,
        confirmationMet: false, episodeId: null, confirmedAt: null, confirmationAgeMs: null,
        blocker: null, cancellationSource: null, pendingExpiry: null, stage: 'collecting', transitions: {}, production: this.productionObservation() },
      observations: { ...(benchMode ? { bench: { morphologyOnlyFailures: 0, invalidFirmwareHr: 0,
        beatFeasibilityFailures: 0, estimatorDisagreements: 0, otherRejections: 0, acceptedThroughRelaxation: 0,
        confirmationWindow: null, warningSlots, minimumAccepted: Math.ceil(warningSlots * COVERAGE_MIN),
        slotEvidence: [], trackId: null, lastTrackEvent: null, lastReset: null } } : {}), diagnosticQualifiedFrames: 0, waveformRejectedFrames: 0, evaluatorInputs: 0,
        missingEvaluatorInputs: 0, hampelRejections: 0, confirmationWindows: {}, lastWaveformFailure: null, lastContinuityBreak: null } };
    this.set({ ...initial(), ...this.evidence(), limits, detection: engine.inspect(), phase: 'waiting', benchMode, fastDemo: benchMode && fastDemo, allowsContact: !!this.run.contact });
    return true;
  }

  cancel(reason: HardwareSafetySnapshot['cancellation'] = null, source: CancellationSource = 'explicit') {
    const run = this.run;
    if (!run) return;
    const at = this.now();
    const age = (time: number | null) => time === null ? null : at - time;
    const frame = this.snapshot.lastFrame;
    const lastCancellation: CancellationRecord = {
      episodeId: run.episode?.id ?? this.snapshot.confirmed?.id ?? null,
      captureId: this.snapshot.safety?.check?.captureId || null,
      source, reason: reason ?? source, at,
      frameSequence: frame?.seq ?? null,
      frameAgeMs: age(frame?.at ?? null),
      lastQualifiedAgeMs: age(this.snapshot.lastQualifiedAt),
      waveform: frame?.waveform ?? null,
      rejection: frame?.rejection ?? null,
      continuity: source === 'transport_restart' ? 'restart' : frame?.sequence ?? null,
      lastContinuousAgeMs: age(this.continuity.lastAt),
      monitoringActive: this.deps.monitoringActive(),
      contextBlock: this.deps.contextBlock(),
    };
    this.recordActivation(run, { cancellationSource: source }, 'cancelled');
    const captureId = this.snapshot.safety?.check?.captureId;
    const capture = captureId ? run.captures[captureId] : undefined;
    if (captureId && capture) run.captures = { ...run.captures, [captureId]: { ...capture, cancelledAt: at } };
    if (run.episode) this.cooldownUntil = at + COOLDOWN_MS;
    run.engine.resetContinuity();
    run.benchEngine?.resetContinuity();
    this.run = null;
    this.revokeHandoff(run, source);
    if (run.handoff.decision?.result === 'accepted_offer' && !run.handoff.permit) {
      this.markHandoff(run, 'permit');
      run.handoff = { ...run.handoff, permit: { at, result: 'blocked',
        reason: this.handoffBlock(run) ?? 'ownership_lost' } };
    }
    try { this.controller?.cancelCheck(); }
    catch { /* An optional diagnostic must never interrupt production evaluation. */ }
    this.release?.();
    this.controller = null;
    this.set({ ...initial(), ...this.evidence(), phase: 'cancelled', cancellation: reason, lastCancellation, attemptEvidence: run.observations, activation: run.activation, handoffEvidence: run.handoff, captureEvidence: run.captures });
  }

  private evidence() {
    const { lastFrame, lastQualifiedAt, reading, lastCancellation } = this.snapshot;
    return { lastFrame, lastQualifiedAt, reading, lastCancellation };
  }

  reset() {
    this.cancel(null, 'reset');
    this.set({ ...initial(), ...this.evidence() });
    this.tick();
  }

  private recordContinuityBreak(run: Run, evidence: ContinuityBreak) {
    run.observations = { ...run.observations, lastContinuityBreak: {
      ...evidence, voiceCheckActive: this.dialogueActive(run),
      episodeId: run.episode?.id ?? this.snapshot.confirmed?.id ?? null,
      captureId: this.snapshot.safety?.check?.captureId || null,
    } };
  }

  recordTransportRestart(frame: Frame, at: number, missing: number) {
    if (this.run) this.recordContinuityBreak(this.run, this.continuity.describeBreak(frame, at, missing, ['transport_restart']));
  }

  disconnect(source: 'disconnect' | 'context' | 'transport_restart' = 'disconnect') {
    this.cancel(null, source);
    this.continuity.reset();
    this.lastSequence = null;
    if (this.snapshot.reading) this.set({ reading: null });
  }

  tick() {
    const context = this.deps.contextBlock();
    if (context === 'hardware' || context === 'foreground') this.disconnect(context === 'hardware' ? 'disconnect' : 'context');
    const run = this.run;
    if (run) {
      if (this.now() >= run.expires || ((this.snapshot.confirmation || this.snapshot.phase === 'opening') && this.now() >= this.permitExpires)) {
        this.cancel('timeout', 'timeout');
      } else if (!this.current(run)) {
        this.cancel(null, context ? 'context' : 'profile_changed');
      } else if (this.canObserveRecovery(run) && (this.continuity.lastAt === null || !this.isFresh(this.continuity.lastAt))) {
        this.cancel('signal', 'transport_silence');
      } else if (this.dialogueActive(run)) {
        const at = this.continuity.lastAt;
        if (at === null || !this.isFresh(at)) this.cancel('signal', 'transport_silence');
        else if (!this.fresh(run)) this.revokeHandoff(run, this.deps.monitoringActive() ? 'reading_stale' : 'monitoring_inactive');
      } else if (run.benchEpisode && this.snapshot.phase === 'checking' && this.snapshot.voiceCheck === 'starting') {
        if (!this.dialogueCurrent(run)) this.cancel('signal', 'qualified_signal');
      } else if (run.benchEngine && !run.episode && this.snapshot.phase !== 'finished'
        && this.now() - run.lastDecodedFrameAt >= COLLECTION_TIMEOUT_MS) {
        this.cancel('signal', 'transport_silence');
      } else if (this.snapshot.phase !== 'finished' && ((run.episode && !this.deps.monitoringActive())
        || this.now() - run.lastQualifiedAt >= (run.episode ? SENSOR_STALE_MS : run.benchEngine ? BENCH_QUALIFICATION_TIMEOUT_MS : COLLECTION_TIMEOUT_MS))) {
        this.cancel('signal', 'qualified_signal');
      }
    }

    const pendingRecovery = this.run;
    if (pendingRecovery && this.canObserveRecovery(pendingRecovery) && !this.deps.monitoringActive()
      && pendingRecovery.handoff.recovery?.consecutive) {
      this.observeRecovery(pendingRecovery, this.now(), 'monitoring_inactive', false);
      this.set({});
    }
    const reading = this.snapshot.reading;
    const expired = !!reading && !this.isFresh(reading.at);
    const active = this.run;
    const lastArrival = Math.max(this.snapshot.lastFrame?.at ?? 0, active?.lastQualifiedAt ?? 0);
    const frameSilence = !!active && this.now() - lastArrival >= SENSOR_STALE_MS;
    if (this.snapshot.frameSilence !== frameSilence) this.set({ frameSilence });
    const lastAt = this.continuity.lastAt;
    if (active && !active.episode && lastAt !== null && this.now() - lastAt >= SENSOR_STALE_MS) {
      this.continuity.reset();
      this.resetEngineEvidence(active, 'transport_stale');
    } else if (expired) {
      this.set({ reading: null });
    }
    if (this.snapshot.startBlock !== this.startBlock() || this.snapshot.contactReady !== (this.contact() !== null)) this.set({});
  }

  private resetEngineEvidence(run: Run, reason: BenchReset) {
    const bench = run.observations.bench;
    if (bench) run.observations = { ...run.observations, bench: { ...bench, lastReset: { reason, at: this.now() } } };
    run.engine.resetContinuity();
    run.benchEngine?.resetContinuity();
    this.set({ detection: run.engine.inspect(), confirmed: null, triggerBlock: null,
      continuityResets: this.snapshot.continuityResets + 1, phase: 'recovering', reading: null });
  }

  /** Only the decoded BLE callback may feed this path. Do not pass simulator readings. */
  frame(frame: Frame, at: number, missing: number, waveform: HardwareWaveformQuality, input: EngineReading | null, restarted = false, signalQuality?: SignalQuality | null, calibratedBpm = frame.heartRate) {
    this.tick();
    const run = this.run;
    const evidence: FrameEvidence = {
      at, seq: frame.seq, version: frame.version,
      bpm: Number.isFinite(frame.heartRate) && frame.heartRate !== -999 ? frame.heartRate : null,
      spo2: Number.isFinite(frame.spo2) && frame.spo2 !== -999 ? frame.spo2 : null,
      firmwareQuality: frame.version >= 3 ? frame.quality : null,
      waveform, sequence: 'accepted', rejection: null,
    };
    const reject = (rejection: Rejection, sequence: SequenceStatus = 'accepted', invalidate = true) => {
      const lastFrame = { ...evidence, rejection, sequence };
      if (run?.observations.bench && !run.episode) {
        const bench = run.observations.bench;
        run.observations = { ...run.observations, bench: { ...bench, otherRejections: bench.otherRejections + 1 } };
      }
      if (!invalidate) { this.set({ lastFrame, frameSilence: false }); return; }
      const recoveryObserved = run && this.canObserveRecovery(run);
      if (run && recoveryObserved) this.observeRecovery(run, at, rejection);
      this.set({ lastFrame, frameSilence: false, reading: null,
        ...(run && !run.episode && this.snapshot.phase !== 'waiting' ? { phase: 'recovering' as const, triggerBlock: null } : {}) });
      if (run?.episode) {
        if (recoveryObserved && rejection === 'sequence') { this.cancel('signal', 'frame_rejected'); return; }
        this.revokeHandoff(run, rejection);
        const temporaryQualityLoss = rejection === 'contact' || rejection === 'waveform' || rejection === 'handoff_quality'
          || (rejection === 'vitals' && (waveform === 'rejected' || waveform === 'warming'));
        if (this.snapshot.phase !== 'finished' && (!temporaryQualityLoss || !this.dialogueActive(run))) {
          this.cancel('signal', 'frame_rejected');
        }
      }
    };

    if (restarted) {
      this.recordTransportRestart(frame, at, missing);
      reject('sequence', 'restart');
      return;
    }
    if (this.deps.contextBlock()) { reject('context', 'unchecked', false); return; }
    // Stale, duplicate and backwards data cannot become the continuity anchor.
    if (!this.isFresh(at)) { reject('stale', 'stale'); return; }
    if (this.lastSequence !== null) {
      const delta = (frame.seq - this.lastSequence) >>> 0;
      if (delta === 0) { reject('sequence', 'duplicate', false); return; }
      if (delta >= 0x8000_0000) { reject('sequence', 'replayed', false); return; }
    }
    this.lastSequence = frame.seq;
    if (run) run.lastDecodedFrameAt = at;
    const continuity = this.continuity.accept(frame, at, missing, run ? evidence => this.recordContinuityBreak(run, evidence) : undefined);
    if (!continuity.accepted || missing > 0) {
      if (run && !run.episode) this.resetEngineEvidence(run, 'sequence_gap');
      reject('sequence', 'gap');
      return;
    }
    const handoffQuality = frame.version >= 3 && waveform === 'passed';
    // The diagnostic view/authorization can be stricter than production. The
    // detector gets the exact production input, including rejected quality
    // and null vitals, so those seconds still affect FlagEngine coverage.
    const rejection: Rejection | null = !frame.finger ? 'contact'
      : !frame.usable || !Number.isFinite(frame.heartRate) || frame.heartRate < 30 || frame.heartRate > 220
        || !Number.isFinite(frame.spo2) || frame.spo2 < 70 || frame.spo2 > 100 ? 'vitals'
      : frame.version >= 3 && !(frame.quality >= QUALITY_MIN) ? 'firmware'
      : waveform === 'rejected' ? 'waveform'
      : run?.episode && run.contact && !handoffQuality ? 'handoff_quality' : null;

    const strictReading = !rejection ? { bpm: input?.bpm ?? frame.heartRate, spo2: input?.spo2 ?? frame.spo2, at } : null;
    if (run && this.canObserveRecovery(run) && !rejection) {
      this.observeRecovery(run, at, !handoffQuality ? 'handoff_quality'
        : !this.deps.monitoringActive() ? 'monitoring_inactive' : null);
    }
    const bench = run && !run.episode ? run.observations.bench : undefined;
    let benchReading: Reading | null = null;
    let benchNullReason: BenchNullReason | null = null;
    if (run && bench) {
      const invalidHr = !(frame.flags & FLAG_HR_VALID) || !Number.isFinite(frame.heartRate) || frame.heartRate < 30 || frame.heartRate > 220;
      const validVitals = !invalidHr && frame.usable && Number.isFinite(frame.spo2) && frame.spo2 >= 70 && frame.spo2 <= 100
        && Number.isFinite(calibratedBpm) && calibratedBpm >= 30 && calibratedBpm <= 220;
      const phoneHr = signalQuality?.hrBeats;
      const feasible = signalQuality?.feasible === true && phoneHr != null && Number.isFinite(phoneHr);
      const agreement = feasible && signalQuality?.agree === true && Math.abs(phoneHr - frame.heartRate) <= AGREE_BPM;
      const strictOnlyHr = calibratedBpm > 90 && (calibratedBpm >= run.limits.test.highCrit || news2Pulse(calibratedBpm) === 3);
      const morphologyFailure = !!signalQuality
        && (!((signalQuality.templateR ?? 0) >= TEMPLATE_R_MIN) || !((signalQuality.skewness ?? -1) >= SKEW_MIN));
      const qualityAvailable = waveform === 'passed' || waveform === 'rejected';
      benchNullReason = frame.version !== 3 ? 'unsupported_version' : !frame.finger ? 'contact'
        : !validVitals ? 'vitals' : !(frame.quality >= QUALITY_MIN) ? 'firmware'
        : !qualityAvailable ? 'waveform_not_ready' : !feasible ? 'beat_feasibility'
        : !agreement ? 'estimator_disagreement' : waveform === 'rejected' && !morphologyFailure ? 'waveform' : null;
      const qualified = benchNullReason === null;
      const morphologyOnly = qualified && waveform === 'rejected';
      if (qualified && !strictOnlyHr) benchReading = { bpm: calibratedBpm, spo2: frame.spo2, at };
      if (qualified && strictOnlyHr) benchNullReason = 'critical_hr';
      const other = frame.version !== 3 || !frame.finger || (!validVitals && !invalidHr)
        || !(frame.quality >= QUALITY_MIN) || !qualityAvailable || strictOnlyHr;
      run.observations = { ...run.observations, bench: { ...bench,
        morphologyOnlyFailures: bench.morphologyOnlyFailures + Number(morphologyOnly),
        invalidFirmwareHr: bench.invalidFirmwareHr + Number(invalidHr),
        beatFeasibilityFailures: bench.beatFeasibilityFailures + Number(qualityAvailable && !feasible),
        estimatorDisagreements: bench.estimatorDisagreements + Number(!invalidHr && (signalQuality?.agree === false || (feasible && !agreement))),
        otherRejections: bench.otherRejections + Number(other),
        acceptedThroughRelaxation: bench.acceptedThroughRelaxation + Number(morphologyOnly && !!benchReading),
      } };
    }
    const reading = bench ? benchReading : strictReading;
    if (run && this.snapshot.phase !== 'finished') {
      const observations = run.observations;
      run.observations = { ...observations,
        diagnosticQualifiedFrames: observations.diagnosticQualifiedFrames + Number(reading !== null),
        waveformRejectedFrames: observations.waveformRejectedFrames + Number(waveform === 'rejected'),
        lastWaveformFailure: waveform === 'rejected' && signalQuality
          ? waveformFailure(evidence, signalQuality) : observations.lastWaveformFailure,
      };
    }
    if (run && reading) run.lastQualifiedAt = at;
    if (run?.episode && rejection) { reject(rejection); return; }
    this.set({ reading, lastFrame: { ...evidence, rejection: reading ? null : rejection ?? 'bench_quality' }, frameSilence: false,
      ...(reading ? { lastQualifiedAt: at } : {}) });
    if (!run || run.episode) return;

    const pending = [run.engine.pending, run.benchEngine?.pending];
    // A confirmed event can wait briefly for the existing VoiceCheck gates.
    // If it expires there must be a new engine confirmation.
    const expired = pending.find(episode => episode?.confirmedAt != null && !this.isFresh(episode.confirmedAt));
    if (expired?.confirmedAt != null) {
      this.recordActivation(run, { pendingExpiry: { episodeId: expired.id, confirmationAgeMs: this.now() - expired.confirmedAt } });
      this.resetEngineEvidence(run, 'pending_confirmation_expired');
    }
    const rejectedBefore = run.engine.rejected;
    const confirmationWindows = { ...run.observations.confirmationWindows };
    // Bench HR evidence is isolated from the engine that tracks strict critical and oxygen events.
    const strictInput = bench && input && !strictReading ? { ...input, bpm: null, spo2: null } : input;
    const event = strictInput ? run.engine.feed(strictInput, observation => {
      confirmationWindows[observation.kind] = observation;
    }, bench ? 'exclude_high_warning' : undefined).find(event => event.type === 'emergency') : undefined;
    run.observations = { ...run.observations, confirmationWindows,
      evaluatorInputs: run.observations.evaluatorInputs + Number(input !== null),
      missingEvaluatorInputs: run.observations.missingEvaluatorInputs + Number(input === null),
      hampelRejections: run.observations.hampelRejections + run.engine.rejected - rejectedBefore,
    };
    const benchEvents = run.benchEngine?.feed({ t: at, bpm: benchReading?.bpm ?? null, spo2: null,
      finger: frame.finger, quality: frame.quality, good: benchReading !== null }, (observation, detail) => {
      const current = run.observations.bench!;
      const suppliedBpm = benchReading?.bpm ?? null;
      const acceptedBpm = detail.slot?.acceptedValue ?? null;
      const slot: BenchSlot = { sequence: frame.seq, suppliedBpm, acceptedBpm, reason: benchNullReason,
        result: suppliedBpm === null ? 'null_hr' : acceptedBpm === null ? 'hampel'
          : acceptedBpm >= observation.threshold ? 'at_or_above_threshold' : 'below_threshold' };
      run.observations = { ...run.observations, bench: { ...current, confirmationWindow: observation,
        trackId: detail.episodeId, slotEvidence: detail.slot
          ? [...current.slotEvidence, slot].slice(-observation.required) : [],
        lastTrackEvent: detail.slot ? current.lastTrackEvent : { event: 'opened', at, sequence: frame.seq } } };
    });
    const ended = benchEvents?.find(event => event.type === 'emergency' || event.type === 'cleared');
    if (ended && run.observations.bench) {
      const event = ended.type === 'emergency' ? 'confirmed' : ended.episode.outcome === 'recovered' ? 'recovered' : 'unconfirmed';
      run.observations = { ...run.observations, bench: { ...run.observations.bench,
        lastTrackEvent: { event, at, sequence: frame.seq } } };
    }
    const strictEpisode = event?.episode ?? run.engine.pending;
    const benchEpisode = run.benchEngine?.pending;
    const useBench = !!benchEpisode && !strictEpisode;
    const episode = useBench ? benchEpisode : strictEpisode;
    const strictDetection = run.engine.inspect();
    const hasStrictTrack = strictDetection.tracks.some(({ episode }) => episode.kind !== 'bpm_high' || episode.level !== 'warning');
    const detection = run.benchEngine && (useBench || !strictEpisode && !hasStrictTrack)
      ? run.benchEngine.inspect() : strictDetection;
    if (!episode) {
      const track = detection.tracks[0];
      const benchLane = run.benchEngine !== null && !hasStrictTrack;
      const window = benchLane ? run.observations.bench?.confirmationWindow ?? null
        : track ? confirmationWindows[track.episode.kind] ?? null : run.activation.window;
      this.recordActivation(run, { lane: benchLane ? 'bench' : 'strict', window,
        threshold: window?.threshold ?? run.limits.high, confirmationMet: false, episodeId: null,
        confirmedAt: null, blocker: null, transitions: {} }, 'collecting');
      this.set({ detection, confirmed: null, phase: reading ? 'collecting' : 'recovering', triggerBlock: null });
      return;
    }
    const triggerBlock = !useBench && !this.deps.monitoringActive() ? 'monitoring'
      : (useBench ? !benchReading : !strictReading || !input) ? 'qualified_signal' : run.contact && !handoffQuality ? 'handoff_quality' : null;
    const window = useBench ? run.observations.bench?.confirmationWindow : confirmationWindows[episode.kind];
    this.recordActivation(run, { lane: useBench ? 'bench' : 'strict', threshold: episode.threshold,
      window: window ?? null, confirmationMet: true, episodeId: episode.id,
      confirmedAt: episode.confirmedAt, blocker: triggerBlock,
      transitions: run.activation.episodeId === episode.id ? run.activation.transitions : {} }, 'confirmed');
    this.set({ detection, confirmed: { ...episode }, phase: 'confirmed', triggerBlock });
    if (triggerBlock) return;
    run.episode = episode;
    run.handoff = { ...run.handoff, episodeId: episode.id };
    run.benchEpisode = useBench;
    this.set({ phase: 'checking', voiceCheck: 'starting', reading: useBench ? benchReading : strictReading });
    void this.check(run, episode);
  }

  private async check(run: Run, episode: Episode) {
    if (this.run !== run) return;
    this.settling = true;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      try { this.deps.releaseAudio(); }
      catch { /* Optional diagnostic audio cleanup must not interrupt monitoring. */ }
    };
    try {
      const io = this.deps.voiceIO();
      if (this.run !== run) return;
      this.release = release;
      const controller = new SafetyController({
        interactionCurrent: () => this.dialogueCurrent(run),
        assistantMode: () => 'gemma', // Dialogue presentation only. No model dependencies are supplied.
        voiceIO: () => ({ ...io,
          observeDebug: event => this.observeVoice(run, episode, event),
          observeNativeDebug: captureId => milestones => {
            const capture = run.captures[captureId];
            if (this.run !== run || capture?.captureId !== captureId) return;
            run.captures = { ...run.captures, [captureId]: { ...capture, native: milestones } };
            this.set({});
          },
        }),
        releaseAudio: release,
        save: async () => {}, saveAck: async () => {}, haptic: () => {},
        onChange: state => {
          if (this.run !== run) return;
          this.set({ safety: state, ...(state.check?.episode.id === episode.id ? { voiceCheck: 'active' as const } : {}) });
        },
        newId: this.deps.id,
      });
      this.controller = controller;
      controller.configure(run.driver, null);
      const result = await controller.runIsolatedCheck(episode, () => {
        this.markHandoff(run, 'permit');
        const reason = this.handoffBlock(run);
        if (reason || !run.contact) {
          run.handoff = { ...run.handoff, permit: { at: this.now(), result: 'blocked', reason: reason ?? 'contact_unavailable' } };
          return;
        }
        const expires = this.permitExpires = Math.min(run.expires, this.now() + PERMIT_MS);
        this.permit = new RealContactDemoPermit(() => this.handoffCurrent(run) && run.episode === episode, expires, this.now);
        const at = this.now();
        this.markHandoff(run, 'confirmation_published');
        run.handoff = { ...run.handoff, permit: { at, result: 'created', expiresAt: expires }, confirmationPublishedAt: at };
        this.set({ confirmation: { ...run.contact, id: episode.id }, phase: 'confirming' });
      });
      if (this.run === run) {
        if (run.handoff.decision?.result === 'accepted_offer' && !run.handoff.permit) {
          this.markHandoff(run, 'permit');
          run.handoff = { ...run.handoff, permit: { at: this.now(), result: 'blocked',
            reason: this.handoffBlock(run) ?? 'ownership_lost' } };
        }
        const active = this.snapshot.voiceCheck === 'active';
        const engine = run.benchEpisode ? run.benchEngine! : run.engine;
        if (result && active) engine.resolve(result.outcome, this.now(), episode.id);
        this.set({ detection: engine.inspect(), voiceCheck: active ? 'completed' : 'unavailable', ...(!this.snapshot.confirmation ? { phase: 'finished' as const } : {}) });
      }
    } catch {
      if (this.run === run) {
        if (this.snapshot.voiceCheck === 'active') this.cancel(null, 'voicecheck');
        else this.set({ phase: 'finished', voiceCheck: 'setup_failed' });
      }
    } finally {
      this.settling = false;
      this.release = null;
      release();
      this.tick();
    }
  }

  owns(episodeId: string | undefined) {
    return !!episodeId && this.run?.episode?.id === episodeId;
  }

  private recordClosedOffer(scope: { episodeId: string; question: CheckQuestion; captureId: string } | undefined,
    channel: RejectedAnswer['channel']) {
    const run = this.run;
    if (!run?.episode || scope?.question !== 'contact_offer' || this.snapshot.safety?.check) return;
    this.observeVoice(run, run.episode, { kind: 'rejected_answer', channel, question: scope.question, captureId: scope.captureId,
      reason: scope.episodeId === run.episode.id && scope.captureId === run.handoff.offerCaptureId
        ? 'already_answered' : 'stale' });
  }

  answer(...args: Parameters<SafetyController['answer']>) {
    this.recordClosedOffer(args[1], 'button');
    if (!args[1] || args[1].episodeId !== this.run?.episode?.id) return false;
    return this.controller?.answer(...args) ?? false;
  }

  answerText(...args: Parameters<SafetyController['answerText']>) {
    this.recordClosedOffer(args[1], 'typed');
    if (args[1].episodeId !== this.run?.episode?.id) return false;
    return this.controller?.answerText(...args) ?? false;
  }

  private recordNativeResult(run: Run, result: NonNullable<HandoffEvidence['nativeResult']>['result']) {
    this.markHandoff(run, 'native_result');
    run.handoff = { ...run.handoff, nativeResult: { at: this.now(), result } };
    if (this.run === run || (this.run === null && this.snapshot.handoffEvidence?.episodeId === run.handoff.episodeId)) {
      this.set({ handoffEvidence: run.handoff });
    }
  }

  markConfirmationVisible(id: string) {
    const run = this.run;
    if (!run || this.snapshot.confirmation?.id !== id || run.handoff.confirmationVisibleAt !== null) return;
    this.markHandoff(run, 'confirmation_visible');
    run.handoff = { ...run.handoff, confirmationVisibleAt: this.now() };
    this.set({});
  }

  async confirm(id: string) {
    const run = this.run;
    const permit = this.permit;
    const contact = this.snapshot.confirmation;
    if (!run || !permit || this.settling || contact?.id !== id) return;
    this.markHandoff(run, 'dialer_tapped');
    run.handoff = { ...run.handoff, dialerTappedAt: this.now() };
    const authorized = () => run.recoveryPermit === permit ? this.recoveryCurrent(run) : this.handoffCurrent(run);
    this.tick();
    if (!authorized()) return;
    let nativeRequested = false;
    let profileRead = false;
    let permitClaimed = false;
    this.set({ confirmation: null, phase: 'opening' });
    try {
      const saved = await this.deps.readDriver(run.driver.id);
      profileRead = true;
      if (!sameProfile(run.driver, saved)) {
        if (this.run === run) {
          this.recordNativeResult(run, 'contact_changed');
          this.cancel(null, 'profile_changed');
        }
        return;
      }
      await openConfirmedDemoPhoneInterface(contact.phone, () => {
        permitClaimed = permit.claim();
        return permitClaimed;
      }, authorized, url => {
        nativeRequested = true;
        return this.deps.openURL(url);
      });
      this.recordNativeResult(run, 'requested');
      if (this.run === run) this.set({ phase: 'finished', result: 'requested' });
    } catch {
      this.recordNativeResult(run, nativeRequested ? 'native_open_failed' : profileRead ? 'permit_invalid' : 'profile_read_failed');
      if (this.run === run) this.set({ phase: 'finished', result: 'failed' });
    } finally {
      permit.revoke();
      if (this.permit === permit) {
        this.permit = null;
        this.markHandoff(run, 'invalidated');
        run.handoff = { ...run.handoff, invalidation: { at: this.now(), reason: permitClaimed ? 'consumed' : 'permit_closed' } };
        if (this.run === run) this.set({});
      }
    }
  }
}

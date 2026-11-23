import { FlagEngine, QUALITY_MIN, thresholds, type ConfirmationObservation, type Thresholds, type Episode } from '../analysis/flagEngine.ts';
import { SafetyController, contactPhone, type SafetyState } from '../analysis/safetyController.ts';
import { SENSOR_STALE_MS, SensorContinuity } from '../analysis/sensorContinuity.ts';
import { AGREE_BPM, type SignalQuality } from '../analysis/signal.ts';
import type { Frame } from '../ble/protocol.ts';
import { FAST_DEMO_WARNING_SLOTS } from './hardwareSafetyTest.ts';
import type { DemoThresholdSource, DriveDemoEventInput, DriveDemoEventRow, DriverProfile } from '../db/repositories.ts';
import { openConfirmedDemoPhoneInterface } from '../voice/phoneHandoff.ts';
import { RealContactDemoPermit } from '../voice/realContactDemo.ts';
import { responsivenessProbe } from '../voice/responsivenessDiagnostics.ts';
import type { VoiceIO } from '../voice/voiceCheck.ts';

const EPISODE_MS = 180_000;
const PERMIT_MS = 30_000;
const AUTO_HR_MARGIN = 3;
const AUTO_SPO2_MARGIN = 2;
const HR_MIN = 30;
const HR_MAX = 220;
const SPO2_MIN = 70;
const SPO2_MAX = 100;
type Scenario = 'high_hr' | 'low_spo2';
type OffsetMode = 'automatic' | 'manual';
type Simulation = { enabled: boolean; scenario: Scenario; mode: OffsetMode; hrIncrease: number; spo2Reduction: number };
type Measurements = { at: number; hr: number | null; spo2: number | null; finger: boolean };
type Projection = { value: number; offset: number };
const defaultSimulation = (): Simulation => ({
  enabled: false, scenario: 'high_hr', mode: 'automatic', hrIncrease: 40, spo2Reduction: 8,
});
const within = (value: number, min: number, max: number) => Number.isFinite(value) && value >= min && value <= max;
const uint32 = (value: number) => Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;
type WarningReference = { value: number; source: DemoThresholdSource; acknowledgmentAdjusted: boolean };
type Evidence = { observation: ConfirmationObservation; episodeId: string; reading: Projection & { actual: number; at: number } };
type Contact = { name: string; phone: string };

export function demoThresholdProvenance(scenario: Scenario, state: SafetyState, learnedOxygen: boolean): Omit<WarningReference, 'value'> {
  if (scenario === 'low_spo2') return {
    source: state.prior?.spo2Baseline == null ? 'standard' : learnedOxygen ? 'baseline_informed' : 'profile_estimate',
    acknowledgmentAdjusted: false,
  };
  const { prior, band, th } = state;
  return {
    source: band && band.weight > 0 ? 'baseline_informed' : 'profile_estimate',
    acknowledgmentAdjusted: !!(prior && band && th && th.highWarn > thresholds(prior, band).highWarn),
  };
}

export type HomeHardwareDemoSnapshot = {
  enabled: boolean;
  simulation: Simulation;
  actual: Measurements | null;
  projected: Projection | null;
  warningReference: WarningReference | null;
  confirmationWindow: ConfirmationObservation | null;
  liveEpisode: boolean;
  testContact: Contact | null;
  safety: SafetyState | null;
  confirmation: (Contact & { id: string }) | null;
  phase: 'idle' | 'checking' | 'review' | 'opening' | 'finished';
  result: 'requested' | 'failed' | 'expired' | null;
};

type Dependencies = {
  currentContext(): boolean;
  driver(): DriverProfile | null;
  thresholds(): Thresholds | null;
  thresholdProvenance?(scenario: Scenario): Omit<WarningReference, 'value'>;
  recordingId?(): string | null;
  saveEvent?(event: DriveDemoEventInput): Promise<void>;
  saveOutcome?(event: DriveDemoEventInput, outcome: NonNullable<DriveDemoEventRow['sensi_outcome']>): Promise<void>;
  account(): string | null;
  readDriver(id: string): Promise<DriverProfile | null>;
  voiceIO(): VoiceIO;
  prepareVoice(): Promise<{ granted: boolean; onDevice: boolean }>;
  releaseAudio(): void;
  openURL(url: string): Promise<unknown>;
  change(snapshot: HomeHardwareDemoSnapshot): void;
  id(): string;
  now?(): number;
};

type Owner = { recordingId: string | null; driver: DriverProfile; account: string | null; contact: Contact; preflight?: Promise<void> };
type Run = {
  episode: Episode;
  live: boolean;
  expiresAt: number;
  controller: SafetyController;
  release(): void;
  permit: RealContactDemoPermit | null;
  permitExpiresAt: number | null;
  trace: ReturnType<typeof responsivenessProbe>;
};

function testContact(driver: DriverProfile | null): Contact | null {
  const name = driver?.emergency_name?.trim();
  const phone = contactPhone(driver?.emergency_phone).phone;
  return name && phone ? { name, phone } : null;
}

function sameDriver(owner: Owner, driver: DriverProfile | null) {
  const contact = testContact(driver);
  return driver?.id === owner.driver.id && driver.updated_at === owner.driver.updated_at
    && contact?.name === owner.contact.name && contact.phone === owner.contact.phone;
}

const idle = (): HomeHardwareDemoSnapshot => ({
  enabled: false, simulation: defaultSimulation(), actual: null, projected: null, warningReference: null, confirmationWindow: null, liveEpisode: false, testContact: null, safety: null, confirmation: null, phase: 'idle', result: null,
});

/** Isolated Debug evaluator and dialogue. Never owns the BLE connection. */
export class HomeHardwareDemo {
  private state = idle();
  private owner: Owner | null = null;
  private run: Run | null = null;
  private engine: FlagEngine | null = null;
  private reference: Thresholds | null = null;
  private evidence: Evidence | null = null;
  private continuity = new SensorContinuity();
  private lastSequence: number | null = null;
  private readonly now: () => number;

  private readonly deps: Dependencies;

  constructor(deps: Dependencies) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  private set(updates: Partial<HomeHardwareDemoSnapshot>) {
    this.state = { ...this.state, ...updates };
    this.deps.change(this.state);
  }

  private current(owner: Owner) {
    return this.owner === owner && this.deps.currentContext()
      && owner.recordingId === (this.deps.recordingId?.() ?? null)
      && owner.account === this.deps.account() && sameDriver(owner, this.deps.driver());
  }

  private fresh(at: number) {
    const age = this.now() - at;
    return age >= 0 && age < SENSOR_STALE_MS;
  }

  private ownsRun(owner: Owner, run: Run) {
    const received = this.continuity.lastAt;
    return this.run === run && this.current(owner) && this.now() < run.expiresAt
      && (!run.live || received !== null && this.fresh(received));
  }

  private prepare(owner: Owner) {
    if (owner.preflight) return;
    const trace = responsivenessProbe('warning', 'Home Demo voice preparation');
    trace('requested');
    owner.preflight = Promise.resolve().then(async () => {
      if (!this.current(owner)) { trace('cancelled'); return; }
      try {
        const readiness = await this.deps.prepareVoice();
        if (!this.current(owner)) { trace('cancelled'); return; }
        trace(readiness.granted && readiness.onDevice ? 'succeeded' : 'failed', readiness);
        if (readiness.granted && readiness.onDevice) return;
      } catch {
        trace(this.current(owner) ? 'failed' : 'cancelled');
      }
      owner.preflight = undefined;
    });
  }

  enable() {
    const driver = this.deps.driver();
    const contact = testContact(driver);
    if (this.owner || !this.deps.currentContext() || !driver || !contact) return false;
    this.owner = { recordingId: this.deps.recordingId?.() ?? null, driver: { ...driver }, account: this.deps.account(), contact };
    this.set({ ...idle(), enabled: true, testContact: contact });
    this.prepare(this.owner);
    return true;
  }

  private clearRun(reason: string) {
    const run = this.run;
    this.run = null;
    if (!run) return;
    run.trace('ownership cleared', { episodeId: run.episode.id, reason });
    run.permit?.revoke();
    try { run.controller.cancelCheck(); }
    catch { /* Ownership is already cleared. */ }
    finally { run.release(); }
  }

  stop() {
    if (!this.owner) return;
    this.owner = null;
    this.clearRun('mode_stopped_or_context_lost');
    this.resetLiveContinuity();
    this.engine = null;
    this.set(idle());
  }

  cancelEpisode(reason = 'explicit_cancel') {
    if (!this.run) return;
    const live = this.run.live;
    this.clearRun(reason);
    if (live) {
      this.engine = null;
      this.resetLiveContinuity();
    } else this.engine?.resetContinuity();
    this.set({ safety: null, confirmation: null, liveEpisode: false, phase: 'idle', result: null,
      ...(live ? { simulation: { ...this.state.simulation, enabled: false }, projected: null, warningReference: null, confirmationWindow: null } : {}) });
  }

  tick() {
    const owner = this.owner;
    const run = this.run;
    if (owner && !this.current(owner)) { this.stop(); return; }
    if (run?.live && (this.continuity.lastAt === null || !this.fresh(this.continuity.lastAt))) {
      this.resetLiveContinuity();
      return;
    }
    if (this.continuity.lastAt !== null && !this.fresh(this.continuity.lastAt)) this.resetLiveContinuity();
    if (run && (this.now() >= run.expiresAt || (run.permitExpiresAt !== null && this.now() >= run.permitExpiresAt))) {
      this.clearRun('expired');
      this.set({ safety: null, confirmation: null, liveEpisode: false, phase: 'finished', result: 'expired' });
    }
  }

  configureSimulation(change: Partial<Simulation>) {
    const owner = this.owner;
    if (!owner || !this.current(owner)) return;
    const previous = this.state.simulation;
    const simulation = { ...previous, ...change };
    if (!within(simulation.hrIncrease, 0, HR_MAX - HR_MIN)
      || !within(simulation.spo2Reduction, 0, SPO2_MAX - SPO2_MIN)) return;
    if (simulation.enabled === previous.enabled && simulation.scenario === previous.scenario
      && simulation.mode === previous.mode && simulation.hrIncrease === previous.hrIncrease
      && simulation.spo2Reduction === previous.spo2Reduction) return;
    this.clearRun('simulation_configuration_changed');
    const reference = simulation.enabled ? this.deps.thresholds() : null;
    this.reference = reference ? { ...reference } : null;
    this.evidence = null;
    const provenance = this.deps.thresholdProvenance?.(simulation.scenario)
      ?? { source: simulation.scenario === 'high_hr' ? 'profile_estimate' as const : 'standard' as const, acknowledgmentAdjusted: false };
    const warningReference = reference ? {
      ...provenance, value: simulation.scenario === 'high_hr' ? reference.highWarn : reference.spo2Warn,
    } : null;
    this.engine = this.reference ? new FlagEngine({ ...this.reference },
      () => `home-biometric-simulation-${this.deps.id()}`, {
        confirmWarningS: FAST_DEMO_WARNING_SLOTS, confirmCriticalS: FAST_DEMO_WARNING_SLOTS,
      }) : null;
    if (simulation.enabled) this.prepare(owner);
    this.set({ simulation, warningReference, confirmationWindow: null, projected: null, liveEpisode: false, safety: null, confirmation: null, phase: 'idle', result: null });
  }

  resetLiveContinuity() {
    this.evidence = null;
    this.continuity.reset();
    this.lastSequence = null;
    this.engine?.resetContinuity();
    if (this.state.actual || this.state.projected || this.state.confirmationWindow)
      this.set({ actual: null, projected: null, confirmationWindow: null });
    if (this.run?.live && this.state.phase !== 'finished') this.cancelEpisode('transport_continuity_reset');
  }

  /** Decoded, current hardware only. Production has already evaluated the frame. */
  frame(frame: Frame, at: number, missing: number, signal: SignalQuality | null, calibratedBpm: number) {
    this.tick();
    const owner = this.owner;
    if (!owner || !this.current(owner) || !this.fresh(at)) return;
    if (frame.version !== 3 || !uint32(frame.seq) || !uint32(frame.endMs)) {
      this.resetLiveContinuity();
      return;
    }
    if (this.lastSequence !== null) {
      const delta = (frame.seq - this.lastSequence) >>> 0;
      if (delta === 0 || delta >= 0x8000_0000) return;
    }
    this.lastSequence = frame.seq;
    const continuity = this.continuity.accept(frame, at, missing);
    if (!continuity.accepted || missing !== 0) {
      this.resetLiveContinuity();
      this.lastSequence = frame.seq;
      return;
    }

    const usable = frame.finger && frame.usable;
    const hr = usable && within(frame.heartRate, HR_MIN, HR_MAX) && within(calibratedBpm, HR_MIN, HR_MAX)
      ? calibratedBpm : null;
    const spo2 = usable && within(frame.spo2, SPO2_MIN, SPO2_MAX) ? frame.spo2 : null;
    const actual = { at, hr, spo2, finger: frame.finger };
    const { simulation, actual: previousActual, projected: previousProjection } = this.state;
    const reference = this.reference;
    const isHr = simulation.scenario === 'high_hr';
    // Keep the bench policy: firmware quality and a feasible phone beat train.
    // When firmware HR is available, retain the independent estimator agreement check.
    const phoneHr = signal?.hrBeats;
    const agreement = signal?.agree === true && phoneHr != null && Number.isFinite(phoneHr)
      && Math.abs(phoneHr - frame.heartRate) <= AGREE_BPM;
    const requiresAgreement = isHr || within(frame.heartRate, HR_MIN, HR_MAX);
    const qualified = within(frame.quality, QUALITY_MIN, 100) && signal?.feasible === true
      && (!requiresAgreement || agreement);
    const source = isHr ? hr : spo2;
    let projected: Projection | null = null;
    if (simulation.enabled && reference && qualified && source !== null) {
      const offset = simulation.mode === 'manual'
        ? isHr ? simulation.hrIncrease : simulation.spo2Reduction
        : isHr ? Math.max(0, reference.highWarn + AUTO_HR_MARGIN - source)
          : Math.max(0, source - (reference.spo2Warn - AUTO_SPO2_MARGIN));
      const value = isHr ? Math.min(HR_MAX, source + offset) : Math.max(SPO2_MIN, source - offset);
      projected = { value, offset: Math.abs(value - source) };
    }
    if (!this.engine || !reference || this.run || this.state.phase !== 'idle') {
      this.set({ actual, projected });
      return;
    }
    const value = projected?.value ?? null;
    const warning = this.state.warningReference;
    const kind = isHr ? 'bpm_high' : 'spo2_low';
    let confirmationWindow: ConfirmationObservation | null = null;
    const events = this.engine.feed({ t: at, bpm: isHr ? value : null, spo2: isHr ? null : value,
      finger: frame.finger, quality: frame.quality, good: projected !== null }, (observation, detail) => {
      if (observation.kind !== kind) return;
      confirmationWindow = observation;
      if (this.evidence?.episodeId === detail.episodeId) this.evidence.observation = observation;
      else this.evidence = null;
      if (!warning || !projected || source === null || detail.slot?.acceptedValue !== projected.value) return;
      if (isHr ? projected.value < warning.value : projected.value > warning.value) return;
      this.evidence = { observation, episodeId: detail.episodeId, reading: { ...projected, actual: source, at } };
    });
    const episode = events.find(event => event.type === 'emergency')?.episode;
    this.set({ actual, projected, confirmationWindow });
    const freshProjection = projected !== null || (previousProjection !== null
      && previousActual !== null && this.fresh(previousActual.at));
    if (episode?.kind === kind && freshProjection) {
      // The final slot may be null if four other slots qualified.
      const evidence = this.evidence;
      const recordingId = owner.recordingId;
      const event: DriveDemoEventInput | undefined = recordingId && warning && evidence?.episodeId === episode.id
        && this.fresh(evidence.reading.at) && (episode.level === 'warning' || episode.level === 'critical') ? {
          id: this.deps.id(), episode_id: episode.id, session_id: recordingId, profile_id: owner.driver.id,
          scenario: simulation.scenario, mode: simulation.mode,
          confirmed_at: new Date(episode.confirmedAt ?? at).toISOString(), measured_at: new Date(evidence.reading.at).toISOString(),
          actual_value: evidence.reading.actual, simulated_value: evidence.reading.value, applied_offset: evidence.reading.offset,
          warning_threshold: warning.value, threshold_source: warning.source, acknowledgment_adjusted: warning.acknowledgmentAdjusted ? 1 : 0,
          confirmation_level: episode.level, slots: evidence.observation.slots,
          accepted_slots: evidence.observation.accepted, abnormal_slots: evidence.observation.beyond,
        } : undefined;
      void this.startCheck(owner, episode, true, event);
    } else if (episode) {
      // Discard stale confirmations and episodes outside the selected scenario.
      this.engine.resetContinuity();
    }
  }

  async trigger() {
    const owner = this.owner;
    if (!owner || owner.recordingId !== null || !this.current(owner) || this.state.phase === 'checking'
      || this.state.phase === 'review' || this.state.phase === 'opening') return false;
    this.clearRun('episode_replaced');
    const at = this.now();
    const episode: Episode = { id: `home-hardware-demo-${this.deps.id()}`, kind: 'bpm_high', level: 'warning',
      stage: 'emergency', startedAt: at, confirmedAt: at, value: 145, threshold: 125, outcome: null, resolvedAt: null };
    return this.startCheck(owner, episode, false);
  }

  private async startCheck(owner: Owner, episode: Episode, live: boolean, event?: DriveDemoEventInput) {
    const at = this.now();
    const trace = responsivenessProbe('warning', 'Home Demo voice capture');
    trace('episode started', { episodeId: episode.id });
    let captured: string | undefined;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      try { this.deps.releaseAudio(); }
      catch { /* Demo cleanup cannot interrupt production safety. */ }
    };
    const controller = new SafetyController({
      interactionCurrent: () => this.ownsRun(owner, run),
      assistantMode: () => 'gemma',
      basicOfflineAcknowledgments: true,
      voiceIO: () => this.deps.voiceIO(),
      releaseAudio: release,
      save: async () => {}, saveAck: async () => {}, haptic: () => {},
      newId: this.deps.id,
      onChange: safety => {
        if (!this.ownsRun(owner, run)) return;
        const check = safety.check;
        if (check?.captureId && check.captureId !== captured) {
          captured = check.captureId;
          trace('capture owned', { episodeId: episode.id, captureId: captured });
        }
        if (check?.phase === 'listening') trace('listening reached', { episodeId: episode.id, captureId: check.captureId });
        this.set({ safety });
      },
    });
    const run: Run = { episode, controller, live, expiresAt: at + EPISODE_MS, release, trace, permit: null, permitExpiresAt: null };
    this.run = run;
    this.set({ safety: null, confirmation: null, liveEpisode: live, phase: 'checking', result: null });
    const saved = event && this.deps.saveEvent
      ? this.deps.saveEvent(event).then(() => true, () => { trace('local event save failed'); return false; })
      : Promise.resolve(false);
    try {
      controller.configure(owner.driver, null);
      const result = await controller.runIsolatedCheck(episode, () => {
        if (!this.ownsRun(owner, run) || this.state.phase !== 'checking') return;
        const expiresAt = Math.min(run.expiresAt, this.now() + PERMIT_MS);
        run.permitExpiresAt = expiresAt;
        run.permit = new RealContactDemoPermit(() => this.ownsRun(owner, run), expiresAt, this.now);
        if (live) void this.openDialer(owner, run, run.permit);
        else this.set({ confirmation: { ...owner.contact, id: episode.id }, phase: 'review' });
      }, live);
      if (this.ownsRun(owner, run)) {
        if (this.state.phase === 'checking') this.set({ phase: 'finished' });
        if (event && result && this.deps.saveOutcome) {
          void saved.then(ok => ok ? this.deps.saveOutcome?.(event, result.outcome) : undefined)
            .catch(() => trace('local outcome save failed'));
        }
      }
      return true;
    } catch {
      if (this.run === run) {
        this.clearRun('setup_failed');
        this.set({ safety: null, confirmation: null, liveEpisode: false, phase: 'finished', result: 'failed' });
      }
      return false;
    } finally { release(); }
  }

  owns(episodeId: string | undefined) {
    return !!episodeId && this.run?.episode.id === episodeId;
  }

  answer(response: Parameters<SafetyController['answer']>[0], scope: Parameters<SafetyController['answer']>[1]) {
    return !!scope && this.owns(scope.episodeId) && (this.run?.controller.answer(response, scope) ?? false);
  }

  answerText(text: string, scope: Parameters<SafetyController['answerText']>[1]) {
    return this.owns(scope.episodeId) && (this.run?.controller.answerText(text, scope) ?? false);
  }

  async confirm(id: string) {
    this.tick();
    const owner = this.owner;
    const run = this.run;
    const permit = run?.permit;
    if (!owner || !run || !permit || !this.ownsRun(owner, run) || this.state.phase !== 'review'
      || this.state.confirmation?.id !== id || !this.state.safety?.conversation?.finished) return;
    await this.openDialer(owner, run, permit);
  }

  private async openDialer(owner: Owner, run: Run, permit: RealContactDemoPermit) {
    this.set({ confirmation: null, phase: 'opening' });
    try {
      const saved = await this.deps.readDriver(owner.driver.id);
      if (!sameDriver(owner, saved)) {
        if (this.run === run) this.stop();
        return;
      }
      await openConfirmedDemoPhoneInterface(owner.contact.phone, () => permit.claim(),
        () => this.ownsRun(owner, run) && this.state.phase === 'opening', this.deps.openURL);
      if (this.run === run) this.set({ phase: 'finished', result: 'requested' });
    } catch {
      if (this.run === run) this.set({ phase: 'finished', result: 'failed' });
    } finally {
      permit.revoke();
      if (run.permit === permit) {
        run.permit = null;
        run.permitExpiresAt = null;
      }
    }
  }
}

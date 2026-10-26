import { approvedAcknowledgment, type SafetyAcknowledgment } from '../assistant/safetyAcknowledgment.ts';
import { simulationCompletion, canOfferSafetyContinuation, type SafetyConversation } from '../assistant/safetyConversation.ts';
import type { AssistantMode } from '../assistant/mode.ts';
import type { PhoneHandoffOrigin } from '../voice/phoneHandoff.ts';
import { SensorContinuity, SENSOR_STALE_MS, type MonitoringStatus } from './sensorContinuity.ts';
import { explicitContactCallRequest, mentionsEmergencyServices, understandCallAnswer } from '../voice/intent.ts';
/**
 * Glue between the live frames, the flag engine, the rhythm monitor and the
 * voice check -- with no React in it, so it can be reasoned about (and
 * tested) on its own. The hook (useDriveSession) forwards frames here and
 * renders whatever state this reports.
 *
 *   frame ─▶ FlagEngine ── warning ──▶ "watching" (logged, shown quietly)
 *                        └─ emergency ─▶ VoiceCheck (speak, listen, understand)
 *                                          └─▶ resolve: ok / not_ok / no_response
 *   frame ─▶ RhythmMonitor ── advisory ─▶ logged, shown after the drive
 *
 * Recording-associated episodes are saved as drive_alerts rows (and uploaded by liveSync):
 * notices, warnings that recovered, unconfirmed ones, emergencies and how the
 * driver answered. Without a recording, events are transient UI state only.
 * Transcripts are not saved.
 */
import type { Frame } from '../ble/protocol';
import type { DriveAlertRow, DriverProfile } from '../db/repositories';
import { parseList } from '../util/json.ts';
import type { Baseline } from './baseline';
import {
  ACK_MARGIN_BPM,
  FlagEngine,
  thresholds,
  type Ack,
  type Band,
  type EngineEvent,
  type Episode,
  type Reading,
  type Thresholds,
} from './flagEngine.ts';
import { personalBand, profilePrior, type ProfilePrior, type Sex } from './profileModel.ts';
import { RhythmMonitor } from './rhythm.ts';
import type { SignalQuality } from './signal.ts';
import { VoiceCheck, type CheckResult, type CheckAnswer, type CheckQuestion, type AnswerScope, type Lang, type VoiceIO } from '../voice/voiceCheck.ts';

export type ContactHandoff = 'opened' | 'missing_contact' | 'invalid_phone' | 'open_failed' | 'cancelled' | 'simulated';

/** Conservative syntax check; never hand emergency-service numbers to the automatic path. */
export function contactPhone(raw: string | null | undefined): { phone: string | null; error: 'missing_contact' | 'invalid_phone' | null } {
  if (!raw?.trim()) return { phone: null, error: 'missing_contact' };
  const phone = raw.trim().replace(/[\s().-]/g, '');
  if (!/^\+?[0-9]{7,15}$/.test(phone)) return { phone: null, error: 'invalid_phone' };
  return { phone, error: null };
}

export type CheckPhase = 'speaking' | 'listening';

export type SafetyState = {
  monitoring: MonitoringStatus;
  conversation: SafetyConversation | null;
  prior: ProfilePrior | null;
  band: (Band & { weight: number }) | null;
  th: Thresholds | null;
  /** A warning flag is up and the next seconds are being checked. */
  tracking: Episode | null;
  /** The voice check is running. */
  check: { episode: Episode; phase: CheckPhase; question: CheckQuestion; captureId: string; fallbackText?: string } | null;
  last: { episode: Episode; result: CheckResult; at: Date; handoff?: ContactHandoff; simulation?: boolean } | null;
  notices: number;
  advisory: boolean;
  rejected: number;
  /** Warning lines moved by the driver's own "I'm OK" answers. */
  ack: Ack;
  /** Demo mode: fabricated readings are being played through the engine. */
  demo: { scenario: DemoScenario; second: number; value: number; step: string } | null;
};

export type DemoScenario = 'high_critical' | 'high_warning' | 'low' | 'spo2';

export const initialSafety: SafetyState = {
  monitoring: 'disconnected',
  conversation: null,
  prior: null,
  band: null,
  th: null,
  tracking: null,
  check: null,
  last: null,
  notices: 0,
  advisory: false,
  rejected: 0,
  ack: { high: null, low: null },
  demo: null,
};

type Deps = {
  /** Immediate foreground/screen check, independent of React effect delivery. */
  interactionCurrent?: () => boolean;
  assistantMode?: () => AssistantMode;
  startAcknowledgment?: () => SafetyAcknowledgment;
  /** Opens the phone interface only; resolution does not mean a connected call. */
  handoffContact?: (phone: string, origin: PhoneHandoffOrigin) => Promise<unknown>;
  voiceIO: () => VoiceIO;
  /** Called when a voice check ends, so other audio returns to full volume. */
  releaseAudio?: () => void;
  save: (row: Omit<DriveAlertRow, 'sync_status'>) => Promise<void>;
  saveAck: (profileId: string, ack: Ack) => Promise<void>;
  /** Adaptation history: called whenever the thresholds are (re)computed. */
  saveSnapshot?: (s: {
    id: string; profile_id: string; at: string; reason: string; drives: number; learned: number;
    mean: number; sd: number; high_warn: number; low_warn: number; spo2_warn: number;
  }) => Promise<unknown>;
  haptic: (kind: 'warning' | 'error') => void;
  onChange: (s: SafetyState) => void;
  newId: () => string;
};

const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());

export class SafetyController {
  private monitoringAvailable = false;
  private continuity = new SensorContinuity();
  private lastValidAt: number | null = null;
  private state: SafetyState = { ...initialSafety };
  private engine: FlagEngine | null = null;
  private rhythm = new RhythmMonitor();
  private sessionId: string | null = null;
  private voice: VoiceCheck | null = null;
  private acknowledgment: SafetyAcknowledgment | null = null;
  private generation = 0;
  private checking = false;
  private simulationOwner: object | null = null;
  private continuation: { episodeId: string; current: () => boolean } | null = null;
  private lang: Lang = 'en';
  private name = '';
  private profile: DriverProfile | null = null;
  private baseline: Baseline | null = null;
  private readonly deps: Deps;

  constructor(deps: Deps) {
    this.deps = deps;
  }

  private set(patch: Partial<SafetyState>) {
    this.state = { ...this.state, ...patch };
    this.deps.onChange(this.state);
  }

  /** Recomputes the driver's thresholds from their profile, baseline and
   *  any "I'm OK" adjustments. */
  configure(p: DriverProfile, baseline: Baseline | null, ack: Ack = this.state.ack, reason = 'drive') {
    if (this.profile?.id !== p.id) {
      this.cancelCheck(); this.engine = null; this.continuity.reset();
      this.lastValidAt = null; this.rhythm = new RhythmMonitor();
    }
    this.profile = p;
    this.baseline = baseline;
    const prior = profilePrior({
      age: p.age,
      sex: p.gender as Sex,
      weight_kg: p.weight_kg,
      height_cm: p.height_cm,
      conditions: parseList(p.conditions),
      medications: parseList(p.medications),
    });
    const band = personalBand(prior, baseline);
    const th = thresholds(prior, band, baseline?.established ? baseline.spo2Median : null, ack);
    if (this.engine) this.engine.setThresholds(th);
    else this.engine = new FlagEngine(th, this.deps.newId);
    this.lang = p.language === 'es' ? 'es' : 'en';
    this.name = p.display_name.split(' ')[0] ?? '';
    this.set({ prior, band, th, ack });
    void this.deps
      .saveSnapshot?.({
        id: this.deps.newId(),
        profile_id: p.id,
        at: new Date().toISOString(),
        reason,
        drives: baseline?.sessions ?? 0,
        learned: Math.round(band.weight * 1000) / 1000,
        mean: Math.round(band.mean * 10) / 10,
        sd: Math.round(band.sd * 10) / 10,
        high_warn: th.highWarn,
        low_warn: th.lowWarn,
        spo2_warn: th.spo2Warn,
      })
      .catch(() => undefined);
  }

  /** Saved profile edits revoke existing consent even when the UUID is unchanged. */
  refreshProfile(p: DriverProfile, baseline: Baseline | null, ack: Ack) {
    this.cancelCheck();
    this.configure(p, baseline, ack, 'profile_edit');
  }

  /** Settings → "Reset": back to the profile/baseline lines. */
  async resetAck() {
    if (!this.profile) return;
    const ack = { high: null, low: null };
    await this.deps.saveAck(this.profile.id, ack);
    this.configure(this.profile, this.baseline, ack, 'reset');
  }

  /**
   * The driver said "I'm OK" to a warning-level heart-rate check: that value is
   * evidently normal for them. Move the warning line past it (see Ack in
   * flagEngine.ts for the safety limits). Never for critical or oxygen.
   */
  private async learnFromOk(ep: Episode) {
    if (!this.profile || ep.level !== 'warning') return;
    const ack = { ...this.state.ack };
    if (ep.kind === 'bpm_high') ack.high = Math.max(ack.high ?? 0, ep.value + ACK_MARGIN_BPM);
    else if (ep.kind === 'bpm_low') ack.low = Math.min(ack.low ?? 999, ep.value - ACK_MARGIN_BPM);
    else return;
    await this.deps.saveAck(this.profile.id, ack);
    this.configure(this.profile, this.baseline, ack, 'ok_answer');
  }

  /**
   * Demo: plays fabricated readings through a fresh copy of the real engine
   * (this driver's thresholds), 4 simulated seconds per real second, until it
   * raises the warning flag and confirms the emergency -- then runs the real
   * voice check. Nothing is saved, uploaded, or learned from.
   */
  async simulate(scenario: DemoScenario): Promise<CheckResult | null> {
    const th = this.state.th;
    if (!th || this.state.check || this.state.demo) return null;
    const owner = this.simulationOwner = {};
    const generation = this.generation;
    const value =
      scenario === 'high_critical' ? th.highCrit + 9
      : scenario === 'high_warning' ? Math.min(th.highCrit - 1, th.highWarn + 6)
      : scenario === 'low' ? th.lowCrit - 3
      : th.spo2Crit - 2;
    const oxygen = scenario === 'spo2';
    const engine = new FlagEngine(th, () => `demo-${Date.now()}`);
    const t0 = Date.now();
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let emergency: Episode | null = null;
    for (let s = 0; s < 90 && !emergency; s += 1) {
      if (this.simulationOwner !== owner) return null;
      if (generation !== this.generation) { this.set({ demo: null, tracking: null }); return null; }
      const abnormal = s >= 10; // 10 normal seconds first, like a real drive
      const jitter = ((s * 7) % 5) - 2;
      const r: Reading = {
        t: t0 + s * 1000,
        bpm: !abnormal || oxygen ? 74 + jitter : value + jitter,
        spo2: abnormal && oxygen ? value + (s % 2) : 98,
        quality: 85,
        finger: true,
      };
      let step = abnormal ? 'fabricated abnormal readings' : 'normal readings';
      for (const e of engine.feed(r)) {
        if (e.type === 'warning' || e.type === 'escalated') {
          step = `warning flag (${e.episode.level}) — confirming`;
          this.set({ tracking: { ...e.episode } });
        } else if (e.type === 'emergency') {
          emergency = e.episode;
          step = 'emergency confirmed — voice check';
        }
      }
      const shown = oxygen ? (r.spo2 ?? 0) : (r.bpm ?? 0);
      this.set({ demo: { scenario, second: s, value: shown, step } });
      await sleep(250);
    }
    if (this.simulationOwner !== owner) return null;
    this.set({ tracking: null });
    if (generation !== this.generation) { this.set({ demo: null }); return null; }
    if (!emergency) {
      this.set({ demo: null });
      return null;
    }
    const result = await this.runCheck(emergency, 'demo');
    if (this.simulationOwner === owner) { this.simulationOwner = null; this.set({ demo: null }); }
    return result;
  }

  /** Combined lifecycle entry retained for existing controller consumers.
   * The app uses setMonitoringContext and setRecordingSession independently. */
  startSession(sessionId: string) {
    this.cancelCheck();
    this.sessionId = sessionId;
    this.monitoringAvailable = true;
    this.continuity.reset();
    this.lastValidAt = null;
    this.rhythm = new RhythmMonitor();
    if (this.state.th) this.engine = new FlagEngine(this.state.th, this.deps.newId);
    this.set({ tracking: null, check: null, last: null, notices: 0, advisory: false, rejected: 0 });
  }

  cancelCheck() {
    this.generation += 1;
    this.simulationOwner = null;
    this.continuation = null;
    this.voice?.cancel();
    this.acknowledgment?.cancel();
    this.acknowledgment = null;
    this.set({ check: null, conversation: null, demo: null });
  }

  /** Full teardown (driver leave/unmount), not the app's End Drive operation. */
  endSession() {
    this.cancelCheck();
    this.sessionId = null;
    this.monitoringAvailable = false;
    this.continuity.reset();
    this.lastValidAt = null;
    this.engine?.resetContinuity();
    this.set({ tracking: null, monitoring: 'unavailable' });
  }

  /** Recording identity is optional and never owns an in-flight safety episode.
   * runCheck captures the recording at episode activation for storage only. */
  setRecordingSession(sessionId: string | null) { this.sessionId = sessionId; }

  setMonitoringContext(connected: boolean, foreground: boolean, supported: boolean) {
    const available = connected && foreground && supported;
    // Simulations can own audio even with no sensor connection.
    if ((!foreground || !supported) && (this.checking || this.state.demo)) this.cancelCheck();
    if (this.monitoringAvailable !== available) {
      this.cancelCheck(); this.engine?.resetContinuity(); this.continuity.reset();
      this.lastValidAt = null;
      this.rhythm = new RhythmMonitor();
      this.monitoringAvailable = available;
      this.set({ tracking: null });
    }
    if (!available || this.state.monitoring !== 'active') this.set({ monitoring:
      !foreground || !supported ? 'unavailable' : !connected ? 'disconnected' : 'waiting' });
  }

  checkSensorFreshness(now: number) {
    const last = this.continuity.lastAt;
    if (this.monitoringAvailable && last !== null && now - last >= SENSOR_STALE_MS) {
      this.cancelCheck(); this.engine?.resetContinuity(); this.continuity.reset();
      this.lastValidAt = null;
      this.rhythm = new RhythmMonitor();
      this.set({ monitoring: 'waiting', tracking: null });
    }
    if (this.monitoringAvailable && this.lastValidAt !== null && now - this.lastValidAt >= SENSOR_STALE_MS
        && this.state.monitoring === 'active') this.set({ monitoring: 'waiting' });
  }

  answer(r: CheckAnswer, scope?: AnswerScope & { episodeId: string }): boolean {
    if (scope && this.state.check?.episode.id !== scope.episodeId) return false;
    return this.voice?.answerByButton(r, scope) ?? false;
  }

  answerText(text: string, scope: AnswerScope & { episodeId: string }): boolean {
    if (!scope || this.state.check?.episode.id !== scope.episodeId) return false;
    return this.voice?.answerByText(text, scope) ?? false;
  }

  /** Legacy continuation API retained, disabled for event-only phase 2. */
  safetyContinuation(_episodeId: string): boolean {
    // Phase 2 is event-only. Legacy ordinary conversation code remains inactive.
    return false;
  }

  consumeSafetyContinuation(episodeId: string): boolean {
    if (!this.safetyContinuation(episodeId)) return false;
    this.continuation = null;
    this.set({ conversation: null });
    return true;
  }

  dismissSafetyConversation(episodeId: string) {
    if (!this.checking && this.state.conversation?.episodeId === episodeId) { this.continuation = null; this.set({ conversation: null }); }
  }

  /** Read-only contact capability for offers; never returns a number or grants consent. */
  assistantContactAvailability(): 'available' | 'missing_contact' | 'invalid_phone' {
    const contact = contactPhone(this.profile?.emergency_phone);
    return contact.phone ? 'available' : contact.error ?? 'missing_contact';
  }

  /** Capture ownership before a standalone conversation starts, not at handoff. */
  assistantOwnership(): () => boolean {
    const generation = this.generation, sessionId = this.sessionId, profileId = this.profile?.id;
    return () => !!profileId && !this.checking && generation === this.generation
      && sessionId === this.sessionId && profileId === this.profile?.id;
  }

  /** Standalone assistant handoff: same deterministic consent/contact/ownership protections.
   * Never resolves a vital episode, saves an incident, or changes thresholds. */
  async assistantContact(transcript: string, offered: boolean, isCurrent: () => boolean): Promise<ContactHandoff | 'not_authorized'> {
    if (mentionsEmergencyServices(transcript) || !(explicitContactCallRequest(transcript)
        || (offered && understandCallAnswer(transcript) === 'yes'))) return 'not_authorized';
    const generation = this.generation;
    const sessionId = this.sessionId;
    const profile = this.profile ? { ...this.profile } : null;
    const current = () => isCurrent() && !this.checking && generation === this.generation
      && sessionId === this.sessionId && profile?.id === this.profile?.id;
    if (!profile || !current()) return 'cancelled';
    const contact = contactPhone(profile.emergency_phone);
    if (!contact.phone) return contact.error ?? 'missing_contact';
    // No asynchronous work between final ownership check and the platform handoff.
    if (!current()) return 'cancelled';
    try {
      if (!this.deps.handoffContact) return 'open_failed';
      await this.deps.handoffContact(contact.phone, { source: 'standalone' });
      return 'opened'; // opening the phone interface never proves call completion
    } catch { return 'open_failed'; }
  }

  onFrame(f: Frame, rx: Date, missingBefore: number, sq: SignalQuality | null = null) {
    if (!this.monitoringAvailable || !this.profile || !this.engine) return;
    const continuity = this.continuity.accept(f, rx.getTime(), missingBefore);
    if (continuity.broken) {
      this.cancelCheck(); this.engine.resetContinuity(); this.rhythm = new RhythmMonitor();
      this.lastValidAt = null;
      this.set({ monitoring: 'waiting', tracking: null });
    }
    if (!continuity.accepted) return;
    const quality = f.version >= 3 ? f.quality : null;
    const valid = f.usable && f.finger && (quality === null || quality >= 50) && sq?.good !== false;
    if (!valid && this.lastValidAt === null) return;
    if (valid) this.lastValidAt = rx.getTime();
    if (valid && this.state.monitoring !== 'active') this.set({ monitoring: 'active' });
    const events = this.checking ? [] : this.engine.feed({
      t: rx.getTime(),
      bpm: f.usable ? f.heartRate : null,
      spo2: f.usable ? f.spo2 : null,
      quality,
      finger: f.finger,
      good: sq && sq.hrBeats !== null ? sq.good : null,
    });
    for (const e of events) this.handle(e);
    if (this.engine.rejected !== this.state.rejected) this.set({ rejected: this.engine.rejected });

    // A driver with known AFib/arrhythmia would get the advisory on every drive.
    if (f.version >= 3 && f.rateHz && !this.state.prior?.knownArrhythmia) {
      const ok = f.finger && (quality ?? 0) >= 50 && missingBefore === 0;
      for (const ev of this.rhythm.feed(f.samples.map((s) => s.ir), f.rateHz, ok)) {
        if (ev.type !== 'advisory') continue;
        const last = ev.metrics[ev.metrics.length - 1]!;
        void this.persist({
          id: this.deps.newId(),
          kind: 'no_contact',
          level: 'notice',
          stage: 'notice',
          startedAt: rx.getTime(),
          value: Math.round(last.nrmssd * 1000) / 1000,
          threshold: 0.098,
          confirmedAt: null,
          outcome: null,
          resolvedAt: null,
        }, 'irregular_rhythm');
        this.set({ advisory: true });
      }
    }
  }

  private handle(e: EngineEvent) {
    const ep = e.episode;
    switch (e.type) {
      case 'notice':
        void this.persist(ep);
        this.set({ notices: this.state.notices + 1 });
        return;
      case 'warning':
      case 'escalated':
        void this.persist(ep);
        this.set({ tracking: { ...ep } });
        return;
      case 'cleared':
        void this.persist(ep);
        this.set({ tracking: null });
        return;
      case 'emergency':
        void this.persist(ep);
        if (this.checking) return;
        // A real event owns the UI immediately. A suspended simulator must not
        // later overwrite its tracking, dialogue or consent scope.
        if (this.simulationOwner) { this.simulationOwner = null; this.set({ demo: null }); }
        this.set({ tracking: null });
        void this.runCheck(ep);
        return;
    }
  }

  /** Settings → "Try the voice check": the real dialogue, simulated phone handoff, nothing recorded. */
  async rehearse(): Promise<CheckResult> {
    const ep: Episode = {
      id: 'rehearsal', kind: 'bpm_high', level: 'warning', stage: 'emergency', startedAt: Date.now(),
      value: 0, threshold: 0, confirmedAt: Date.now(), outcome: null, resolvedAt: null,
    };
    return this.runCheck(ep, 'rehearsal');
  }

  private async runCheck(ep: Episode, mode: 'live' | 'rehearsal' | 'demo' = 'live'): Promise<CheckResult> {
    if (ep.kind === 'no_contact' || this.checking) return { outcome: 'ok', urgent: false, channel: 'none', attempts: 0, confidence: null, contactCall: 'not_requested' };
    this.checking = true;
    this.continuation = null;
    // Capture ownership and contact before any asynchronous dialogue or persistence.
    const generation = this.generation;
    const sessionId = this.sessionId;
    const engine = this.engine;
    const profile = this.profile ? { ...this.profile } : null;
    const profileId = profile?.id;
    const contact = contactPhone(profile?.emergency_phone);
    const current = () => generation === this.generation && profileId === this.profile?.id
      && (this.deps.interactionCurrent?.() ?? true);
    const selected = this.deps.assistantMode?.() ?? 'core';
    const dialogue: SafetyConversation = { episodeId: ep.id, mode: selected, messages: [], finished: false, simulation: mode !== 'live' };
    const publishDialogue = () => {
      try {
        if (current() && selected !== 'core') this.set({ conversation: { ...dialogue, messages: dialogue.messages.map(message => ({ ...message })) } });
      } catch { /* Presentation observers cannot alter the deterministic safety path. */ }
    };
    let messageSequence = 0;
    let activeSpeech: { interrupted: boolean } | null = null;
    let question: CheckQuestion = 'wellness';
    let captureId = '';
    let acknowledgment: SafetyAcknowledgment | null = null;
    if (selected !== 'core') {
      try { acknowledgment = this.deps.startAcknowledgment?.() ?? null; } catch { /* Fixed fallback. */ }
    }
    this.acknowledgment = acknowledgment;
    publishDialogue();
    this.deps.haptic('warning');
    const base = this.deps.voiceIO();
    // Report what the voice check is doing so the screen can show it.
    const io: VoiceIO = {
      speak: async (text, lang) => {
        if (current()) this.set({ check: { episode: ep, phase: 'speaking', question, captureId } });
        const operation = { interrupted: false }; activeSpeech = operation;
        const message = { id: `${ep.id}-${++messageSequence}`, role: 'assistant' as const, text, playback: 'playing' as 'playing' | 'completed' | 'failed' | 'interrupted' };
        dialogue.messages.push(message); publishDialogue();
        try {
          const playback = await base.speak(text, lang);
          message.playback = operation.interrupted || !current() ? 'interrupted' : playback?.status === 'unavailable' ? 'failed' : 'completed';
          if (current() && !operation.interrupted && playback?.status === 'unavailable') this.set({ check: { episode: ep, phase: 'speaking', question, captureId, fallbackText: text } });
          return playback;
        }
        catch (error) {
          message.playback = !current() || operation.interrupted ? 'interrupted' : 'failed';
          if (current() && !operation.interrupted) this.set({ check: { episode: ep, phase: 'speaking', question, captureId, fallbackText: text } });
          throw error;
        }
        finally { if (activeSpeech === operation) activeSpeech = null; publishDialogue(); }
      },
      listen: (lang, ms, hints, captureId) => {
        if (current()) this.set({ check: { episode: ep, phase: 'listening', question, captureId } });
        return base.listen(lang, ms, hints, captureId);
      },
      cancel: () => { if (activeSpeech) activeSpeech.interrupted = true; base.cancel(); },
    };
    const voice = new VoiceCheck(io, this.lang, this.name, {
      contactAvailable: contact.phone !== null,
      onQuestion: (q, id) => { question = q; captureId = id; },
      contactName: selected !== 'core' ? profile?.emergency_name ?? undefined : undefined,
      acknowledgment: () => {
        const text = acknowledgment?.get(this.lang) ?? approvedAcknowledgment(null, this.lang);
        dialogue.acknowledgmentSource = acknowledgment?.source ?? 'fallback';
        publishDialogue();
        return text;
      },
      onAnswer: answer => {
        if (!current()) return;
        dialogue.messages.push({ id: `${ep.id}-${++messageSequence}`, role: 'driver', text: answer.text });
        publishDialogue();
      },
    });
    this.voice = voice;
    if (!current()) voice.cancel();
    let result: CheckResult;
    try {
      result = await voice.run(ep.kind);
    } catch {
      result = voice.cancelledResult ?? { outcome: 'no_response', urgent: false, channel: 'none', attempts: 0, confidence: null, contactCall: 'not_requested' };
    }
    this.voice = null;
    acknowledgment?.cancel();
    if (this.acknowledgment === acknowledgment) this.acknowledgment = null;
    this.deps.releaseAudio?.();
    try {
      if (!current()) {
        // Save a known wellness answer to its original incident only. Do not learn,
        // publish stale UI state, or hand off after session/profile cancellation.
        if (mode === 'live' && result.outcome !== 'no_response') {
          const done = engine?.resolve(result.outcome, Date.now(), ep.id)
            ?? { ...ep, stage: 'resolved' as const, outcome: result.outcome, resolvedAt: Date.now() };
          await this.persist(done, undefined, { ...result, contactCall: 'cancelled' }, sessionId);
        }
        return result;
      }
      // Rehearsals and demos never resolve live episodes, save, learn, or open the phone.
      const done = (mode === 'live' ? engine?.resolve(result.outcome, Date.now(), ep.id) : null)
        ?? { ...ep, stage: 'resolved' as const, outcome: result.outcome, resolvedAt: Date.now() };
      if (mode === 'live') {
        if (result.outcome === 'ok') await this.learnFromOk(done);
        if (result.outcome !== 'ok') this.deps.haptic('error');
        await this.persist(done, undefined, result, sessionId);
      }
      if (!current()) return result;
      const last = { episode: done, result, at: new Date(), simulation: mode !== 'live' };
      this.set({ check: null, last });
      let handoff: ContactHandoff | undefined;
      if (result.contactCall === 'contact_unavailable') handoff = contact.error ?? 'missing_contact';
      if (result.contactCall === 'explicit_request' || result.contactCall === 'accepted_offer') {
        // onChange may synchronously revoke monitoring. Recheck before the platform action.
        if (!current() || !voice.authorizesContact(result) || !profileId || (mode === 'live' && !this.monitoringAvailable)) handoff = 'cancelled';
        else if (!contact.phone) handoff = contact.error ?? 'missing_contact';
        else if (mode !== 'live') handoff = 'simulated';
        else {
          try {
            if (!this.deps.handoffContact) throw new Error('Phone interface unavailable');
            await this.deps.handoffContact(contact.phone, { source: mode, episodeId: ep.id });
            handoff = 'opened';
          } catch {
            handoff = 'open_failed';
          }
        }
      }
      if (current() && handoff) this.set({ last: { ...last, handoff } });
      if (current()) {
        if (mode === 'live' && canOfferSafetyContinuation(result) && !voice.emergencyServicesExcluded && !handoff) this.continuation = { episodeId: ep.id, current };
        if (mode !== 'live') dialogue.messages.push({ id: `${ep.id}-${++messageSequence}`, role: 'system', text: simulationCompletion(result) });
        dialogue.finished = true; publishDialogue();
      }
      return result;
    } finally {
      this.checking = false;
    }
  }

  private async persist(ep: Episode, kindOverride?: string, result?: CheckResult, sessionId = this.sessionId) {
    if (!sessionId) return;
    const escalated = ep.outcome === 'not_ok' || ep.outcome === 'no_response';
    await this.deps
      .save({
        id: ep.id,
        session_id: sessionId,
        kind: kindOverride ?? ep.kind,
        value: Math.round(ep.value * 10) / 10,
        threshold: ep.threshold,
        started_at: iso(ep.startedAt)!,
        prompted_at: iso(ep.confirmedAt),
        response: ep.outcome,
        responded_at: iso(ep.resolvedAt),
        escalated: escalated ? 1 : 0,
        level: ep.level,
        channel: result?.channel ?? null,
        answer_confidence: result?.confidence ?? null,
      })
      .catch(() => undefined);
  }
}

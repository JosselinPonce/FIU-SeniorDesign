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
 * Every episode is saved as a drive_alerts row (and uploaded by liveSync):
 * notices, warnings that recovered, unconfirmed ones, emergencies and how the
 * driver answered. Transcripts are not saved.
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
import { VoiceCheck, type CheckResult, type CheckAnswer, type CheckQuestion, type Lang, type VoiceIO } from '../voice/voiceCheck.ts';

export type ContactHandoff = 'opened' | 'missing_contact' | 'invalid_phone' | 'open_failed' | 'cancelled';

/** Conservative syntax check; never hand emergency-service numbers to the automatic path. */
export function contactPhone(raw: string | null | undefined): { phone: string | null; error: 'missing_contact' | 'invalid_phone' | null } {
  if (!raw?.trim()) return { phone: null, error: 'missing_contact' };
  const phone = raw.trim().replace(/[\s().-]/g, '');
  if (!/^\+?[0-9]{7,15}$/.test(phone)) return { phone: null, error: 'invalid_phone' };
  return { phone, error: null };
}

export type CheckPhase = 'speaking' | 'listening';

export type SafetyState = {
  prior: ProfilePrior | null;
  band: (Band & { weight: number }) | null;
  th: Thresholds | null;
  /** A warning flag is up and the next seconds are being checked. */
  tracking: Episode | null;
  /** The voice check is running. */
  check: { episode: Episode; phase: CheckPhase; question: CheckQuestion } | null;
  last: { episode: Episode; result: CheckResult; at: Date; handoff?: ContactHandoff } | null;
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
  /** Opens the phone interface only; resolution does not mean a connected call. */
  handoffContact?: (phone: string) => Promise<void>;
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
  private state: SafetyState = { ...initialSafety };
  private engine: FlagEngine | null = null;
  private rhythm = new RhythmMonitor();
  private sessionId: string | null = null;
  private voice: VoiceCheck | null = null;
  private generation = 0;
  private checking = false;
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
    if (this.profile?.id !== p.id) this.cancelCheck();
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
    this.set({ tracking: null });
    if (!emergency) {
      this.set({ demo: null });
      return null;
    }
    const result = await this.runCheck(emergency, true);
    this.set({ demo: null });
    return result;
  }

  startSession(sessionId: string) {
    this.cancelCheck();
    this.sessionId = sessionId;
    this.rhythm = new RhythmMonitor();
    if (this.state.th) this.engine = new FlagEngine(this.state.th, this.deps.newId);
    this.set({ tracking: null, check: null, last: null, notices: 0, advisory: false, rejected: 0 });
  }

  cancelCheck() {
    this.generation += 1;
    this.voice?.cancel();
    this.set({ check: null });
  }

  endSession() {
    this.cancelCheck();
    this.sessionId = null;
    this.set({ tracking: null });
  }

  answer(r: CheckAnswer) {
    this.voice?.answerByButton(r);
  }

  onFrame(f: Frame, rx: Date, missingBefore: number, sq: SignalQuality | null = null) {
    if (!this.sessionId || !this.engine) return;
    const quality = f.version >= 3 ? f.quality : null;
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
        this.set({ tracking: null });
        void this.runCheck(ep);
        return;
    }
  }

  /** Settings → "Try the voice check": the real dialogue, nothing recorded. */
  async rehearse(): Promise<CheckResult> {
    const ep: Episode = {
      id: 'rehearsal', kind: 'bpm_high', level: 'warning', stage: 'emergency', startedAt: Date.now(),
      value: 0, threshold: 0, confirmedAt: Date.now(), outcome: null, resolvedAt: null,
    };
    return this.runCheck(ep, true);
  }

  private async runCheck(ep: Episode, rehearsal = false): Promise<CheckResult> {
    if (ep.kind === 'no_contact' || this.checking) return { outcome: 'ok', urgent: false, channel: 'none', attempts: 0, confidence: null, contactCall: 'not_requested' };
    this.checking = true;
    // Capture ownership and contact before any asynchronous dialogue or persistence.
    const generation = this.generation;
    const sessionId = this.sessionId;
    const engine = this.engine;
    const profile = this.profile ? { ...this.profile } : null;
    const profileId = profile?.id;
    const contact = contactPhone(profile?.emergency_phone);
    const current = () => generation === this.generation && sessionId === this.sessionId && profileId === this.profile?.id;
    let question: CheckQuestion = 'wellness';
    this.deps.haptic('warning');
    const base = this.deps.voiceIO();
    // Report what the voice check is doing so the screen can show it.
    const io: VoiceIO = {
      speak: (text, lang) => {
        if (current()) this.set({ check: { episode: ep, phase: 'speaking', question } });
        return base.speak(text, lang);
      },
      listen: (lang, ms, hints) => {
        if (current()) this.set({ check: { episode: ep, phase: 'listening', question } });
        return base.listen(lang, ms, hints);
      },
      cancel: () => base.cancel(),
    };
    const voice = new VoiceCheck(io, this.lang, this.name, {
      contactAvailable: contact.phone !== null,
      onQuestion: (q) => { question = q; },
    });
    this.voice = voice;
    let result: CheckResult;
    try {
      result = await voice.run(ep.kind);
    } catch {
      result = voice.cancelledResult ?? { outcome: 'no_response', urgent: false, channel: 'none', attempts: 0, confidence: null, contactCall: 'not_requested' };
    }
    this.voice = null;
    this.deps.releaseAudio?.();
    try {
      if (rehearsal) {
        if (current()) this.set({ check: null });
        return result;
      }
      if (!current()) {
        // Save a known wellness answer to its original incident only. Do not learn,
        // publish stale UI state, or hand off after session/profile cancellation.
        if (result.outcome !== 'no_response') {
          const done = engine?.resolve(result.outcome, Date.now(), ep.id)
            ?? { ...ep, stage: 'resolved' as const, outcome: result.outcome, resolvedAt: Date.now() };
          await this.persist(done, undefined, { ...result, contactCall: 'cancelled' }, sessionId);
        }
        return result;
      }
      const done = engine?.resolve(result.outcome, Date.now(), ep.id) ?? { ...ep, stage: 'resolved' as const, outcome: result.outcome, resolvedAt: Date.now() };
      if (result.outcome === 'ok') await this.learnFromOk(done);
      if (result.outcome !== 'ok') this.deps.haptic('error');
      await this.persist(done, undefined, result, sessionId);
      if (!current()) return result;
      const last = { episode: done, result, at: new Date() };
      this.set({ check: null, last });
      let handoff: ContactHandoff | undefined;
      if (result.contactCall === 'contact_unavailable') handoff = contact.error ?? 'missing_contact';
      if (result.contactCall === 'explicit_request' || result.contactCall === 'accepted_offer') {
        // onChange may synchronously end the drive. Recheck immediately before the platform action.
        if (!current() || !sessionId) handoff = 'cancelled';
        else if (!contact.phone) handoff = contact.error ?? 'missing_contact';
        else {
          try {
            if (!this.deps.handoffContact) throw new Error('Phone interface unavailable');
            await this.deps.handoffContact(contact.phone);
            handoff = 'opened';
          } catch {
            handoff = 'open_failed';
          }
        }
      }
      if (current() && handoff) this.set({ last: { ...last, handoff } });
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

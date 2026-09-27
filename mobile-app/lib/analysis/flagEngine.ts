/**
 * Warning and emergency flags from one reading per second.
 *
 * Pipeline (each step is there because of a known failure mode):
 *
 *  1. ACCEPT only readings with the finger on the sensor, both vitals valid,
 *     and pulse periodicity ("quality") ≥ 50 %. PPG on a steering wheel is
 *     artifact-prone (grip, vibration); a reading the sensor itself doubts is
 *     not evidence of anything. Rejected seconds count as missing, never as
 *     normal and never as abnormal.
 *  2. HAMPEL FILTER (window 7, 3 × 1.4826 × MAD; Pearson et al. 2016): a
 *     single implausible second that disagrees with its neighbours is dropped.
 *  3. LEVEL of the 5-reading median:
 *       critical  NEWS2 single-parameter score 3 (pulse ≤ 40 or ≥ 131;
 *                 SpO2 ≤ 91 -- COPD drivers ≤ 85)
 *       warning   NEWS2 2 (pulse 111–130; SpO2 92–93), or NEWS2 1 AND
 *                 ≥ 3 SD from this driver's personal band (profileModel.ts);
 *                 COPD drivers: SpO2 more than 4 points below their own
 *                 awake baseline (Little et al. 1999)
 *       notice    NEWS2 1 AND ≥ 2.5 SD from the personal band -- logged only
 *                 (both, so an athlete whose normal is 48 bpm isn't noticed
 *                 every two minutes)
 *  4. PERSISTENCE ("track the next seconds"). A warning or critical median
 *     opens an episode (the WARNING FLAG) and starts a confirmation window:
 *     15 s at warning level, 8 s at critical. At the end of the window the
 *     episode becomes an EMERGENCY only if ≥ 70 % of seconds had an accepted
 *     reading and ≥ 80 % of those were beyond the warning threshold in the
 *     same direction. Short delays remove most non-actionable alarms: a 14-s
 *     delay removed 50 % of ignored/ineffective ICU alarms and 19 s removed
 *     67 % (Görges et al. 2009); a 6-s delay halved SpO2 alarms
 *     (Rheineck-Leyssius & Kalkman 1998).
 *     If the median recovers (with hysteresis) the episode is cleared; if the
 *     signal is too poor to confirm within 60 s it is closed as unconfirmed.
 *  5. After an emergency the engine waits for the caller's resolve() (voice
 *     check / buttons), then keeps quiet for that kind for 5 minutes unless
 *     the level gets worse (warning → critical re-arms immediately).
 *
 * Also: 15 s with no hand on the sensor during a drive raises a no-contact
 * notice (the proposal's "hands-off-wheel" request). It is not an emergency
 * by itself -- the sensor simply cannot see anything.
 *
 * Pure logic: no React, no storage, no speech. Unit-tested in
 * tests/flagEngine.test.ts. Not a medical device.
 */
import { news2Pulse, type ProfilePrior } from './profileModel.ts';

export type FlagKind = 'bpm_high' | 'bpm_low' | 'spo2_low' | 'no_contact';
export type FlagLevel = 'notice' | 'warning' | 'critical';
export type Response = 'ok' | 'not_ok' | 'no_response';

export type Episode = {
  id: string;
  kind: FlagKind;
  level: FlagLevel; // highest level reached
  stage: 'notice' | 'tracking' | 'emergency' | 'resolved';
  startedAt: number;
  value: number; // most extreme 5-s median in the episode
  threshold: number;
  confirmedAt: number | null; // became an emergency
  outcome: Response | 'recovered' | 'unconfirmed' | null;
  resolvedAt: number | null;
};

export type Reading = {
  t: number; // ms epoch
  bpm: number | null; // null = not usable this second
  spo2: number | null;
  quality: number | null; // 0..100 (null on v2 frames: treated as good)
  finger: boolean;
  /** Phone-side verdict from lib/analysis/signal.ts (clean pulse AND two
   *  estimators agree). false rejects the second; null = not available. */
  good?: boolean | null;
};

export const QUALITY_MIN = 50;
export const HAMPEL_WINDOW = 7;
export const HAMPEL_K = 3;
export const MEDIAN_N = 5;
export const CONFIRM_WARNING_S = 15;
export const CONFIRM_CRITICAL_S = 8;
export const COVERAGE_MIN = 0.7;
export const BEYOND_MIN = 0.8;
export const UNCONFIRMED_AFTER_S = 60;
export const COOLDOWN_S = 300;
export const NO_CONTACT_S = 15;
export const NOTICE_REPEAT_S = 120;
const HYSTERESIS_BPM = 5;
const HYSTERESIS_SPO2 = 1;

export type Band = { mean: number; sd: number; weight?: number };

/**
 * "I'm OK" feedback. When the driver answers OK to a WARNING-level heart-rate
 * check, that value was evidently normal for them, so their warning line in
 * that direction moves to the episode's peak + 5 bpm (− 5 for low). Limits
 * keep this safe: the high line never passes 125 and the low line never goes
 * under 43, so the critical lines (≥ 131, ≤ 40 -- NEWS2 red) always still
 * ask; critical episodes and oxygen never adapt; Settings can reset it.
 */
export type Ack = { high: number | null; low: number | null };
export const ACK_MARGIN_BPM = 5;
export const ACK_HIGH_CAP = 125;
export const ACK_LOW_FLOOR = 43;

/**
 * The numbers a reading is compared with, for this driver. `spo2Median` is the
 * driver's learned oxygen median (null until established); it only matters
 * for COPD drivers, whose oxygen is judged relative to their baseline.
 */
export function thresholds(prior: ProfilePrior, band: Band, spo2Median: number | null = null, ack: Ack = { high: null, low: null }) {
  const copdBase = prior.spo2Baseline === null ? null : (spo2Median ?? prior.spo2Baseline);
  // COPD: fall of MORE than 4 points from baseline = warning (Little 1999);
  // readings are whole percent, so "< base − 4" is "≤ ceil(base − 4) − 1".
  const copdWarn = copdBase === null ? 0 : Math.max(86, Math.ceil(copdBase - 4) - 1);
  // High line: the profile's real-world 95th percentile until the driver's own
  // drives are known, then (in proportion to how much we know) their personal
  // mean + 3 SD. Always inside NEWS2's 91–111 band: never alarming on a
  // clinically normal rate, never waiting past NEWS2's "2".
  const w = band.weight ?? 0;
  const personalLine = band.mean + 3 * band.sd;
  const highWarn = Math.min(111, Math.max(91, Math.round(w * personalLine + (1 - w) * prior.hrP95)));
  const lowWarn = Math.max(41, Math.min(50, Math.round(band.mean - 3 * band.sd)));
  return {
    highWarn: ack.high === null ? highWarn : Math.min(ACK_HIGH_CAP, Math.max(highWarn, Math.round(ack.high))),
    highCrit: 131,
    highNotice: Math.max(91, Math.round(band.mean + 2.5 * band.sd)),
    lowWarn: ack.low === null ? lowWarn : Math.max(ACK_LOW_FLOOR, Math.min(lowWarn, Math.round(ack.low))),
    lowCrit: 40,
    lowNotice: Math.min(50, Math.round(band.mean - 2.5 * band.sd)),
    spo2Warn: copdBase === null ? 93 : copdWarn,
    spo2Crit: copdBase === null ? 91 : 85,
    spo2Notice: copdBase === null ? 95 : Math.max(copdWarn + 1, Math.floor(copdBase - 3)),
  };
}
export type Thresholds = ReturnType<typeof thresholds>;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Hampel identifier: is x an outlier against the recent window? */
export function isHampelOutlier(window: number[], x: number, floor = 8): boolean {
  if (window.length < 4) return false;
  const m = median(window);
  const mad = median(window.map((v) => Math.abs(v - m)));
  const sigma = 1.4826 * mad;
  // With a perfectly flat window MAD is 0; a floor keeps ordinary small
  // steps (8 bpm, 3 % SpO2) from counting as outliers.
  return Math.abs(x - m) > Math.max(HAMPEL_K * sigma, floor);
}

type Track = {
  episode: Episode;
  /** One entry per second since the episode opened: null = no accepted
   *  reading, true/false = accepted and beyond / not beyond the line. */
  seconds: (boolean | null)[];
};

export type EngineEvent =
  | { type: 'notice'; episode: Episode }
  | { type: 'warning'; episode: Episode } // flag ticked, now tracking
  | { type: 'escalated'; episode: Episode } // warning → critical while tracking
  | { type: 'emergency'; episode: Episode } // confirmed: run the voice check
  | { type: 'cleared'; episode: Episode }; // recovered or unconfirmed

export class FlagEngine {
  private bpmWin: number[] = [];
  private spoWin: number[] = [];
  private bpmMed: number[] = [];
  private spoMed: number[] = [];
  private tracks = new Map<FlagKind, Track>();
  private awaiting: Episode | null = null;
  private cooldown = new Map<FlagKind, { until: number; level: FlagLevel }>();
  private lastNotice = new Map<FlagKind, number>();
  private noContactSince: number | null = null;
  private noContactFlagged = false;
  rejected = 0;

  private th: Thresholds;
  private readonly newId: () => string;
  private readonly confirmWarningS: number;
  private readonly confirmCriticalS: number;

  /** `opts` lets the offline tuning tool (tools/tuning/tune.ts) replay drives
   *  with other confirmation windows; the app always uses the defaults. */
  constructor(th: Thresholds, newId: () => string, opts: { confirmWarningS?: number; confirmCriticalS?: number } = {}) {
    this.th = th;
    this.newId = newId;
    this.confirmWarningS = opts.confirmWarningS ?? CONFIRM_WARNING_S;
    this.confirmCriticalS = opts.confirmCriticalS ?? CONFIRM_CRITICAL_S;
  }

  setThresholds(th: Thresholds) {
    this.th = th;
  }

  get thresholdsInUse(): Thresholds {
    return this.th;
  }

  /** The episode currently waiting for the driver's answer, if any. */
  get pending(): Episode | null {
    return this.awaiting;
  }

  private accept(r: Reading): { bpm: number | null; spo2: number | null } {
    const good = r.finger && (r.quality === null || r.quality >= QUALITY_MIN) && r.good !== false;
    let bpm = good ? r.bpm : null;
    let spo2 = good ? r.spo2 : null;
    if (bpm !== null) {
      if (isHampelOutlier(this.bpmWin, bpm)) {
        this.rejected += 1;
        bpm = null;
      }
      this.bpmWin = [...this.bpmWin, r.bpm!].slice(-HAMPEL_WINDOW); // raw value keeps the window honest
    }
    if (spo2 !== null) {
      if (isHampelOutlier(this.spoWin, spo2, 3)) {
        this.rejected += 1;
        spo2 = null;
      }
      this.spoWin = [...this.spoWin, r.spo2!].slice(-HAMPEL_WINDOW);
    }
    return { bpm, spo2 };
  }

  private levelOf(kind: FlagKind, v: number): FlagLevel | null {
    const th = this.th;
    if (kind === 'bpm_high') {
      if (v >= th.highCrit || news2Pulse(v) === 3) return v > 90 ? 'critical' : null;
      if (v >= th.highWarn) return 'warning';
      if (v >= th.highNotice) return 'notice';
      return null;
    }
    if (kind === 'bpm_low') {
      if (v <= th.lowCrit) return 'critical';
      if (v <= th.lowWarn) return 'warning';
      if (v <= th.lowNotice) return 'notice';
      return null;
    }
    if (kind === 'spo2_low') {
      if (v <= th.spo2Crit) return 'critical';
      if (v <= th.spo2Warn) return 'warning';
      if (v <= th.spo2Notice) return 'notice';
      return null;
    }
    return null;
  }

  private warnLine(kind: FlagKind): number {
    return kind === 'bpm_high' ? this.th.highWarn : kind === 'bpm_low' ? this.th.lowWarn : this.th.spo2Warn;
  }

  private isBeyond(kind: FlagKind, v: number): boolean {
    const line = this.warnLine(kind);
    return kind === 'bpm_high' ? v >= line : v <= line;
  }

  private recovered(kind: FlagKind, v: number): boolean {
    const line = this.warnLine(kind);
    if (kind === 'bpm_high') return v < line - HYSTERESIS_BPM;
    if (kind === 'bpm_low') return v > line + HYSTERESIS_BPM;
    return v > line + HYSTERESIS_SPO2;
  }

  private open(kind: FlagKind, level: FlagLevel, v: number, t: number, stage: Episode['stage']): Episode {
    return {
      id: this.newId(),
      kind,
      level,
      stage,
      startedAt: t,
      value: v,
      threshold: kind === 'no_contact' ? NO_CONTACT_S : this.warnLine(kind),
      confirmedAt: null,
      outcome: null,
      resolvedAt: null,
    };
  }

  /** Feed one second. Returns the events it caused (usually none). */
  feed(r: Reading): EngineEvent[] {
    const out: EngineEvent[] = [];
    const t = r.t;

    // --- hands-off / no contact -------------------------------------------
    if (!r.finger) {
      this.noContactSince ??= t;
      if (!this.noContactFlagged && t - this.noContactSince >= NO_CONTACT_S * 1000) {
        this.noContactFlagged = true;
        const e = this.open('no_contact', 'notice', (t - this.noContactSince) / 1000, this.noContactSince, 'notice');
        out.push({ type: 'notice', episode: e });
      }
    } else {
      this.noContactSince = null;
      this.noContactFlagged = false;
    }

    const { bpm, spo2 } = this.accept(r);
    if (bpm !== null) this.bpmMed = [...this.bpmMed, bpm].slice(-MEDIAN_N);
    if (spo2 !== null) this.spoMed = [...this.spoMed, spo2].slice(-MEDIAN_N);
    const medBpm = this.bpmMed.length >= 3 ? median(this.bpmMed) : null;
    const medSpo = this.spoMed.length >= 3 ? median(this.spoMed) : null;

    const series: [FlagKind, number | null, number | null][] = [
      ['bpm_high', medBpm, bpm],
      ['bpm_low', medBpm, bpm],
      ['spo2_low', medSpo, spo2],
    ];
    for (const [kind, med, raw] of series) {
      const track = this.tracks.get(kind);
      if (track) {
        out.push(...this.step(kind, track, med, raw, t));
        continue;
      }
      if (med === null || this.awaiting) continue;
      const level = this.levelOf(kind, med);
      if (!level) continue;
      const cd = this.cooldown.get(kind);
      if (cd && t < cd.until && !(cd.level === 'warning' && level === 'critical')) continue;
      if (level === 'notice') {
        const last = this.lastNotice.get(kind) ?? -Infinity;
        if (t - last >= NOTICE_REPEAT_S * 1000) {
          this.lastNotice.set(kind, t);
          out.push({ type: 'notice', episode: this.open(kind, 'notice', med, t, 'notice') });
        }
        continue;
      }
      const episode = this.open(kind, level, med, t, 'tracking');
      this.tracks.set(kind, { episode, seconds: [] });
      out.push({ type: 'warning', episode });
    }
    return out;
  }

  private step(kind: FlagKind, tr: Track, med: number | null, raw: number | null, t: number): EngineEvent[] {
    const ep = tr.episode;
    tr.seconds.push(raw === null ? null : this.isBeyond(kind, raw));
    if (med !== null) {
      const worse = kind === 'bpm_high' ? med > ep.value : med < ep.value;
      if (worse) ep.value = med;
      if (this.levelOf(kind, med) === 'critical' && ep.level !== 'critical') {
        ep.level = 'critical';
        return [{ type: 'escalated', episode: { ...ep } }];
      }
      if (this.recovered(kind, med)) return this.close(kind, ep, 'recovered', t);
    }
    // Judge the most recent confirmation window (15 s, or 8 s once critical).
    const w = ep.level === 'critical' ? this.confirmCriticalS : this.confirmWarningS;
    if (tr.seconds.length >= w) {
      const win = tr.seconds.slice(-w);
      const accepted = win.filter((x) => x !== null);
      const coverage = accepted.length / w;
      const beyond = accepted.length ? accepted.filter(Boolean).length / accepted.length : 0;
      if (coverage >= COVERAGE_MIN && beyond >= BEYOND_MIN) {
        // Keep other confirmed-ready tracks queued until the active dialogue resolves.
        // Never overwrite the episode that owns that dialogue in the same feed batch.
        if (this.awaiting) return [];
        this.tracks.delete(kind);
        ep.stage = 'emergency';
        ep.confirmedAt = t;
        this.awaiting = ep;
        return [{ type: 'emergency', episode: ep }];
      }
    }
    // Hovering near the line, or too little signal to decide, for a minute.
    if (tr.seconds.length >= UNCONFIRMED_AFTER_S) return this.close(kind, ep, 'unconfirmed', t);
    return [];
  }

  private close(kind: FlagKind, ep: Episode, outcome: 'recovered' | 'unconfirmed', t: number): EngineEvent[] {
    this.tracks.delete(kind);
    ep.stage = 'resolved';
    ep.outcome = outcome;
    ep.resolvedAt = t;
    // An unconfirmed episode would otherwise reopen the next second.
    if (outcome === 'unconfirmed') this.cooldown.set(kind, { until: t + NOTICE_REPEAT_S * 1000, level: ep.level });
    return [{ type: 'cleared', episode: ep }];
  }

  /** The driver answered (or didn't). Closes the pending emergency. */
  resolve(response: Response, t: number, episodeId = this.awaiting?.id): Episode | null {
    const ep = this.awaiting;
    if (!ep || ep.id !== episodeId) return null;
    this.awaiting = null;
    ep.stage = 'resolved';
    ep.outcome = response;
    ep.resolvedAt = t;
    this.cooldown.set(ep.kind, { until: t + COOLDOWN_S * 1000, level: ep.level });
    return ep;
  }
}

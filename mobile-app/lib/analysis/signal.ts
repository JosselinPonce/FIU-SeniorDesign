/**
 * Per-second signal analysis on the phone, from the 100 Hz raw PPG.
 *
 * Every second the last WINDOW_S seconds of the infrared waveform are
 * analysed to produce, independently of the ESP32:
 *
 *   hrBeats     heart rate from the individual beats (median beat-to-beat
 *               interval; Elgendi 2013 detector, lib/analysis/rhythm.ts)
 *   feasible    Orphanidou et al. 2015 physiological-feasibility rules on the
 *               beat train (rate range, no long gaps, interval ratio)
 *   templateR   Orphanidou's template matching: mean correlation of every beat
 *               with the window's average beat
 *   skewness    Elgendi 2016's best single SQI, of the band-passed window
 *   perfusion   perfusion index, AC/DC of the IR signal × 100
 *   agree       the ESP32's heart rate and hrBeats agree
 *
 * and one verdict, `good`, that the flag engine and the baseline use: a
 * second only counts as evidence when the waveform itself looks like a clean
 * pulse AND two independent estimators give the same heart rate.
 *
 * Evidence for each rule:
 *   - Orphanidou et al. 2015 (IEEE JBHI 19:832): 10-s windows; feasibility
 *     = HR 40–180, largest gap ≤ 3 s, max/min interval < 2.2; template
 *     correlation ≥ 0.86 for PPG → 91 % sensitivity, 95 % specificity.
 *   - Elgendi 2016 (Bioengineering 3:21): skewness was the best single SQI;
 *     clean PPG is positively skewed, threshold 0 (F1 up to 87 %).
 *   - Estimator agreement: Gao et al. 2025 (Sensors, in-vehicle PPG) counted
 *     an epoch acceptable when the PPG rate was within ±5 bpm of ECG.
 *   - Perfusion index is recorded but NOT used in the verdict: published
 *     cut-offs are for clinical transmissive probes, and Elgendi found the
 *     perfusion SQI not significant; a MAX30102 cut-off must be learned from
 *     our own labelled data first.
 *   - On real roads, steering-wheel PPG detected beats with only ~45–58 %
 *     performance (Warnecke et al. 2023, Sci Rep, 19 drivers) -- the reason
 *     every second is quality-gated before it counts for anything.
 *
 * All saved with the reading (telemetry_events.sqi_* columns) so the dataset
 * carries its own quality labels for later algorithm work.
 */
import { bandpass, detectBeats } from './rhythm.ts';

// Thresholds — sources in the doc comment of each use.
export const WINDOW_S = 10; // Orphanidou 2015
export const HR_MIN = 40; // Orphanidou 2015 feasibility: 40–180 bpm
export const HR_MAX = 180;
export const MAX_GAP_S = 3; // no beat-to-beat gap longer than 3 s
export const MAX_RR_RATIO = 2.2; // longest / shortest interval, must be below
export const TEMPLATE_R_MIN = 0.86; // mean beat-template correlation
export const AGREE_BPM = 5; // Gao 2025
export const SKEW_MIN = 0; // Elgendi 2016: clean PPG is positively skewed
/** Shown to the driver as "weak pulse"; not part of the verdict (see above). */
export const PERFUSION_HINT = 0.2;

export type SignalQuality = {
  hrBeats: number | null;
  beats: number;
  feasible: boolean;
  templateR: number | null;
  skewness: number | null;
  perfusion: number | null;
  agree: boolean | null; // null when either estimate is missing
  good: boolean;
};

const EMPTY: SignalQuality = {
  hrBeats: null,
  beats: 0,
  feasible: false,
  templateR: null,
  skewness: null,
  perfusion: null,
  agree: null,
  good: false,
};

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i += 1) {
    ma += a[i]!;
    mb += b[i]!;
  }
  ma /= n;
  mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i += 1) {
    const da = a[i]! - ma, db = b[i]! - mb;
    sab += da * db;
    saa += da * da;
    sbb += db * db;
  }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : 0;
}

/** Analyse one window of raw IR samples (oldest first). */
export function analyseWindow(ir: ArrayLike<number>, fs: number, esp32Bpm: number | null): SignalQuality {
  if (ir.length < fs * 4) return { ...EMPTY };
  const peaks = detectBeats(ir, fs);
  const filtered = bandpass(Array.from(ir, (v) => -v), fs); // pulses point up

  // Skewness of the band-passed window (Elgendi 2016).
  let mean = 0;
  for (const v of filtered) mean += v;
  mean /= filtered.length;
  let m2 = 0, m3 = 0;
  for (const v of filtered) {
    const d = v - mean;
    m2 += d * d;
    m3 += d * d * d;
  }
  m2 /= filtered.length;
  m3 /= filtered.length;
  const skewness = m2 > 0 ? m3 / Math.pow(m2, 1.5) : null;

  // Perfusion index: pulsatile amplitude over DC, per beat, median.
  let dc = 0;
  for (let i = 0; i < ir.length; i += 1) dc += ir[i]!;
  dc /= ir.length;
  const amps: number[] = [];
  for (let k = 1; k < peaks.length; k += 1) {
    let lo = Infinity, hi = -Infinity;
    for (let i = peaks[k - 1]!; i <= peaks[k]!; i += 1) {
      lo = Math.min(lo, filtered[i]!);
      hi = Math.max(hi, filtered[i]!);
    }
    amps.push(hi - lo);
  }
  const perfusion = amps.length && dc > 0 ? (median(amps) / dc) * 100 : null;

  // Beat-to-beat intervals and the Orphanidou feasibility rules.
  const ibis = peaks.slice(1).map((p, k) => ((p - peaks[k]!) * 1000) / fs);
  const hrBeats = ibis.length >= 3 ? 60000 / median(ibis) : null;
  const edgeGap = peaks.length ? Math.max(peaks[0]!, ir.length - 1 - peaks[peaks.length - 1]!) / fs : Infinity;
  const feasible =
    hrBeats !== null &&
    hrBeats >= HR_MIN &&
    hrBeats <= HR_MAX &&
    Math.max(...ibis) / 1000 <= MAX_GAP_S &&
    edgeGap <= MAX_GAP_S &&
    Math.max(...ibis) / Math.min(...ibis) < MAX_RR_RATIO;

  // Template matching: each beat (window = median interval, centred on the
  // peak) against the average beat.
  let templateR: number | null = null;
  if (feasible && ibis.length >= 3) {
    const half = Math.round((median(ibis) / 1000) * fs * 0.5);
    const beats = peaks
      .filter((p) => p - half >= 0 && p + half < filtered.length)
      .map((p) => Array.from(filtered.subarray(p - half, p + half)));
    if (beats.length >= 3) {
      const template = beats[0]!.map((_, j) => beats.reduce((a, b) => a + b[j]!, 0) / beats.length);
      templateR = beats.reduce((a, b) => a + pearson(b, template), 0) / beats.length;
    }
  }

  const agree =
    hrBeats === null || esp32Bpm === null
      ? null
      : Math.abs(hrBeats - esp32Bpm) <= AGREE_BPM;
  const good = feasible && (templateR ?? 0) >= TEMPLATE_R_MIN && (skewness ?? -1) >= SKEW_MIN && agree !== false;
  return { hrBeats, beats: peaks.length, feasible, templateR, skewness, perfusion, agree, good };
}

/** Keeps the last WINDOW_S seconds of IR and analyses them each second. */
export class SignalAnalyzer {
  private buf: number[] = [];
  private fs = 100;

  get hasWindow() { return this.buf.length >= WINDOW_S * this.fs; }

  /** One frame. `continuous` = no frames lost before it and the finger is on. */
  feed(ir: ArrayLike<number>, fs: number, continuous: boolean, esp32Bpm: number | null): SignalQuality {
    if (!continuous || fs !== this.fs) {
      this.buf = [];
      this.fs = fs;
      if (!continuous) return { ...EMPTY };
    }
    for (let i = 0; i < ir.length; i += 1) this.buf.push(ir[i]!);
    const keep = WINDOW_S * fs;
    if (this.buf.length > keep) this.buf.splice(0, this.buf.length - keep);
    if (this.buf.length < keep) return { ...EMPTY };
    return analyseWindow(this.buf, fs, esp32Bpm);
  }
}

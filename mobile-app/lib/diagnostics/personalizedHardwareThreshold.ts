import type { Baseline } from '../analysis/baseline';
import type { Thresholds } from '../analysis/flagEngine';
import { news2Pulse } from '../analysis/profileModel.ts';

const MAX_WARNING_SHIFT = 40;
type Reference = { low: number; high: number; typical: number; p10: number; p90: number };
export type DiagnosticThresholds = Reference & { production: Thresholds; test: Thresholds };

export function diagnosticReference(baseline: Baseline | null): Reference | null {
  if (!baseline?.established) return null;
  const { bpmP10: p10, bpmMedian: typical, bpmP90: p90 } = baseline;
  if (p10 === null || typical === null || p90 === null || ![p10, typical, p90].every(Number.isFinite)
    || p10 > typical || typical > p90 || p10 < 30 || p90 > 220 || typical <= 30 || typical >= 220) return null;

  // Move each percentile toward the median by a bounded amount based on
  // historical spread. Keep the integer decision lines strictly on either
  // side of the median, including when all three percentiles coincide.
  const shift = Math.min(5, Math.max(1, Math.round((p90 - p10) / 4)));
  return {
    low: Math.min(Math.ceil(typical) - 1, Math.floor(p10 + shift)),
    high: Math.max(Math.floor(typical) + 1, Math.ceil(p90 - shift)),
    typical, p10, p90,
  };
}

export function deriveDiagnosticThresholds(baseline: Baseline | null, production: Thresholds | null): DiagnosticThresholds | null {
  const reference = diagnosticReference(baseline);
  if (!reference || !production || !Object.values(production).every(Number.isFinite)) return null;
  const high = Math.max(reference.high, production.highWarn - MAX_WARNING_SHIFT);
  const low = Math.min(reference.low, production.lowWarn + MAX_WARNING_SHIFT);
  if (low <= production.lowCrit || high >= production.highCrit || low >= high
    || high > production.highWarn || low < production.lowWarn || news2Pulse(high) === 3
    || (high === production.highWarn && low === production.lowWarn)
    || !(production.spo2Crit < production.spo2Warn)) return null;

  return Object.freeze({ ...reference, low, high, production: Object.freeze({ ...production }),
    test: Object.freeze({ ...production, lowWarn: low, highWarn: high }) });
}

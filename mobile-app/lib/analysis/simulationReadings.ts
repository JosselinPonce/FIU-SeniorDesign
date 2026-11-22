import type { Thresholds } from './flagEngine.ts';

export type DemoScenario = 'high_critical' | 'high_warning' | 'low' | 'spo2';

export const FIRST_ABNORMAL_SIMULATION_SECOND = 10;

/** The fabricated values used by Safety Testing, independent of live telemetry. */
export function simulationReading(th: Thresholds, scenario: DemoScenario, second: number) {
  const abnormal = second >= FIRST_ABNORMAL_SIMULATION_SECOND;
  const oxygen = scenario === 'spo2';
  const jitter = ((second * 7) % 5) - 2;
  const value = scenario === 'high_critical' ? th.highCrit + 9
    : scenario === 'high_warning' ? Math.min(th.highCrit - 1, th.highWarn + 6)
    : scenario === 'low' ? th.lowCrit - 3
    : th.spo2Crit - 2;
  return {
    bpm: !abnormal || oxygen ? 74 + jitter : value + jitter,
    spo2: abnormal && oxygen ? value + (second % 2) : 98,
  };
}

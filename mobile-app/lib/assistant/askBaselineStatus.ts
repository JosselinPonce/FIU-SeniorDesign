import type { Baseline } from '../analysis/baseline.ts';

export function isBaselineStatusQuestion(question: string): boolean {
  const value = question.normalize('NFKD').replace(/\p{M}/gu, '').trim().toLowerCase().replace(/[?.!]+$/u, '');
  return /^(?:do i have (?:an? )?(?:(?:established|personalized|personal) )*baseline|(?:what is|what's|show me) my (?:(?:personalized|personal|current|recorded) )*baseline|is my (?:(?:personalized|personal) )*baseline (?:ready|established|available)|(?:what is|what's) my baseline status|¿?(?:tengo (?:una )?(?:referencia personal|linea basal)|cual es mi (?:referencia personal|linea basal)|esta lista mi referencia personal))$/u.test(value);
}

export function baselineStatusAnswer(baseline: Baseline | null, authorized: boolean, t: (text: string) => string): string {
  if (!authorized) return t('Personal baseline access is not authorized for this answer.');
  if (!baseline) return t('The current driver’s baseline is temporarily unavailable.');
  if (!baseline.established) return baseline.readings
    ? t('Your personal baseline is still developing. Qualifying readings: {count}.').replace('{count}', String(baseline.readings))
    : t('A personal baseline has not been established. No qualifying readings are available for this driver.');
  return [
    t('Your personal driving baseline is established.'),
    ...(baseline.bpmMedian === null ? [] : ['- ' + t('Typical heart rate: {value} BPM').replace('{value}', String(baseline.bpmMedian))]),
    ...(baseline.spo2Median === null ? [] : ['- ' + t('Typical SpO₂ estimate: {value}%').replace('{value}', String(baseline.spo2Median))]),
    ...(baseline.bpmP10 === null || baseline.bpmP90 === null ? [] :
      ['- ' + t('Usual recorded heart-rate range: {low}–{high} BPM').replace('{low}', String(baseline.bpmP10)).replace('{high}', String(baseline.bpmP90))]),
    '- ' + t('Qualifying readings: {count}.').replace('{count}', String(baseline.readings)),
    '',
    t('These are personal monitoring references. General physiological ranges and DriveSense safety thresholds are separate. A driving baseline cannot establish a medically healthy range.'),
  ].join('\n');
}

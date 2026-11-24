import { ASK_TOPICS, MAX_QUESTION, MAX_WARNINGS, MAX_ASK_TURNS, MAX_ASK_HISTORY_ANSWER, WARNING_LABELS, type AskRequest, type AskSafetyContext, type DriveContext, type Metric } from '../_shared/askSensi.ts';
export const MAX_ASK_BODY_BYTES = 12_288;
import { record, SafeError, UUID } from '../driver-assistant/contracts.ts';

const invalid = (): never => { throw new SafeError(400, 'invalid_request'); };
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!record(value) || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) return invalid();
  return value;
}
function number(value: unknown, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max ? value : invalid();
}
function count(value: unknown): number {
  const n = number(value, 10_000_000);
  return Number.isInteger(n) ? n : invalid();
}
function optional(value: unknown, max: number) { return value === null ? null : number(value, max); }
function metric(value: unknown, max: number): Metric {
  const row = object(value, ['min', 'average', 'max']);
  const min = optional(row.min, max), average = optional(row.average, max), maximum = optional(row.max, max);
  if (min !== null && maximum !== null && min > maximum) return invalid();
  if (average !== null && ((min !== null && average < min - 0.05) || (maximum !== null && average > maximum + 0.05))) return invalid();
  return { min, average, max: maximum };
}
function context(value: unknown): DriveContext {
  const row = object(value, ['date', 'durationSeconds', 'samples', 'heartRate', 'oxygen', 'trend', 'warningCount', 'warnings']);
  const date = row.date;
  if (date !== null && (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)
    || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)) return invalid();
  const warningCount = count(row.warningCount);
  if (!Array.isArray(row.warnings) || row.warnings.length !== Math.min(warningCount, MAX_WARNINGS)) return invalid();
  const warnings = row.warnings.map((value): DriveContext['warnings'][number] => {
    const { kind, level, value: reading, threshold } = object(value, ['kind', 'level', 'value', 'threshold']);
    if (typeof kind !== 'string' || !Object.hasOwn(WARNING_LABELS, kind)
      || (level !== null && level !== 'notice' && level !== 'warning' && level !== 'critical')) return invalid();
    const numeric = kind === 'bpm_high' || kind === 'bpm_low' || kind === 'spo2_low';
    const max = kind === 'spo2_low' ? 100 : 400;
    if (!numeric && (reading !== null || threshold !== null)) return invalid();
    return { kind: kind as DriveContext['warnings'][number]['kind'], level, value: optional(reading, max), threshold: optional(threshold, max) };
  });
  const trend = row.trend === null ? null : object(row.trend, ['heartRateFirst', 'heartRateLast', 'oxygenFirst', 'oxygenLast']);
  return { date, durationSeconds: optional(row.durationSeconds, 10_000_000), samples: count(row.samples),
    heartRate: metric(row.heartRate, 400), oxygen: metric(row.oxygen, 100), trend: trend ? {
      heartRateFirst: optional(trend.heartRateFirst, 400), heartRateLast: optional(trend.heartRateLast, 400),
      oxygenFirst: optional(trend.oxygenFirst, 100), oxygenLast: optional(trend.oxygenLast, 100),
    } : null, warningCount, warnings };
}
function boundedText(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) return invalid();
  return value.trim();
}
function safetyContext(value: unknown): AskSafetyContext {
  const row = object(value, ['baseline', 'thresholds']);
  const base = object(row.baseline, ['heartRateMedian', 'spo2Median']);
  const baseline = { heartRateMedian: optional(base.heartRateMedian, 400), spo2Median: optional(base.spo2Median, 100) };
  if (baseline.heartRateMedian === 0 || baseline.spo2Median === 0) return invalid();
  if (row.thresholds === null) {
    if (baseline.heartRateMedian === null && baseline.spo2Median === null) return invalid();
    return { baseline, thresholds: null };
  }
  const limits = object(row.thresholds, ['highWarn', 'highCrit', 'lowWarn', 'lowCrit', 'spo2Warn', 'spo2Crit']);
  const thresholds = {
    highWarn: number(limits.highWarn, 400), highCrit: number(limits.highCrit, 400),
    lowWarn: number(limits.lowWarn, 400), lowCrit: number(limits.lowCrit, 400),
    spo2Warn: number(limits.spo2Warn, 100), spo2Crit: number(limits.spo2Crit, 100),
  };
  if (!thresholds.lowCrit || !thresholds.spo2Crit || thresholds.lowCrit > thresholds.lowWarn
    || thresholds.lowWarn >= thresholds.highWarn || thresholds.highWarn > thresholds.highCrit
    || thresholds.spo2Crit > thresholds.spo2Warn) return invalid();
  return { baseline, thresholds };
}

export function validateAskRequest(value: unknown): AskRequest {
  const personalized = record(value) && value.version === 3;
  const extended = personalized || record(value) && value.version === 2;
  const keys = ['version', 'kind', 'requestId', 'topic', 'question', 'context'];
  const row = object(value, personalized ? [...keys, 'history', 'safetyContext'] : extended ? [...keys, 'history'] : keys);
  if ((!extended && row.version !== 1) || row.kind !== 'ask_sensi' || typeof row.requestId !== 'string' || !UUID.test(row.requestId)
    || typeof row.topic !== 'string' || !Object.hasOwn(ASK_TOPICS, row.topic)) return invalid();
  if ((row.topic === 'help') !== (row.context === null)) return invalid();
  const parsed = { kind: 'ask_sensi' as const, requestId: row.requestId.toLowerCase(), topic: row.topic as AskRequest['topic'],
    question: boundedText(row.question, MAX_QUESTION), context: row.context === null ? null : context(row.context) };
  if (!extended) return { ...parsed, version: 1 };
  if (!Array.isArray(row.history) || row.history.length > MAX_ASK_TURNS) return invalid();
  const history = row.history.map(value => {
    const turn = object(value, ['question', 'answer']);
    return { question: boundedText(turn.question, MAX_QUESTION), answer: boundedText(turn.answer, MAX_ASK_HISTORY_ANSWER) };
  });
  return personalized ? { ...parsed, version: 3, history, safetyContext: safetyContext(row.safetyContext) }
    : { ...parsed, version: 2, history };
}

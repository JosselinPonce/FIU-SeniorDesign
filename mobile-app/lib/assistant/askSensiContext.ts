import type { Baseline } from '../analysis/baseline.ts';
import type { Thresholds } from '../analysis/flagEngine.ts';
import type { AskSafetyContext } from '../../supabase/functions/_shared/askSensi.ts';

export function askSafetyContext(baseline: Baseline | null, thresholds: Thresholds | null): AskSafetyContext | null {
  const measured = (value: number | null | undefined, maximum: number): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= maximum ? value : null;
  const heartRateMedian = baseline?.established ? measured(baseline.bpmMedian, 400) : null;
  const spo2Median = baseline?.established ? measured(baseline.spo2Median, 100) : null;
  if (!thresholds && heartRateMedian === null && spo2Median === null) return null;
  if (!thresholds) return { baseline: { heartRateMedian, spo2Median }, thresholds: null };
  const { highWarn, highCrit, lowWarn, lowCrit, spo2Warn, spo2Crit } = thresholds;
  const effective = [highWarn, highCrit, lowWarn, lowCrit].every(value => measured(value, 400) !== null)
    && [spo2Warn, spo2Crit].every(value => measured(value, 100) !== null)
    && lowCrit <= lowWarn && lowWarn < highWarn && highWarn <= highCrit && spo2Crit <= spo2Warn
    ? { highWarn, highCrit, lowWarn, lowCrit, spo2Warn, spo2Crit } : null;
  if (!effective && heartRateMedian === null && spo2Median === null) return null;
  return { baseline: { heartRateMedian, spo2Median }, thresholds: effective };
}

import { MAX_WARNINGS, WARNING_LABELS, type DriveContext, type VitalTrend, type WarningKind } from '../../supabase/functions/_shared/askSensi.ts';
import type { DriveSession, DriveAlertRow, SessionStats } from '../db/repositories.ts';

type Repo = {
  getAskSensiSession(driverId: string, id: string): Promise<DriveSession | null>;
  sessionStats(id: string, driverId: string): Promise<SessionStats>;
  askSensiVitalTrend(id: string, from: string, midpoint: string, to: string, driverId: string): Promise<VitalTrend | null>;
  askSensiWarningSummary(id: string, limit: number, driverId: string): Promise<{
    total: number; groups?: { kind: string; level: string | null; count: number }[]; rows: Pick<DriveAlertRow, 'kind' | 'level' | 'value' | 'threshold'>[];
  }>;
};

export function localDriveDateTime(timestamp: string, timeZone?: string): Pick<DriveContext, 'date' | 'localTime'> {
  const instant = new Date(timestamp);
  if (!Number.isFinite(instant.getTime())) return { date: null };
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? '';
  return { date: `${value('year')}-${value('month')}-${value('day')}`, localTime: `${value('hour')}:${value('minute')}` };
}

export async function loadAskSensiContext(repo: Repo, driverId: string, sessionId: string): Promise<DriveContext | null> {
  const session = await repo.getAskSensiSession(driverId, sessionId);
  if (!session || session.profile_id !== driverId || session.status === 'active') return null;
  const start = Date.parse(session.started_at), end = Date.parse(session.ended_at ?? '');
  const trendPromise = Number.isFinite(start) && Number.isFinite(end) && end > start
    ? repo.askSensiVitalTrend(sessionId, new Date(start).toISOString(), new Date(start + (end - start) / 2).toISOString(), new Date(end).toISOString(), driverId)
    : Promise.resolve(null);
  const [stats, summary, trend] = await Promise.all([repo.sessionStats(sessionId, driverId), repo.askSensiWarningSummary(sessionId, MAX_WARNINGS, driverId), trendPromise]);
  const current = await repo.getAskSensiSession(driverId, sessionId);
  if (!current || current.profile_id !== driverId || current.status === 'active') return null;
  const number = (value: number | null, max: number) => value !== null && Number.isFinite(value) && value >= 0 && value <= max ? value : null;
  return {
    ...localDriveDateTime(session.started_at),
    durationSeconds: number(session.duration_seconds, 10_000_000),
    samples: stats.samples,
    heartRate: { min: number(stats.bpm_min, 400), average: number(stats.bpm_avg, 400), max: number(stats.bpm_max, 400) },
    oxygen: { min: number(stats.spo2_min, 100), average: number(stats.spo2_avg, 100), max: number(stats.spo2_max, 100) },
    trend: trend ? {
      heartRateFirst: number(trend.heartRateFirst, 400), heartRateLast: number(trend.heartRateLast, 400),
      oxygenFirst: number(trend.oxygenFirst, 100), oxygenLast: number(trend.oxygenLast, 100),
    } : null,
    warningCount: summary.total,
    ...(summary.groups ? { warningGroups: summary.groups } : {}),
    warnings: summary.rows.map(row => {
      const kind = Object.hasOwn(WARNING_LABELS, row.kind) ? row.kind as WarningKind : 'other';
      const level = row.level === 'notice' || row.level === 'warning' || row.level === 'critical' ? row.level : null;
      const max = kind === 'spo2_low' ? 100 : kind === 'bpm_high' || kind === 'bpm_low' ? 400 : null;
      return { kind, level, value: max === null ? null : number(row.value, max), threshold: max === null ? null : number(row.threshold, max) };
    }),
  };
}

import { ScrollView, Text } from 'react-native';
import type { useDriveSession } from '../lib/hooks/useDriveSession';
import { CHART_SECONDS } from '../lib/hooks/useDriveSession';
import { useTheme } from '../lib/theme/ThemeProvider';
import { vitalRangePresentation } from '../lib/ui/dashboard';
import { VitalChart } from './charts';
import { Btn, Card, Row, fmtClock, fmtNum } from './ui';

/** Read-only view of the same session snapshot; owns no monitoring or audio. */
export function VitalsDetailView({ drive: d, onBack }: { drive: ReturnType<typeof useDriveSession>; onBack(): void }) {
  const { tokens } = useTheme();
  const now = Date.now();
  const th = d.safety.th;
  const band = d.safety.band && th ? { low: Math.max(th.lowWarn, d.safety.band.mean - 2 * d.safety.band.sd), high: Math.min(th.highWarn, d.safety.band.mean + 2 * d.safety.band.sd) } : null;
  const metrics = [
    { title: 'Heart Rate', value: d.bpm, unit: 'BPM', points: d.bpmSeries, color: tokens.heartAccent, min: 40, max: 160, band, bounds: th ? { low: th.lowWarn, high: th.highWarn } : undefined },
    { title: 'SpO₂ (estimate)', value: d.spo2, unit: '%', points: d.spo2Series, color: tokens.oxygenAccent, min: 85, max: 100, band: null, bounds: th ? { low: th.spo2Warn } : undefined },
  ];
  return <ScrollView contentContainerStyle={{ padding: 14, gap: 12, paddingBottom: 24 }}>
    <Btn title="Back to dashboard" kind="ghost" onPress={onBack} />
    <Text accessibilityRole="header" style={{ color: tokens.text, fontSize: 22, fontWeight: '700' }}>Detailed Vitals</Text>
    <Text style={{ color: tokens.textSecondary }}>Current session buffer · up to {CHART_SECONDS / 60} minutes. Missing readings remain gaps.</Text>
    {metrics.map(metric => {
      const reading = vitalRangePresentation(metric.value, d.lastRx, d.isConnected, now, metric.bounds);
      const points = metric.points.slice(-CHART_SECONDS);
      const received = points.filter(point => point.v !== null);
      return <Card key={metric.title}>
        <Text accessibilityRole="header" style={{ color: tokens.text, fontSize: 18, fontWeight: '600' }}>{metric.title}</Text>
        <Text style={{ color: tokens.text, fontSize: 34, fontWeight: '700' }}>{reading.value === null ? '--' : fmtNum(reading.value)} {metric.unit}</Text>
        <Text style={{ color: reading.state === 'warning' || reading.state === 'stale' ? tokens.warning : tokens.textSecondary }}>{reading.label}</Text>
        <VitalChart points={metric.points} seconds={CHART_SECONDS} color={metric.color} min={metric.min} max={metric.max} band={metric.band}
          height={150} backgroundColor={tokens.metricChartSurface} bandColor={tokens.metricChartBand}
          startLabel="Received sample window" endLabel={reading.state === 'live' || reading.state === 'warning' ? 'now' : received.length ? 'last received' : 'no data'} />
        <Text style={{ color: tokens.textSecondary }}>{received.length ? `${received.length} available readings · ${points.length - received.length} missing` : 'No readings available'}</Text>
        {received.length ? <Text style={{ color: tokens.textSecondary }}>Available span: {fmtClock(new Date(received[0].t))}–{fmtClock(new Date(received[received.length - 1].t))}</Text> : null}
        <Text style={{ color: tokens.textMuted }}>Last sensor packet: {d.lastRx ? fmtClock(d.lastRx) : 'unavailable'}</Text>
      </Card>;
    })}
    <Card>
      <Text style={{ color: tokens.text, fontWeight: '600' }}>Personalized thresholds</Text>
      {th ? <>
        <Row label="Heart-rate warning boundaries" value={`${th.lowWarn} / ${th.highWarn} BPM`} />
        <Row label="Heart-rate critical boundaries" value={`${th.lowCrit} / ${th.highCrit} BPM`} />
        <Row label="SpO₂ warning boundary" value={`${th.spo2Warn}%`} />
        <Row label="SpO₂ critical boundary" value={`${th.spo2Crit}%`} />
      </> : <Text style={{ color: tokens.textSecondary }}>Personalized thresholds unavailable</Text>}
      <Text style={{ color: tokens.textMuted }}>Range labels describe the latest reading. Safety checks continue to use existing signal-quality and timing rules.</Text>
    </Card>
  </ScrollView>;
}

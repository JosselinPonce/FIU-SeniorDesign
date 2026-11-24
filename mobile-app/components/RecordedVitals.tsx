import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { recordedVitals, type RecordedVital, type SessionSummary } from '../lib/db/repositories';
import { LocalizedText as Text } from '../lib/i18n/native';
import { useTheme } from '../lib/theme/ThemeProvider';
import { recordedVitalPoints, RECORDED_WINDOW_SECONDS } from '../lib/ui/recordedVitals';
import { SettingsGroup, SettingsRow } from './SettingsGroup';
import { VitalChart } from './charts';
import { Btn, fmtClock } from './ui';

export function RecordedVitals({ session }: { session: SessionSummary }) {
  if (session.status === 'active' || !session.ended_at || !session.event_count) return null;
  const start = Date.parse(session.started_at);
  const end = Date.parse(session.ended_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return <SettingsGroup>
    <RecordedVitalsDisclosure profileId={session.profile_id} sessionId={session.id} start={start} end={end} />
  </SettingsGroup>;
}

function RecordedVitalsDisclosure({ profileId, sessionId, start, end }: { profileId: string; sessionId: string; start: number; end: number }) {
  const { tokens: t } = useTheme();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(0);
  const [result, setResult] = useState<{ start: number; rows: RecordedVital[] | null } | null>(null);
  const pageMs = RECORDED_WINDOW_SECONDS * 1000;
  const windowStart = start + page * pageMs;
  const windowEnd = Math.min(windowStart + pageMs, end + 1);
  const seconds = Math.ceil((windowEnd - windowStart) / 1000);
  useEffect(() => {
    if (!open) return;
    let current = true;
    void recordedVitals(profileId, sessionId, windowStart, windowEnd).then(
      rows => { if (current) setResult({ start: windowStart, rows }); },
      () => { if (current) setResult({ start: windowStart, rows: null }); },
    );
    return () => { current = false; };
  }, [open, profileId, sessionId, windowStart, windowEnd]);

  const selected = result?.start === windowStart ? result : null;
  const data = selected?.rows ? recordedVitalPoints(selected.rows, windowStart, seconds) : null;
  const charts = data ? [
    { title: 'Heart rate (BPM)', points: data.heart, min: 40, max: 160, color: t.heartAccent },
    { title: 'SpO₂ (estimate)', points: data.oxygen, min: 85, max: 100, color: t.oxygenAccent },
  ] : [];
  const startLabel = fmtClock(new Date(windowStart));
  const endLabel = fmtClock(new Date(windowEnd - 1));
  return <>
    <SettingsRow title="Recorded trends" subtitle="Heart rate and blood oxygen from this saved drive"
      expanded={open} onPress={() => setOpen(value => !value)} />
    {open ? <View style={{ paddingHorizontal: 14, paddingBottom: 14, gap: 8 }}>
      <Text style={{ color: t.textSecondary }}>{startLabel}–{endLabel}</Text>
      {!selected ? <Text style={{ color: t.textSecondary }}>Loading…</Text> : null}
      {selected?.rows === null ? <Text accessibilityRole="alert" style={{ color: t.textSecondary }}>Could not load saved readings.</Text> : null}
      {charts.map(({ title, points, min, max, color }) => <View key={title} style={{ gap: 4 }}>
        <Text accessibilityRole="header" style={{ color: t.text, fontWeight: '600' }}>{title}</Text>
        {points.some(point => point.v !== null)
          ? <VitalChart points={points} seconds={seconds} color={color} min={min} max={max} height={76} backgroundColor={t.metricChartSurface}
              startLabel={startLabel} endLabel={endLabel} />
          : <Text style={{ color: t.textSecondary }}>No usable readings in this interval.</Text>}
      </View>)}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Btn title="Earlier" kind="ghost" disabled={page === 0} onPress={() => setPage(page - 1)} />
        <Btn title="Later" kind="ghost" disabled={windowEnd > end} onPress={() => setPage(page + 1)} />
      </View>
    </View> : null}
  </>;
}

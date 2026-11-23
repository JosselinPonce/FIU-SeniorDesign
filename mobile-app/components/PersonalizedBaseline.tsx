import { useEffect, useState } from 'react';
import { AppState, StyleSheet, View, useWindowDimensions } from 'react-native';
import { BASELINE_MIN_READINGS, type Baseline } from '../lib/analysis/baseline';
import { driverBaseline } from '../lib/db/repositories';
import { LocalizedText as Text } from '../lib/i18n/native';
import { useTheme } from '../lib/theme/ThemeProvider';
import { SettingsGroup } from './SettingsGroup';
import { fmtNum, Pill, SectionTitle } from './ui';

type Result = { driverId: string; revision: number; baseline: Baseline | null; failed: boolean; refreshing?: boolean };

export function PersonalizedBaseline({ driverId, savedDriveRevision, recording, liveBpm = null }: {
  driverId?: string;
  savedDriveRevision: number;
  recording: boolean;
  liveBpm?: number | null;
}) {
  const { tokens: t } = useTheme();
  const { width, fontScale } = useWindowDimensions();
  const [result, setResult] = useState<Result | null>(null);
  useEffect(() => {
    if (!driverId) return;
    let request = 0;
    async function refresh(id: string) {
      const current = ++request;
      setResult(previous => previous?.driverId === id ? { ...previous, refreshing: true } : previous);
      try {
        const baseline = await driverBaseline(id);
        if (request === current) setResult({ driverId: id, revision: savedDriveRevision, baseline, failed: false });
      } catch {
        if (request === current) setResult({ driverId: id, revision: savedDriveRevision, baseline: null, failed: true });
      }
    }
    void refresh(driverId);
    const app = AppState.addEventListener('change', state => { if (state === 'active') void refresh(driverId); });
    return () => { request++; app.remove(); };
  }, [driverId, savedDriveRevision]);

  const current = result?.driverId === driverId && result?.revision === savedDriveRevision ? result : null;
  const baseline = current?.baseline;
  const readings = baseline?.readings ?? 0;
  const percent = Math.min(100, Math.floor(100 * readings / BASELINE_MIN_READINGS));
  const status = !driverId ? 'Unavailable' : current?.failed ? 'Could not load' : !baseline ? 'Loading…'
    : baseline.established ? 'Ready' : readings ? 'Collecting readings' : 'Not started';

  const ready = baseline?.established === true;
  const low = baseline?.bpmP10;
  const high = baseline?.bpmP90;
  const comparison = ready && recording && !current?.refreshing && liveBpm !== null && Number.isFinite(liveBpm) && low != null && high != null
    ? liveBpm < low ? 'Below your usual range' : liveBpm > high ? 'Above your usual range' : 'Within your usual range'
    : null;
  const metrics = ready ? [
    { label: 'Usual heart-rate range', value: low != null && high != null ? `${fmtNum(low)}–${fmtNum(high)} BPM` : 'Unavailable', color: t.heartText },
    { label: 'Typical heart rate', value: baseline.bpmMedian === null ? 'Unavailable' : `${fmtNum(baseline.bpmMedian)} BPM`, color: t.heartText },
    { label: 'Typical SpO₂ (estimate)', value: baseline.spo2Median === null ? 'Unavailable' : `${fmtNum(baseline.spo2Median)}%`, color: t.oxygenText },
    { label: 'Qualifying readings', value: String(readings), color: t.text },
  ] : [];

  return <SettingsGroup>
    <View style={{ padding: 14, gap: 10 }}>
      <SectionTitle>{ready ? 'Your Personalized Baseline' : 'Personalized Baseline'}</SectionTitle>
      {ready ? <>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {metrics.map(metric => <View key={metric.label} style={{ flexBasis: width < 340 || fontScale > 1.35 ? '100%' : '46%',
            flexGrow: 1, padding: 10, borderRadius: 10, backgroundColor: t.surfaceMuted, gap: 3 }}>
            <Text style={{ color: t.textSecondary, fontSize: 13 }}>{metric.label}</Text>
            <Text style={{ color: metric.color, fontSize: 20, fontWeight: '700', fontVariant: ['tabular-nums'] }}>{metric.value}</Text>
          </View>)}
        </View>
        {comparison ? <View style={{ paddingTop: 8, gap: 2, borderTopWidth: StyleSheet.hairlineWidth, borderColor: t.border }}>
          <Text style={{ color: t.text, fontWeight: '600' }}>Current heart rate: {fmtNum(liveBpm)} BPM</Text>
          <Text style={{ color: t.textSecondary }}>{comparison}</Text>
        </View> : null}
      </> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <Pill tone={ready ? 'good' : current?.failed ? 'warn' : 'neutral'}>{status}</Pill>
        {baseline ? <Text style={{ color: ready ? t.textSecondary : t.text, fontWeight: '600' }}>
          {ready ? `${percent}% complete` : `${readings} / ${BASELINE_MIN_READINGS} readings · ${percent}% complete`}
        </Text> : null}
      </View>
      {baseline ? <>
        <View accessibilityRole="progressbar" accessibilityLabel="Baseline progress"
          accessibilityValue={{ min: 0, max: BASELINE_MIN_READINGS, now: Math.min(readings, BASELINE_MIN_READINGS) }}
          style={{ height: 6, borderRadius: 3, backgroundColor: t.surfaceMuted, overflow: 'hidden' }}>
          <View style={{ width: `${percent}%`, height: '100%', backgroundColor: t.connected }} />
        </View>
        <Text style={{ color: t.textSecondary }}>
          {ready ? 'Personal reference from finished drives on this phone.' : 'Learns your usual readings from qualifying samples in finished drives on this phone.'}
        </Text>
        {recording && !ready ? <Text style={{ color: t.textSecondary }}>This drive can contribute after it is saved.</Text> : null}
      </> : current?.failed ? <Text style={{ color: t.textSecondary }}>Saved baseline data could not be read from this phone.</Text> : null}
    </View>
  </SettingsGroup>;
}

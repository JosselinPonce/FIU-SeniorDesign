import { STANDALONE_DEMO } from '../lib/buildProfile';
import { LocalizedText as Text } from '../lib/i18n/native';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../lib/theme/ThemeProvider';
import type { Point } from '../lib/hooks/useDriveSession';
import { vitalRangePresentation, type WarningBounds } from '../lib/ui/dashboard';
import { Card, fmtNum } from './ui';
import { VitalChart } from './charts';

export function CompactVitalCard(props: {
  metric: 'heart' | 'oxygen'; label: string; value: number | null; unit: string; average: number | null; points: Point[];
  connected: boolean; lastRx: Date | null; now: number; seconds: number; min: number; max: number;
  warningBounds?: WarningBounds;
  demoLayout?: 'summary' | 'history';
  simulation?: { value: number | null; actual: number | null; offset: number | null };
  band?: { low: number; high: number } | null;
}) {
  const { tokens } = useTheme();
  const accent = props.metric === 'heart' ? tokens.heartAccent : tokens.oxygenAccent;
  const labelColor = props.metric === 'heart' ? tokens.heartText : tokens.oxygenText;
  const reading = vitalRangePresentation(props.value, props.lastRx, props.connected, props.now, props.warningBounds);
  const simulation = (__DEV__ || STANDALONE_DEMO) ? props.simulation : undefined;
  const demoLayout = (__DEV__ || STANDALONE_DEMO) ? props.demoLayout : undefined;
  const shown = (value: number) => String(Number(value.toFixed(2)));
  return <Card style={{ flex: 1, minWidth: 0, gap: 4, padding: 9, borderWidth: StyleSheet.hairlineWidth, borderColor: simulation ? tokens.warning : tokens.border }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      <View accessible={false} style={{ width: 5, height: 16, borderRadius: 3, backgroundColor: accent }} />
      <Text style={{ color: labelColor, fontSize: 13, fontWeight: '600', flexShrink: 1 }}>{props.label}</Text>
    </View>
    {demoLayout === 'history' ? null : simulation ? <>
      <Text style={{ color: tokens.warning, fontSize: 13, fontWeight: '700' }}>
        {props.metric === 'heart' ? 'Simulated HR' : 'Simulated SpO₂'}
      </Text>
      {simulation.value === null
        ? <Text accessibilityLiveRegion="polite" style={{ color: tokens.warning, fontSize: 17, fontWeight: '700' }}>Simulation unavailable</Text>
        : <View style={{ flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', gap: 4 }}>
          <Text accessibilityLiveRegion="polite" style={{ color: tokens.warning, fontSize: 40, fontWeight: '700', fontVariant: ['tabular-nums'] }}>{shown(simulation.value)}</Text>
          <Text style={{ color: tokens.warning, fontSize: 14 }}>{props.unit}</Text>
        </View>}
      <Text style={{ color: tokens.text, fontSize: 13 }}>
        {props.metric === 'heart' ? 'Actual HR' : 'Actual SpO₂ (estimate)'}{' · '}
        {simulation.actual === null ? '—' : `${shown(simulation.actual)} ${props.unit}`}
      </Text>
      <Text style={{ color: tokens.textSecondary, fontSize: 12 }}>
        {'Applied offset'}{' · '}
        {simulation.offset === null ? '—' : `${props.metric === 'heart' ? '+' : '−'}${shown(simulation.offset)} `}
        {simulation.offset === null ? null : props.metric === 'heart' ? 'BPM' : 'percentage points'}
      </Text>
    </> : <>
      {demoLayout === 'summary' ? <Text style={{ color: tokens.textSecondary, fontSize: 13 }}>{props.metric === 'heart' ? 'Actual HR' : 'Actual SpO₂ (estimate)'}</Text> : null}
      <View style={{ flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', gap: 4 }}>
        <Text accessibilityLiveRegion="polite" style={{ color: tokens.text, fontSize: demoLayout === 'summary' ? 34 : 40, fontWeight: '700', fontVariant: ['tabular-nums'] }}>{reading.value === null ? '--' : fmtNum(reading.value)}</Text>
        <Text style={{ color: tokens.textSecondary, fontSize: 14 }}>{props.unit}</Text>
      </View>
      <Text style={{ color: reading.state === 'stale' || reading.state === 'warning' ? tokens.warning : tokens.textSecondary, fontSize: 12 }}>{reading.label}</Text>
    </>}
    {demoLayout !== 'summary' ? <>
      {demoLayout === 'history' ? <Text style={{ color: tokens.textSecondary, fontSize: 12, fontWeight: '600' }}>Actual sensor history</Text> : null}
      <VitalChart points={props.points} seconds={props.seconds} color={accent} backgroundColor={tokens.metricChartSurface} bandColor={tokens.metricChartBand}
        min={props.min} max={props.max} band={props.band} height={52}
        startLabel={`${props.seconds / 60} min window`} endLabel={(reading.state === 'live' || reading.state === 'warning') ? 'now' : props.points.some(point => point.v !== null) ? 'last received' : 'no data'} />
      <Text style={{ color: tokens.textMuted, fontSize: 12 }}>Average {fmtNum(props.average)} {props.unit}</Text>
      {props.points.every(point => point.v === null) ? <Text style={{ color: tokens.textMuted, fontSize: 12 }}>No readings</Text> : null}
    </> : null}
  </Card>;
}

import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../lib/theme/ThemeProvider';
import type { Point } from '../lib/hooks/useDriveSession';
import { vitalRangePresentation, type WarningBounds } from '../lib/ui/dashboard';
import { Card, fmtNum } from './ui';
import { VitalChart } from './charts';

export function CompactVitalCard(props: {
  metric: 'heart' | 'oxygen'; label: string; value: number | null; unit: string; average: number | null; points: Point[];
  connected: boolean; lastRx: Date | null; now: number; seconds: number; min: number; max: number;
  warningBounds?: WarningBounds;
  band?: { low: number; high: number } | null;
}) {
  const { tokens } = useTheme();
  const accent = props.metric === 'heart' ? tokens.heartAccent : tokens.oxygenAccent;
  const labelColor = props.metric === 'heart' ? tokens.heartText : tokens.oxygenText;
  const reading = vitalRangePresentation(props.value, props.lastRx, props.connected, props.now, props.warningBounds);
  return <Card style={{ flex: 1, minWidth: 0, gap: 6, padding: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: tokens.border }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <View accessible={false} style={{ width: 5, height: 16, borderRadius: 3, backgroundColor: accent }} />
      <Text style={{ color: labelColor, fontSize: 13, fontWeight: '600', flexShrink: 1 }}>{props.label}</Text>
    </View>
    <View style={{ flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', gap: 6 }}>
      <Text accessibilityLiveRegion="polite" style={{ color: tokens.text, fontSize: 42, fontWeight: '700', fontVariant: ['tabular-nums'] }}>{reading.value === null ? '--' : fmtNum(reading.value)}</Text>
      <Text style={{ color: tokens.textSecondary, fontSize: 14 }}>{props.unit}</Text>
    </View>
    <Text style={{ color: reading.state === 'stale' || reading.state === 'warning' ? tokens.warning : tokens.textSecondary, fontSize: 12 }}>{reading.label}</Text>
    <VitalChart points={props.points} seconds={props.seconds} color={accent} backgroundColor={tokens.metricChartSurface} bandColor={tokens.metricChartBand}
      min={props.min} max={props.max} band={props.band} height={64}
      startLabel={`${props.seconds / 60} min window`} endLabel={(reading.state === 'live' || reading.state === 'warning') ? 'now' : props.points.some(point => point.v !== null) ? 'last received' : 'no data'} />
    <Text style={{ color: tokens.textMuted, fontSize: 12 }}>Average {fmtNum(props.average)} {props.unit}</Text>
    {props.points.every(point => point.v === null) ? <Text style={{ color: tokens.textMuted, fontSize: 12 }}>No readings</Text> : null}
  </Card>;
}

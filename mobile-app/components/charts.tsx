import { useTheme } from '../lib/theme/ThemeProvider';
import { presentationColors, type ThemeTokens } from '../lib/theme/tokens';
/**
 * Charts drawn with plain Views, so no native charting module is needed.
 */
import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';


import type { Point, RatePoint } from '../lib/hooks/useDriveSession';

/**
 * One bar per second over the last `seconds`. A missing bar is a second with
 * no usable reading (no finger, or the estimator rejected a noisy window) --
 * shown as a gap rather than a misleading zero. `band` shades the driver's
 * usual range behind the bars.
 */
export function VitalChart(props: {
  points: Point[];
  seconds: number;
  color: string;
  min: number;
  max: number;
  band?: { low: number; high: number } | null;
  height?: number;
  backgroundColor?: string;
  bandColor?: string;
  startLabel?: string;
  endLabel?: string;
}) {
  const { colors: C, tokens } = useTheme();
  const st = makeStyles(tokens);
  const H = props.height ?? 72;
  const slots: (number | null)[] = new Array(props.seconds).fill(null);
  const pts = props.points.slice(-props.seconds);
  pts.forEach((p, i) => {
    slots[props.seconds - pts.length + i] = p.v;
  });
  const y = (v: number) => Math.min(1, Math.max(0, (v - props.min) / (props.max - props.min))) * H;
  return (
    <View>
      <View style={[st.body, { height: H }, props.backgroundColor ? { backgroundColor: props.backgroundColor } : null]}>
        {props.band ? (
          <View
            style={[st.band, props.bandColor ? { backgroundColor: props.bandColor } : null, { bottom: y(props.band.low), height: Math.max(2, y(props.band.high) - y(props.band.low)) }]}
          />
        ) : null}
        {slots.map((v, i) => (
          <View
            key={i}
            style={{
              flex: 1,
              height: v === null ? 0 : Math.max(2, y(v)),
              backgroundColor: props.color,
              opacity: 0.35 + (0.65 * i) / slots.length, // older seconds fade
              borderTopLeftRadius: 2,
              borderTopRightRadius: 2,
            }}
          />
        ))}
      </View>
      <View style={st.axis}>
        <Text style={st.axisText}>{props.startLabel ?? `${props.seconds / 60} min ago`}</Text>
        <Text style={st.axisText}>
          {props.min}–{props.max}
        </Text>
        <Text style={st.axisText}>{props.endLabel ?? 'now'}</Text>
      </View>
    </View>
  );
}

/**
 * The live data-rate indicator: a small trace of bytes/s over the last minute
 * with a dot riding the newest value, pulsing on every update, so you can see
 * at a glance that data is flowing and how much. Two traces: received from the
 * Pi (the wheel's packets) and sent to the cloud.
 */
export function RateDot(props: { series: RatePoint[] }) {
  const { colors: C, tokens } = useTheme();
  const st = makeStyles(tokens);
  const H = 44;
  const pulse = useRef(new Animated.Value(0)).current;
  const last = props.series[props.series.length - 1];
  useEffect(() => {
    pulse.setValue(1);
    Animated.timing(pulse, { toValue: 0, duration: 700, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
  }, [last?.t, pulse]);

  const max = Math.max(600, ...props.series.map((p) => Math.max(p.rx, p.tx)));
  const n = 60;
  const pad = new Array(Math.max(0, n - props.series.length)).fill(null);
  const cols = [...pad, ...props.series.slice(-n)] as (RatePoint | null)[];
  const yRx = last ? (last.rx / max) * (H - 10) : 0;
  return (
    <View style={{ gap: 6 }}>
      <View style={[st.rateBody, { height: H }]}>
        {cols.map((p, i) => (
          <View key={i} style={st.rateCol}>
            <View style={{ height: p ? (p.tx / max) * (H - 10) : 0, backgroundColor: C.brand, opacity: 0.35, width: '100%' }} />
            <View
              style={{
                position: 'absolute',
                bottom: p ? (p.rx / max) * (H - 10) : 0,
                width: '100%',
                height: 2,
                backgroundColor: p ? C.oxygen : 'transparent',
              }}
            />
          </View>
        ))}
        <Animated.View
          style={[
            st.dot,
            {
              bottom: yRx - 5,
              transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.8] }) }],
              opacity: last && last.rx > 0 ? 1 : 0.3,
            },
          ]}
        />
      </View>
      <View style={st.legend}>
        <Text style={[st.legendText, { color: C.oxygen }]}>● from wheel {last ? `${last.rx} B/s` : '—'}</Text>
        <Text style={[st.legendText, { color: C.brand }]}>▮ to cloud {last ? `${last.tx} B/s` : '—'}</Text>
      </View>
    </View>
  );
}

/** A compact waveform strip (min/max per column), for unfolded archives. */
export function Waveform(props: { values: number[]; color: string; height?: number; columns?: number }) {
  const { colors: C, tokens } = useTheme();
  const st = makeStyles(tokens);
  const H = props.height ?? 80;
  const cols = props.columns ?? 120;
  if (!props.values.length) return null;
  const per = Math.max(1, Math.floor(props.values.length / cols));
  const buckets: [number, number][] = [];
  for (let i = 0; i + per <= props.values.length && buckets.length < cols; i += per) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let j = i; j < i + per; j += 1) {
      lo = Math.min(lo, props.values[j]!);
      hi = Math.max(hi, props.values[j]!);
    }
    buckets.push([lo, hi]);
  }
  const lo = Math.min(...buckets.map((b) => b[0]));
  const hi = Math.max(...buckets.map((b) => b[1]));
  const span = hi - lo || 1;
  return (
    <View style={[st.wave, { height: H }]}>
      {buckets.map(([a, b], i) => (
        <View key={i} style={{ flex: 1, justifyContent: 'flex-end', height: H }}>
          <View
            style={{
              position: 'absolute',
              bottom: ((a - lo) / span) * (H - 4),
              height: Math.max(1.5, ((b - a) / span) * (H - 4)),
              width: '100%',
              backgroundColor: props.color,
              borderRadius: 1,
            }}
          />
        </View>
      ))}
    </View>
  );
}

const makeStyles = (tokens: ThemeTokens) => {
  const C = presentationColors(tokens);
  return StyleSheet.create({
    body: { flexDirection: 'row', alignItems: 'flex-end', gap: 1, backgroundColor: tokens.chartBackground, borderRadius: 10, overflow: 'hidden' },
    band: { position: 'absolute', left: 0, right: 0, backgroundColor: tokens.chartBand, borderTopWidth: 1, borderBottomWidth: 1, borderColor: tokens.border },
    axis: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 3 },
    axisText: { fontSize: 10, color: C.faint },
    rateBody: { flexDirection: 'row', alignItems: 'flex-end', gap: 1, backgroundColor: tokens.chartBackground, borderRadius: 10, overflow: 'visible', paddingRight: 6 },
    rateCol: { flex: 1, height: '100%', justifyContent: 'flex-end' },
    dot: { position: 'absolute', right: 0, width: 10, height: 10, borderRadius: 5, backgroundColor: C.oxygen, borderWidth: 2, borderColor: tokens.surface },
    legend: { flexDirection: 'row', justifyContent: 'space-between' },
    legendText: { fontSize: 11, fontWeight: '600' },
    wave: { flexDirection: 'row', gap: 0.5, backgroundColor: tokens.chartBackground, borderRadius: 10, overflow: 'hidden' },
  });
};

import { useTheme } from '../lib/theme/ThemeProvider';
import { presentationColors, type ThemeTokens } from '../lib/theme/tokens';
/**
 * Small shared UI kit: palette, cards, buttons, pills. Plain React Native
 * (no UI library) so the build stays dependency-light.
 */
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

export const C = {
  bg: '#f4f6f8',
  card: '#ffffff',
  ink: '#0f172a',
  sub: '#475569',
  faint: '#94a3b8',
  line: '#e2e8f0',
  brand: '#0f766e', // teal: calm, not alarming
  brandSoft: '#ccfbf1',
  heart: '#e11d48',
  heartSoft: '#ffe4e6',
  oxygen: '#2563eb',
  oxygenSoft: '#dbeafe',
  good: '#16a34a',
  goodSoft: '#dcfce7',
  warn: '#b45309',
  warnSoft: '#fef3c7',
  bad: '#b91c1c',
  badSoft: '#fee2e2',
};

export function Card(props: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const { tokens } = useTheme();
  const s = makeStyles(tokens);
  return <View style={[s.card, props.style]}>{props.children}</View>;
}

export function SectionTitle(props: { children: ReactNode; right?: ReactNode }) {
  const { tokens } = useTheme();
  const s = makeStyles(tokens);
  return (
    <View style={s.sectionRow}>
      <Text style={s.section}>{props.children}</Text>
      {props.right}
    </View>
  );
}

export type Tone = 'good' | 'warn' | 'bad' | 'neutral' | 'brand';
const makeToneColors = (t: ThemeTokens): Record<Tone, [string, string]> => {
const C = presentationColors(t);
return {
  good: [C.good, C.goodSoft],
  warn: [C.warn, C.warnSoft],
  bad: [C.bad, C.badSoft],
  neutral: [C.sub, t.surfaceMuted],
  brand: [C.brand, C.brandSoft],
};
};

export function Pill(props: { tone: Tone; children: ReactNode }) {
  const { tokens } = useTheme();
  const s = makeStyles(tokens);
  const toneColors = makeToneColors(tokens);
  const [fg, bg] = toneColors[props.tone];
  return (
    <View style={[s.pill, { backgroundColor: bg }]}>
      <View style={[s.dot, { backgroundColor: fg }]} />
      <Text style={[s.pillText, { color: fg }]}>{props.children}</Text>
    </View>
  );
}

export function Btn(props: {
  title: string;
  onPress: () => void;
  kind?: 'primary' | 'danger' | 'ghost';
  disabled?: boolean;
  busy?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const { tokens } = useTheme();
  const s = makeStyles(tokens);
  const kind = props.kind ?? 'primary';
  const bg = props.disabled ? tokens.disabledSurface : kind === 'primary' ? tokens.primary : kind === 'danger' ? tokens.dangerButton : 'transparent';
  const fg = props.disabled ? tokens.disabledText : kind === 'ghost' ? tokens.primary : kind === 'danger' ? tokens.onDanger : tokens.onPrimary;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!(props.disabled || props.busy), busy: !!props.busy }}
      disabled={props.disabled || props.busy}
      onPress={props.onPress}
      style={({ pressed }) => [
        s.btn,
        { backgroundColor: bg, opacity: pressed && !props.disabled && !props.busy ? 0.8 : 1 },
        kind === 'ghost' && s.ghost,
        props.style,
      ]}
    >
      {props.busy ? <ActivityIndicator color={fg} /> : <Text style={[s.btnText, { color: fg }]}>{props.title}</Text>}
    </Pressable>
  );
}

/** Two-column label/value row for detail lists. */
export function Row(props: { label: string; value: ReactNode; tone?: Tone }) {
  const { tokens } = useTheme();
  const s = makeStyles(tokens);
  const toneColors = makeToneColors(tokens);
  const color = props.tone ? toneColors[props.tone][0] : tokens.text;
  return (
    <View style={s.row}>
      <Text style={s.rowLabel}>{props.label}</Text>
      {typeof props.value === 'string' || typeof props.value === 'number' ? (
        <Text style={[s.rowValue, { color }]}>{props.value}</Text>
      ) : (
        props.value
      )}
    </View>
  );
}

export const fmtClock = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
export const fmtDuration = (ms: number) => {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}:${String(sec).padStart(2, '0')}`;
};
export const fmtBytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`;
export const fmtNum = (v: number | null | undefined, digits = 0) => (v === null || v === undefined ? '—' : v.toFixed(digits));

const makeStyles = (tokens: ThemeTokens) => {
  const C = presentationColors(tokens);
  return StyleSheet.create({
    card: {
      backgroundColor: C.card,
      borderRadius: 18,
      padding: 16,
      gap: 8,
      shadowColor: tokens.shadow,
      shadowOpacity: 0.06,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 4 },
      elevation: 2,
    },
    sectionRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 },
    section: { fontSize: 13, fontWeight: '700', color: C.sub, letterSpacing: 0.6, textTransform: 'uppercase' },
    pill: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, alignSelf: 'flex-start' },
    dot: { width: 8, height: 8, borderRadius: 4 },
    pillText: { fontSize: 13, fontWeight: '700' },
    btn: { borderRadius: 14, paddingVertical: 15, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center' },
    ghost: { borderWidth: 1, borderColor: tokens.border },
    btnText: { fontSize: 16, fontWeight: '700' },
    row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 3, gap: 12 },
    rowLabel: { fontSize: 14, color: C.sub, flexShrink: 1 },
    rowValue: { fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums'], textAlign: 'right', flexShrink: 1 },
  });
};

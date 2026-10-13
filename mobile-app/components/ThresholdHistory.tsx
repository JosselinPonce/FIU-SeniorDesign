import { useTheme } from '../lib/theme/ThemeProvider';
import { presentationColors, type ThemeTokens } from '../lib/theme/tokens';
/**
 * Settings → how this driver's warning lines have adapted, newest first.
 */
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import * as repo from '../lib/db/repositories';
import type { ThresholdSnapshot } from '../lib/db/repositories';


const REASON: Record<string, string> = {
  drive: 'after a drive',
  ok_answer: 'after "I\'m OK"',
  profile: 'profile loaded',
  reset: 'adjustments reset',
};

export function ThresholdHistory(props: { profileId: string; refreshKey: string }) {
  const { colors: C, tokens } = useTheme();
  const st = makeStyles(tokens);
  const [rows, setRows] = useState<ThresholdSnapshot[] | null>(null);
  useEffect(() => {
    void repo.thresholdHistory(props.profileId, 12).then(setRows);
  }, [props.profileId, props.refreshKey]);
  if (!rows?.length) return <Text style={st.note}>The history fills in as you drive.</Text>;
  const oldest = rows[rows.length - 1]!;
  const newest = rows[0]!;
  return (
    <View style={{ gap: 4 }}>
      <Text style={st.summary}>
        High warning line {oldest.high_warn} → {newest.high_warn} BPM · low {oldest.low_warn} → {newest.low_warn} · now{' '}
        {Math.round(newest.learned * 100)}% learned from your drives
      </Text>
      {rows.map((r) => (
        <View key={r.id} style={st.row}>
          <Text style={st.when}>{new Date(r.at).toLocaleDateString([], { month: 'short', day: 'numeric' })}</Text>
          <Text style={st.what}>
            {r.low_warn}–{r.high_warn} BPM · expected {Math.round(r.mean)}±{Math.round(r.sd)} · {r.drives} drive{r.drives === 1 ? '' : 's'}
          </Text>
          <Text style={st.why}>{REASON[r.reason] ?? r.reason}</Text>
        </View>
      ))}
    </View>
  );
}

const makeStyles = (tokens: ThemeTokens) => {
  const C = presentationColors(tokens);
  return StyleSheet.create({
    note: { fontSize: 13, color: C.sub },
    summary: { fontSize: 13, color: C.ink, fontWeight: '600', marginBottom: 4 },
    row: { flexDirection: 'row', gap: 8, alignItems: 'baseline' },
    when: { width: 52, fontSize: 12, color: C.faint, fontVariant: ['tabular-nums'] },
    what: { flex: 1, fontSize: 12, color: C.ink, fontVariant: ['tabular-nums'] },
    why: { fontSize: 11, color: C.sub },
  });
};

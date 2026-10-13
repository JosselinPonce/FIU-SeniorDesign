import { InformationButton } from './Information';
import { useTheme } from '../lib/theme/ThemeProvider';
import { presentationColors, type ThemeTokens } from '../lib/theme/tokens';
/**
 * Settings → Calibrate against a reference device (lib/analysis/calibration.ts).
 */
import { useState } from 'react';
import { Text, TextInput, View, StyleSheet } from 'react-native';

import type { useDriveSession } from '../lib/hooks/useDriveSession';
import { CAL_MAX_HR, CAL_SECONDS, accumulate, computeCalibration } from '../lib/analysis/calibration';
import * as repo from '../lib/db/repositories';
import { Btn, Card, Row, SectionTitle } from './ui';

type Drive = ReturnType<typeof useDriveSession>;

export function CalibrationCard(props: { drive: Drive }) {
  const { colors: C, tokens } = useTheme();
  const st = makeStyles(tokens);
  const d = props.drive;
  const [phase, setPhase] = useState<'idle' | 'measuring' | 'enter'>('idle');
  const [wheel, setWheel] = useState<{ bpm: number[]; spo2: number[] } | null>(null);
  const [refBpm, setRefBpm] = useState('');
  const [refSpo2, setRefSpo2] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const cal = d.driver;
  const hasCal = cal && (cal.cal_hr != null || cal.cal_spo2 != null);

  return (
    <Card>
      <SectionTitle>Calibrate with a reference device</SectionTitle>
      <Text style={st.note}>Use a clip-on pulse oximeter or chest strap as a reference. Rest a finger on the wheel sensor, sit still for {CAL_SECONDS} seconds, then enter the reference average. Oxygen is compared, never corrected.</Text>
      <InformationButton title="Calibration details" body={`The heart-rate difference becomes a small personal correction (at most ±${CAL_MAX_HR} BPM), averaged over every session you do. A few sessions on different days is best; agreement studies use about 100 paired readings. A home oximeter is not accurate enough to calibrate oxygen against.`} />
      {hasCal ? (
        <>
          <Row label="Heart-rate correction" value={cal!.cal_hr ? `${cal!.cal_hr > 0 ? '+' : ''}${cal!.cal_hr} BPM` : '—'} tone="brand" />
          <Row label="Calibrated" value={cal!.cal_at ? new Date(cal!.cal_at).toLocaleDateString() : '—'} />
        </>
      ) : null}
      {phase === 'idle' ? (
        <Btn
          title={hasCal ? 'Calibrate again' : 'Start 60-second measurement'}
          kind="ghost"
          disabled={!d.isConnected || !cal}
          onPress={async () => {
            setMsg(null);
            setPhase('measuring');
            setWheel(await d.measureCalibration());
            setPhase('enter');
          }}
        />
      ) : null}
      {phase === 'measuring' ? (
        <Text style={[st.note, { color: C.warn }]}>
          Measuring… keep still, finger flat on the sensor. Clean seconds so far: {d.signal?.good ? '✓ signal good' : 'waiting for a clean signal'}.
        </Text>
      ) : null}
      {phase === 'enter' && wheel ? (
        <View style={{ gap: 8 }}>
          <Text style={st.note}>
            The wheel measured {wheel.bpm.length} clean seconds. Enter the reference's average:
          </Text>
          <TextInput style={st.input} placeholder="Reference heart rate (BPM)" keyboardType="number-pad" value={refBpm} onChangeText={setRefBpm} placeholderTextColor={C.faint} />
          <TextInput style={st.input} placeholder="Reference oxygen % (optional)" keyboardType="number-pad" value={refSpo2} onChangeText={setRefSpo2} placeholderTextColor={C.faint} />
          <Btn
            title="Save calibration"
            onPress={async () => {
              const r = computeCalibration(wheel, { bpm: Number(refBpm), spo2: refSpo2.trim() ? Number(refSpo2) : null });
              if (!Number(refBpm)) return setMsg('Enter the reference heart rate.');
              if (!r.ok) {
                setMsg(r.reason);
                setPhase('idle');
                return;
              }
              const key = `caln:${cal!.id}`;
              const prevN = Number((await repo.getSetting(key)) ?? 0);
              const acc = accumulate({ hr: cal!.cal_hr ?? null, n: prevN }, { hr: r.hr, n: r.n });
              await repo.setSetting(key, String(acc.n));
              await d.saveCalibration(acc.hr, null);
              setMsg(
                `Saved. This session: wheel ${r.wheelBpm.toFixed(0)} vs reference ${refBpm} BPM (${r.mape.toFixed(1)}% apart). ` +
                  `Correction now ${acc.hr > 0 ? '+' : ''}${acc.hr} BPM from ${acc.n} clean seconds.` +
                  (r.spo2 !== null ? ` Oxygen differed by ${r.spo2 > 0 ? '+' : ''}${r.spo2}% (shown for reference, not applied).` : ''),
              );
              setPhase('idle');
              setRefBpm('');
              setRefSpo2('');
            }}
          />
          <Btn title="Cancel" kind="ghost" onPress={() => setPhase('idle')} />
        </View>
      ) : null}
      {hasCal && phase === 'idle' ? (
        <Btn
          title="Remove calibration"
          kind="ghost"
          onPress={async () => {
            await repo.setSetting(`caln:${cal!.id}`, '0');
            await d.saveCalibration(null, null);
          }}
        />
      ) : null}
      {msg ? <Text style={st.note}>{msg}</Text> : null}
    </Card>
  );
}

const makeStyles = (tokens: ThemeTokens) => {
  const C = presentationColors(tokens);
  return StyleSheet.create({
    note: { fontSize: 13, color: C.sub, lineHeight: 18 },
    input: { borderWidth: 1, borderColor: C.line, borderRadius: 12, padding: 12, fontSize: 16, color: C.ink, backgroundColor: tokens.surface },
  });
};

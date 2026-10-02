/**
 * The in-car screen: is everything connected, what are the vitals, is data
 * flowing, and one big start/stop button. Technical detail lives in Settings.
 */
import { Linking, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { useDriveSession } from '../lib/hooks/useDriveSession';
import { CHART_SECONDS } from '../lib/hooks/useDriveSession';
import { Btn, C, Card, Pill, Row, SectionTitle, fmtBytes, fmtClock, fmtDuration, fmtNum, type Tone } from './ui';
import { RateDot, VitalChart } from './charts';
import { PERFUSION_HINT } from '../lib/analysis/signal';

type Drive = ReturnType<typeof useDriveSession>;

const ALERT_TEXT: Record<string, string> = {
  bpm_high: 'Your heart rate has been unusually high',
  bpm_low: 'Your heart rate has been unusually low',
  spo2_low: 'Your oxygen level has been low',
};
const WATCH_TEXT: Record<string, string> = {
  bpm_high: 'Heart rate is high — checking the next few seconds',
  bpm_low: 'Heart rate is low — checking the next few seconds',
  spo2_low: 'Oxygen is low — checking the next few seconds',
};
const OUTCOME_TEXT: Record<string, string> = {
  ok: 'you said you were OK',
  not_ok: 'you said you were not OK',
  no_response: 'no answer — emergency recorded',
};

/** Phone → Pi → wheel sensor, each hop with its own state. */
function Chain(props: { drive: Drive }) {
  const d = props.drive;
  const now = Date.now();
  const fresh = d.lastRx !== null && now - d.lastRx.getTime() < 3000;
  const piOk = d.isConnected;
  const espOk = piOk && (d.link?.source === 'esp32' || d.relay?.esp === true);
  const hop = (ok: boolean, label: string, detail: string) => (
    <View style={st.hop}>
      <View style={[st.hopDot, { backgroundColor: ok ? C.good : C.faint }]} />
      <Text style={[st.hopLabel, !ok && { color: C.faint }]}>{label}</Text>
      <Text style={st.hopDetail} numberOfLines={1}>
        {detail}
      </Text>
    </View>
  );
  const searching =
    d.connection === 'scanning' || d.connection === 'connecting' || d.connection === 'discovering' || d.connection === 'waiting';
  return (
    <Card>
      <View style={st.chain}>
        {hop(true, 'Phone', d.live?.ok === false ? 'offline' : 'online')}
        <View style={[st.link, { backgroundColor: piOk ? C.good : C.line }]} />
        {hop(piOk, 'Pi', piOk ? 'connected' : searching ? 'searching…' : 'not found')}
        <View style={[st.link, { backgroundColor: espOk ? C.good : C.line }]} />
        {hop(espOk && fresh, 'Wheel', espOk ? (fresh ? 'streaming' : 'quiet') : 'waiting')}
      </View>
      {d.error && !piOk ? <Text style={st.subtle}>{d.error}</Text> : null}
      {d.notice ? <Text style={[st.subtle, { color: C.warn }]}>{d.notice}</Text> : null}
    </Card>
  );
}

function VitalTile(props: { label: string; value: number | null; unit: string; avg: number | null; color: string; soft: string }) {
  return (
    <View style={[st.tile, { backgroundColor: props.soft }]}>
      <Text style={[st.tileLabel, { color: props.color }]}>{props.label}</Text>
      <Text style={[st.tileValue, { color: props.value === null ? C.faint : props.color }]} accessibilityLiveRegion="polite">
        {props.value ?? '--'}
      </Text>
      <Text style={st.tileUnit}>
        {props.unit} · avg {fmtNum(props.avg)}
      </Text>
    </View>
  );
}

export function DriveView(props: { drive: Drive; busy: boolean; guard: (fn: () => Promise<unknown>) => void }) {
  const d = props.drive;
  const now = Date.now();

  const signal: { tone: Tone; text: string } = !d.lastRx
    ? { tone: 'neutral', text: 'Waiting for the wheel' }
    : now - d.lastRx.getTime() > 3000
      ? { tone: 'warn', text: 'Wheel went quiet' }
      : !d.finger
        ? { tone: 'warn', text: 'Place your hand on the sensor' }
        : d.bpm === null
          ? { tone: 'brand', text: 'Reading your pulse…' }
          : { tone: 'good', text: 'Good signal' };

  const sf = d.safety;
  const th = sf.th;
  // The shaded "usual" zone on the chart: personal band ± 2 SD, inside the warning lines.
  const usual =
    sf.band && th
      ? { low: Math.max(th.lowWarn, sf.band.mean - 2 * sf.band.sd), high: Math.min(th.highWarn, sf.band.mean + 2 * sf.band.sd) }
      : null;

  return (
    <ScrollView contentContainerStyle={st.container}>
      <Chain drive={d} />

      <Card>
        <View style={st.between}>
          <Pill tone={signal.tone}>{signal.text}</Pill>
          {d.finger && d.signal?.hrBeats != null ? (
            <Text style={[st.subtle, { color: d.signal.good ? C.good : C.warn }]}>
              {d.signal.good
                ? 'clean pulse ✓'
                : d.signal.agree === false
                  ? 'readings disagree'
                  : d.signal.perfusion !== null && d.signal.perfusion < PERFUSION_HINT
                    ? 'weak pulse — press flatter'
                    : 'movement — hold steady'}
            </Text>
          ) : d.quality !== null && d.finger ? (
            <Text style={st.subtle}>quality {d.quality}%</Text>
          ) : null}
        </View>
        <View style={st.tiles}>
          <VitalTile label="Heart rate" value={d.bpm} unit="BPM" avg={d.avgBpm} color={C.heart} soft={C.heartSoft} />
          <VitalTile label="Oxygen (estimate)" value={d.spo2} unit="% SpO₂" avg={d.avgSpo2} color={C.oxygen} soft={C.oxygenSoft} />
        </View>
        {sf.demo ? (
          <View style={[st.watch, { backgroundColor: C.brandSoft }]}>
            <Text style={[st.watchText, { color: C.brand }]}>
              DEMO · fabricated {sf.demo.value}
              {sf.demo.scenario === 'spo2' ? '%' : ' BPM'} · {sf.demo.step}
            </Text>
          </View>
        ) : null}
        {sf.tracking ? (
          <View style={st.watch} accessibilityLiveRegion="polite">
            <Text style={st.watchText}>{WATCH_TEXT[sf.tracking.kind] ?? 'Checking…'}</Text>
          </View>
        ) : null}
        {th && sf.band ? (
          <Text style={st.subtle}>
            Watching for heart rate below {th.lowWarn} or above {th.highWarn} BPM, oxygen below {th.spo2Warn + 1}%.{' '}
            {sf.band.weight >= 0.5
              ? 'Tuned to your own drives.'
              : sf.band.weight > 0
                ? 'Learning your normal from your drives.'
                : 'Based on your profile (age, sex, BMI, conditions).'}
          </Text>
        ) : null}
        <SectionTitle>Heart rate · last {CHART_SECONDS / 60} min</SectionTitle>
        <VitalChart points={d.bpmSeries} seconds={CHART_SECONDS} color={C.heart} min={40} max={160} band={usual} />
        <SectionTitle>Oxygen · last {CHART_SECONDS / 60} min</SectionTitle>
        <VitalChart points={d.spo2Series} seconds={CHART_SECONDS} color={C.oxygen} min={85} max={100} height={52} />
      </Card>

      <Card>
        <SectionTitle>Drive</SectionTitle>
        {!d.hasActiveSession ? (
          <>
            <Text style={st.body}>
              {d.storageMode === 'full'
                ? 'Saving vitals + full waveform (folded into a compact archive when you finish).'
                : 'Saving vitals only (heart rate and oxygen each second).'}{' '}
              Change this in Settings.
            </Text>
            <Btn
              title={d.isConnected ? 'Start drive' : 'Start drive (waiting for the Pi)'}
              disabled={!d.isConnected}
              busy={props.busy}
              onPress={() => props.guard(d.startSession)}
            />
          </>
        ) : (
          <>
            <Row label="Recording since" value={d.session ? fmtClock(new Date(d.session.started_at)) : '—'} />
            <Row label="Duration" value={d.session ? fmtDuration(now - new Date(d.session.started_at).getTime()) : '—'} />
            <Row label="Readings saved" value={String(d.stored)} />
            <Row
              label="Live on the dashboard"
              value={
                d.live?.ok === false
                  ? 'queued (offline)'
                  : d.live?.lastPushAt
                    ? `${Math.max(0, Math.round((now - d.live.lastPushAt.getTime()) / 1000))} s ago`
                    : 'starting…'
              }
              tone={d.live?.ok === false ? 'warn' : 'good'}
            />
            <Btn title="End drive" kind="danger" busy={props.busy} onPress={() => props.guard(d.endSession)} />
          </>
        )}
        {!d.hasActiveSession && d.fold.state === 'folding' ? <Text style={st.body}>Folding the waveform archive…</Text> : null}
        {!d.hasActiveSession && d.fold.state === 'done' ? (
          <Text style={st.body}>
            Waveform folded: {d.fold.info.sample_count.toLocaleString()} samples → {fmtBytes(d.fold.info.packed_bytes)} (×
            {(d.fold.info.raw_bytes / d.fold.info.packed_bytes).toFixed(1)} smaller, verified).{' '}
            {d.live?.archive === 'uploaded' ? 'Backed up to the cloud.' : d.live?.archive === 'failed' ? 'Cloud backup will retry.' : ''}
          </Text>
        ) : null}
        {d.fold.state === 'failed' ? <Text style={[st.body, { color: C.bad }]}>Archive not created: {d.fold.error}. Raw data kept.</Text> : null}
        {sf.last ? (
          <Text style={[st.body, { color: sf.last.result.outcome === 'ok' ? C.sub : C.bad }]}>
            Last check at {fmtClock(sf.last.at)}: {OUTCOME_TEXT[sf.last.result.outcome]}
            {sf.last.result.channel === 'voice' ? ' (by voice)' : sf.last.result.channel === 'button' ? ' (button)' : ''}.
          </Text>
        ) : null}
        {sf.last?.handoff ? <Text style={st.body}>{
          sf.last.handoff === 'opened' ? 'Phone interface opened for the saved emergency contact. Call connection is not confirmed.'
          : sf.last.handoff === 'missing_contact' ? 'No emergency contact number is saved. No phone interface was opened.'
          : sf.last.handoff === 'invalid_phone' ? 'The saved emergency contact number is invalid. Update the driver profile.'
          : sf.last.handoff === 'open_failed' ? 'Could not open the phone interface. Use the call buttons below or your phone.'
          : 'Automatic phone handoff was cancelled.'
        }</Text> : null}
        {sf.last?.result.contactCall === 'declined_offer' ? <Text style={st.body}>You declined the phone handoff.</Text> : null}
        {sf.last?.result.contactCall === 'unconfirmed_offer' ? <Text style={st.body}>No clear call consent was received. The phone interface was not opened.</Text> : null}
        {sf.last && sf.last.result.outcome !== 'ok' ? (
          <View style={st.callRow}>
            {d.driver?.emergency_phone ? (
              <Btn
                title={`Call ${d.driver.emergency_name || 'emergency contact'}`}
                onPress={() => void Linking.openURL(`tel:${d.driver!.emergency_phone!.replace(/[^\d+]/g, '')}`)}
                style={{ flex: 1 }}
              />
            ) : null}
            <Btn title="Call 911" kind="danger" onPress={() => void Linking.openURL('tel:911')} style={{ flex: 1 }} />
          </View>
        ) : null}
        {d.trend && d.trend.status === 'elevated' ? (
          <Text style={[st.body, { color: C.warn }]}>
            Your typical heart rate while driving this week is {d.trend.delta} BPM above your usual ({Math.round(d.trend.recent)} vs{' '}
            {Math.round(d.trend.usual)}). Illness, poor sleep, stress, caffeine or a new medication can all do this. If it
            continues or you feel unwell, consider checking with a doctor. Not a diagnosis.
          </Text>
        ) : null}
        {sf.advisory ? (
          <Text style={[st.body, { color: C.warn }]}>
            An irregular pulse pattern was noticed during this drive. This is not a diagnosis — if you see it again, consider
            mentioning it to a doctor.
          </Text>
        ) : null}
        {d.voice && !d.voice.granted ? (
          <Text style={st.body}>Voice check is off (microphone or speech not allowed). Checks will use the on-screen buttons.</Text>
        ) : null}
      </Card>

      <Card>
        <SectionTitle right={d.sampleRate ? <Text style={st.subtle}>{d.samplesPerPacket} samples/packet @ {d.sampleRate} Hz</Text> : null}>
          Data flow
        </SectionTitle>
        <RateDot series={d.rateSeries} />
      </Card>

    </ScrollView>
  );
}

/** The voice-check prompt. Rendered by the app shell so it appears on every tab. */
export function VoiceCheckModal(props: { drive: Drive }) {
  const d = props.drive;
  const sf = d.safety;
  const offer = sf.check?.question === 'contact_offer';
  return (
    <Modal visible={sf.check !== null} transparent animationType="fade">
        <View style={st.scrim}>
          <View style={st.alertBox}>
            <Text style={st.alertTitle}>{offer ? 'Would you like me to call your emergency contact?' : 'Are you feeling OK?'}</Text>
            <Text style={st.alertBody}>
              {sf.check ? ALERT_TEXT[sf.check.episode.kind] : ''} ({sf.check ? Math.round(sf.check.episode.value) : ''}
              {sf.check?.episode.kind === 'spo2_low' ? '%' : ' BPM'}).
            </Text>
            <View style={st.phase}>
              <View style={[st.phaseDot, { backgroundColor: sf.check?.phase === 'listening' ? C.heart : C.brand }]} />
              <Text style={st.phaseText}>
                {sf.check?.phase === 'listening' ? 'Listening — just say "yes" or "no"' : 'Speaking…'}
              </Text>
            </View>
            <Text style={st.alertHint}>
              You can answer out loud or tap below. The phone interface opens only after a call request or agreement.
              Simulated vitals demos never open it. If you need emergency help, pull over safely and call 911.
            </Text>
            <Btn title={offer ? "Open phone interface" : "I'm OK"} onPress={() => d.respondAlert(offer ? 'call_yes' : 'ok')} />
            <Pressable onPress={() => d.respondAlert(offer ? 'call_no' : 'not_ok')} style={st.unwell} accessibilityRole="button">
              <Text style={st.unwellText}>{offer ? "No thanks" : "I'm not OK"}</Text>
            </Pressable>
          </View>
        </View>
    </Modal>
  );
}

const st = StyleSheet.create({
  container: { padding: 16, gap: 14, paddingBottom: 40 },
  chain: { flexDirection: 'row', alignItems: 'center' },
  hop: { alignItems: 'center', width: 78 },
  hopDot: { width: 14, height: 14, borderRadius: 7, marginBottom: 4 },
  hopLabel: { fontSize: 14, fontWeight: '700', color: C.ink },
  hopDetail: { fontSize: 11, color: C.sub },
  link: { flex: 1, height: 3, borderRadius: 2, marginBottom: 30 },
  between: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  tiles: { flexDirection: 'row', gap: 10 },
  tile: { flex: 1, borderRadius: 16, padding: 14, alignItems: 'center' },
  tileLabel: { fontSize: 13, fontWeight: '700' },
  tileValue: { fontSize: 56, fontWeight: '800', lineHeight: 64, fontVariant: ['tabular-nums'] },
  tileUnit: { fontSize: 12, color: C.sub },
  subtle: { fontSize: 12, color: C.sub },
  body: { fontSize: 14, color: C.sub, lineHeight: 20 },
  scrim: { flex: 1, backgroundColor: 'rgba(15,23,42,0.55)', justifyContent: 'center', padding: 24 },
  alertBox: { backgroundColor: '#fff', borderRadius: 24, padding: 22, gap: 12 },
  alertTitle: { fontSize: 24, fontWeight: '800', color: C.ink },
  alertBody: { fontSize: 16, color: C.ink, lineHeight: 22 },
  alertHint: { fontSize: 12, color: C.sub },
  callRow: { flexDirection: 'row', gap: 10 },
  watch: { backgroundColor: C.warnSoft, borderRadius: 12, padding: 10 },
  watchText: { color: C.warn, fontWeight: '700', fontSize: 14 },
  phase: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  phaseDot: { width: 12, height: 12, borderRadius: 6 },
  phaseText: { fontSize: 15, fontWeight: '600', color: C.ink },
  unwell: { paddingVertical: 14, alignItems: 'center', borderRadius: 14, backgroundColor: C.badSoft },
  unwellText: { color: C.bad, fontWeight: '700', fontSize: 16 },
});

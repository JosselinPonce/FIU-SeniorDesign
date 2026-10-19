import { useEffect, useRef, useState } from 'react';
import { CompactVitalCard } from './CompactVitalCard';
import { InformationButton } from './Information';
import { useTheme } from '../lib/theme/ThemeProvider';
import { presentationColors, type ThemeTokens } from '../lib/theme/tokens';
/**
 * The in-car screen: is everything connected, what are the vitals, is data
 * flowing, and one big start/stop button. Technical detail lives in Settings.
 */
import { Linking, Modal, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import type { useDriveSession } from '../lib/hooks/useDriveSession';
import { CHART_SECONDS } from '../lib/hooks/useDriveSession';
import { Btn, Card, Pill, Row, SectionTitle, fmtBytes, fmtClock, fmtDuration, fmtNum, type Tone } from './ui';
import { RateDot } from './charts';
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
  const { colors: C, tokens } = useTheme();
  const st = makeStyles(tokens);
  const d = props.drive;
  const now = Date.now();
  const fresh = d.lastRx !== null && now >= d.lastRx.getTime() && now - d.lastRx.getTime() < 3000;
  const direct = d.isConnected && d.link?.source === 'esp32';
  const piOk = d.isConnected && d.link?.source === 'relay';
  const espOk = direct || (piOk && d.relay?.esp === true);
  const hop = (ok: boolean, label: string, detail: string) => (
    <View style={st.hop}>
      <View accessible={false} style={{ width: 18, height: 18, borderWidth: 2, borderColor: ok ? tokens.connected : tokens.textMuted, borderRadius: label === 'Wheel' ? 9 : 3, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ fontSize: 10, lineHeight: 12, color: ok ? tokens.connected : tokens.textMuted }}>{label === 'Wheel' ? '┼' : label === 'Phone' ? '·' : '▦'}</Text>
      </View>
      <Text style={[st.hopLabel, !ok && { color: C.faint }]}>{label}</Text>
      <Text style={st.hopDetail}>
        {detail}
      </Text>
    </View>
  );
  const searching =
    d.connection === 'scanning' || d.connection === 'connecting' || d.connection === 'discovering' || d.connection === 'waiting';
  return (
    <Card style={{ padding: 12, gap: 2 }}>
      <View style={st.chain}>
        {hop(espOk && fresh, 'Wheel', espOk ? (fresh ? 'streaming' : 'quiet') : 'waiting')}
        <Text accessible={false} style={{ color: tokens.textMuted, paddingHorizontal: 5 }}>→</Text>
        {hop(piOk, 'Raspberry Pi', direct ? 'bypassed (direct)' : piOk ? 'connected' : searching ? 'searching…' : 'not found')}
        <Text accessible={false} style={{ color: tokens.textMuted, paddingHorizontal: 5 }}>→</Text>
        {hop(d.isConnected && (piOk || direct), 'Phone', d.isConnected && (piOk || direct) ? 'BLE connected' : 'app ready')}
      <InformationButton compact title="Connectivity" body="The wheel sends readings through the Raspberry Pi to this phone. In direct ESP32 bench mode, the Pi is bypassed. App readiness does not confirm an internet connection; cloud synchronization is reported separately." />
      </View>

      {d.error && !piOk ? <Text style={st.subtle}>{d.error}</Text> : null}
      {d.notice ? <Text style={[st.subtle, { color: C.warn }]}>{d.notice}</Text> : null}
    </Card>
  );
}

export function DriveView(props: { drive: Drive; busy: boolean; guard: (fn: () => Promise<unknown>) => void; onOpenVitals(): void; onVitalsAnchor?(anchor: { y: number; height: number }): void }) {
  const { colors: C, tokens } = useTheme();
  const st = makeStyles(tokens);
  const d = props.drive;
  const [details, setDetails] = useState(true);
  useEffect(() => { setDetails(true); }, [d.driver?.id]);
  const heading = useRef({ y: 0, height: 58 });
  const scrollOffset = useRef(0);
  const reportHeading = () => props.onVitalsAnchor?.({ y: heading.current.y - scrollOffset.current, height: heading.current.height });
  const now = Date.now();
  const { width, fontScale } = useWindowDimensions();

  const signal: { tone: Tone; text: string } = !d.lastRx
    ? { tone: 'neutral', text: 'Waiting for the wheel' }
    : !d.isConnected || now < d.lastRx.getTime() || now - d.lastRx.getTime() >= 3000
      ? { tone: 'warn', text: 'Wheel went quiet' }
      : !d.finger
        ? { tone: 'warn', text: 'Place your hand on the sensor' }
        : d.bpm === null
          ? { tone: 'brand', text: 'Reading your pulse…' }
          : { tone: 'good', text: 'Good signal' };

  const sf = d.safety;
  const th = sf.th;
  const hasDriveDetails = (!d.hasActiveSession && (d.fold.state === 'folding' || d.fold.state === 'done'))
    || d.fold.state === 'failed' || !!sf.last || d.trend?.status === 'elevated' || !!sf.advisory
    || (!!d.voice && !d.voice.granted);
  // The shaded "usual" zone on the chart: personal band ± 2 SD, inside the warning lines.
  const usual =
    sf.band && th
      ? { low: Math.max(th.lowWarn, sf.band.mean - 2 * sf.band.sd), high: Math.min(th.highWarn, sf.band.mean + 2 * sf.band.sd) }
      : null;

  return (
    <ScrollView contentContainerStyle={st.container} scrollEventThrottle={32}
      onScroll={({ nativeEvent }) => { scrollOffset.current = nativeEvent.contentOffset.y; reportHeading(); }}>
      <Chain drive={d} />
      <View style={{ gap: 8, paddingHorizontal: 2 }}>
        {!d.hasActiveSession ? (
          <>
            <Btn
              title={d.isConnected ? 'Start drive' : 'Start drive (waiting for the Pi)'}
              disabled={!d.isConnected}
              busy={props.busy}
              onPress={() => props.guard(d.startSession)}
            />
            <Text style={st.subtle}>Not recording</Text>
          </>
        ) : (
          <>
            <Btn title="End drive" kind="danger" busy={props.busy} onPress={() => props.guard(d.endSession)} />
            <Text style={st.subtle}>Recording · {d.session ? fmtDuration(now - new Date(d.session.started_at).getTime()) : '—'} · {d.stored} readings saved</Text>
          </>
        )}
      </View>

      <Text accessibilityRole="header" style={{ color: tokens.text, fontSize: 19, fontWeight: '700' }}
        onLayout={({ nativeEvent: { layout } }) => { heading.current = { y: layout.y, height: layout.height }; reportHeading(); }}>Live Vitals</Text>
      <View style={{ gap: 6, paddingHorizontal: 2 }}>
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
        {sf.demo ? (
          <View style={[st.watch, { backgroundColor: C.brandSoft }]}>
            <Text style={[st.watchText, { color: C.brand }]}>
              DEMO · fabricated {sf.demo.value}
              {sf.demo.scenario === 'spo2' ? '%' : ' BPM'} · {sf.demo.step}
            </Text>
            <Text style={st.subtle}>Cards show sensor data. The simulated warning reading is separate.</Text>
          </View>
        ) : null}
        {sf.tracking ? (
          <View style={st.watch} accessibilityLiveRegion="polite">
            <Text style={st.watchText}>{WATCH_TEXT[sf.tracking.kind] ?? 'Checking…'}</Text>
          </View>
        ) : null}

      </View>

      <View style={[st.tiles, (width < 320 || fontScale > 1.4) && { flexDirection: 'column' }]}>
        <CompactVitalCard metric="heart" label="Heart Rate" value={d.bpm} unit="BPM" average={d.avgBpm} points={d.bpmSeries}
          connected={d.isConnected} lastRx={d.lastRx} now={now} seconds={CHART_SECONDS} min={40} max={160} band={usual} warningBounds={th ? { low: th.lowWarn, high: th.highWarn } : undefined} />
        <CompactVitalCard metric="oxygen" label="SpO₂ (estimate)" value={d.spo2} unit="%" average={d.avgSpo2} points={d.spo2Series}
          connected={d.isConnected} lastRx={d.lastRx} now={now} seconds={CHART_SECONDS} min={85} max={100} warningBounds={th ? { low: th.spo2Warn } : undefined} />
      </View>
      <Btn title="View Detailed Vitals" kind="ghost" onPress={props.onOpenVitals} />
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: details }} onPress={() => setDetails(value => !value)} style={{ minHeight: 44, justifyContent: 'center' }}>
        <Text style={{ color: tokens.textSecondary, fontWeight: '600' }}>{details ? '−' : '+'} Monitoring details</Text>
      </Pressable>
      {details ? <Card>
            <Row label="Recording since" value={d.session ? fmtClock(new Date(d.session.started_at)) : '—'} />
            <Row label="Duration" value={d.session ? fmtDuration(now - new Date(d.session.started_at).getTime()) : '—'} />
            <Row label="Readings saved" value={String(d.stored)} />
            <Row
              label="Cloud sync"
              value={
                d.live?.ok === false
                  ? 'queued (offline)'
                  : d.live?.lastPushAt
                    ? `${Math.max(0, Math.round((now - d.live.lastPushAt.getTime()) / 1000))} s ago`
                    : 'awaiting first upload'
              }
              tone={d.live?.ok === false ? 'warn' : 'neutral'}
            />
        {!d.hasActiveSession ? (
          <Text style={st.body}>
              {d.storageMode === 'full'
                ? 'Not recording. Starting a drive saves vitals + full waveform (folded into a compact archive when you finish).'
                : 'Not recording. Starting a drive saves heart rate and oxygen each second.'}{' '}
              Change this in Settings.
          </Text>
        ) : null}
        <InformationButton title="Personalized vitals" body="Your profile provides the starting range. As you accumulate drives, the range learns your usual readings. The shaded heart-rate band shows your usual range within the warning thresholds. Missing chart values are gaps, not zero readings." />
        <SectionTitle right={d.sampleRate ? <Text style={st.subtle}>{d.samplesPerPacket} samples/packet @ {d.sampleRate} Hz</Text> : null}>Data flow</SectionTitle>
        <RateDot series={d.rateSeries} />
      </Card> : null}
      {hasDriveDetails ? <Card>
        <SectionTitle>Drive details</SectionTitle>
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
      </Card> : null}

    </ScrollView>
  );
}

/** The voice-check prompt. Rendered by the app shell so it appears on every tab. */
export function VoiceCheckModal(props: { drive: Drive }) {
  const { colors: C, tokens } = useTheme();
  const st = makeStyles(tokens);
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

const makeStyles = (tokens: ThemeTokens) => {
  const C = presentationColors(tokens);
  return StyleSheet.create({
    container: { padding: 14, gap: 12, paddingBottom: 40 },
    chain: { flexDirection: 'row', alignItems: 'center' },
    hop: { alignItems: 'center', flex: 1 },
    hopDot: { width: 8, height: 8, borderRadius: 4, marginBottom: 4 },
    hopLabel: { textAlign: 'center', fontSize: 12, fontWeight: '700', color: C.ink },
    hopDetail: { fontSize: 11, color: C.sub, textAlign: 'center' },
    between: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between', alignItems: 'center' },
    tiles: { flexDirection: 'row', gap: 10 },
    subtle: { fontSize: 12, color: C.sub },
    body: { fontSize: 14, color: C.sub, lineHeight: 20 },
    scrim: { flex: 1, backgroundColor: tokens.overlay, justifyContent: 'center', padding: 24 },
    alertBox: { backgroundColor: tokens.surface, borderRadius: 24, padding: 22, gap: 12 },
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
};

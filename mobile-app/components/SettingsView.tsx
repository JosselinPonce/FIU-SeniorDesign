/**
 * Storage choice, cloud backlog, and the technical link details that used to
 * crowd the drive screen.
 */
import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import type { useDriveSession } from '../lib/hooks/useDriveSession';
import type { StorageMode } from '../lib/db/repositories';
import { pendingCount, syncToSupabase } from '../lib/db/sync';
import { wipeEverything } from '../lib/db/deletion';
import { Btn, C, Card, Row, SectionTitle, fmtClock, fmtDuration } from './ui';
import { VoicePicker } from './VoicePicker';
import { CalibrationCard } from './CalibrationCard';
import { ThresholdHistory } from './ThresholdHistory';

type Drive = ReturnType<typeof useDriveSession>;

const MODES: { key: StorageMode; title: string; body: string }[] = [
  {
    key: 'vitals',
    title: 'Vitals only (recommended)',
    body:
      'Heart rate and oxygen once per second. This is the project proposal\'s data policy: keep processed values, not raw sensor signals.',
  },
  {
    key: 'full',
    title: 'Vitals + full waveform',
    body:
      'Also keeps every raw sensor sample (100 per second) for research. When the drive ends it is folded into a compact, checksummed archive — about 4× smaller, and it unfolds exactly — then backed up to the cloud. Use only with the driver\'s consent.',
  },
];

export function SettingsView(props: {
  drive: Drive;
  autoOn: boolean;
  setAutoOn: (v: boolean) => void;
  onWiped: () => Promise<void>;
  onShowIntro: () => void;
}) {
  const d = props.drive;
  const [direct, setDirect] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [rehearsal, setRehearsal] = useState<string | null>(null);
  const [demoResult, setDemoResult] = useState<string | null>(null);
  const describe = (r: { outcome: string; urgent: boolean; channel: string } | null) =>
    !r
      ? 'The readings never confirmed an emergency.'
      : r.outcome === 'no_response'
        ? 'No answer heard — in a real drive this counts as an emergency (simulated escalation).'
        : `Understood: ${r.outcome === 'ok' ? 'you are OK' : 'you are NOT OK'}${r.urgent ? ' (urgent words heard)' : ''} — via ${r.channel}.`;
  const sf = d.safety;
  const now = Date.now();

  async function uploadBacklog() {
    setSyncing(true);
    try {
      const p = await pendingCount();
      if (p.sessions === 0) {
        setSyncMsg('Everything is already in the cloud.');
        return;
      }
      setSyncMsg(`Uploading ${p.sessions} drive(s)…`);
      const r = await syncToSupabase();
      setSyncMsg(r.errors.length ? `Couldn't reach the cloud: ${r.errors[0]}` : `Uploaded ${r.sessions} drive(s), ${r.events} readings.`);
    } finally {
      setSyncing(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={st.container}>
      <Card>
        <SectionTitle>What to save</SectionTitle>
        {MODES.map((m) => (
          <Pressable
            key={m.key}
            accessibilityRole="radio"
            accessibilityState={{ selected: d.storageMode === m.key, disabled: d.hasActiveSession }}
            disabled={d.hasActiveSession}
            onPress={() => void d.setStorageMode(m.key)}
            style={[st.mode, d.storageMode === m.key && st.modeOn, d.hasActiveSession && { opacity: 0.6 }]}
          >
            <View style={[st.radio, d.storageMode === m.key && st.radioOn]} />
            <View style={{ flex: 1, gap: 3 }}>
              <Text style={st.modeTitle}>{m.title}</Text>
              <Text style={st.modeBody}>{m.body}</Text>
            </View>
          </Pressable>
        ))}
        {d.hasActiveSession ? <Text style={st.note}>Applies from the next drive.</Text> : null}
      </Card>

      <Card>
        <SectionTitle>Safety checks</SectionTitle>
        {sf.th && sf.prior ? (
          <>
            <Row label="Warning if heart rate above" value={`${sf.th.highWarn} BPM`} />
            <Row label="Warning if heart rate below" value={`${sf.th.lowWarn} BPM`} />
            <Row label="Critical" value={`≤ ${sf.th.lowCrit} or ≥ ${sf.th.highCrit} BPM`} />
            <Row label="Warning if oxygen at or below" value={`${sf.th.spo2Warn}% (critical ≤ ${sf.th.spo2Crit}%)`} />
            <Row
              label="Expected heart rate for this driver"
              value={`${sf.band ? Math.round(sf.band.mean) : Math.round(sf.prior.hrMean)} ± ${Math.round(sf.band?.sd ?? sf.prior.hrSd)} BPM`}
            />
            <Row label="Learned from own drives" value={`${Math.round((sf.band?.weight ?? 0) * 100)}%`} />
            {sf.ack.high !== null || sf.ack.low !== null ? (
              <>
                <Row
                  label={`Adjusted by your "I'm OK" answers`}
                  value={[sf.ack.high !== null ? `high line ${sf.th.highWarn}` : null, sf.ack.low !== null ? `low line ${sf.th.lowWarn}` : null]
                    .filter(Boolean)
                    .join(' · ')}
                  tone="brand"
                />
                <Btn title="Reset these adjustments" kind="ghost" onPress={() => void d.resetAck()} />
              </>
            ) : null}
            <Text style={st.note}>How the profile sets this: {sf.prior.explain.join(' · ')}.</Text>
            <Text style={st.note}>
              A warning is watched for 15 s (8 s if critical). Only if readings stay out of range does the phone ask "Are you
              feeling OK?" out loud. Sources: NEWS2 (Royal College of Physicians 2017), Avram et al. 2019 real-world heart-rate
              norms, alarm-delay studies (Görges 2009). Oxygen is an estimate: pulse oximeters can read several points high on
              darker skin (Sjoding et al. 2020), so a normal-looking value is not proof of normal oxygen.
            </Text>
          </>
        ) : (
          <Text style={st.note}>Pick a driver to see their thresholds.</Text>
        )}
        <Row
          label="Voice check"
          value={
            !d.voice ? 'asks permission at drive start' : !d.voice.granted ? 'off — buttons only' : d.voice.onDevice ? 'on, fully on-device' : 'on'
          }
          tone={d.voice && !d.voice.granted ? 'warn' : 'good'}
        />
        {d.driver ? (
          <>
            <Text style={st.voiceHead}>How your thresholds changed</Text>
            <ThresholdHistory profileId={d.driver.id} refreshKey={`${sf.th?.highWarn}:${sf.th?.lowWarn}:${d.baseline?.sessions ?? 0}`} />
          </>
        ) : null}
        <Text style={st.voiceHead}>Voice</Text>
        {d.driver ? (
          <VoicePicker lang={d.driver.language === 'es' ? 'es' : 'en'} driverName={d.driver.display_name.split(' ')[0] ?? ''} />
        ) : null}
        <Btn
          title="Try the voice check"
          kind="ghost"
          disabled={d.hasActiveSession}
          onPress={async () => {
            setRehearsal('Listen and answer out loud…');
            const r = await d.rehearseVoice();
            setRehearsal(
              r.outcome === 'no_response'
                ? 'No answer heard. In a real check this counts as an emergency.'
                : `Understood: ${r.outcome === 'ok' ? 'you are OK' : 'you are NOT OK'}${r.urgent ? ' (urgent words heard)' : ''} — via ${r.channel}.`,
            );
          }}
        />
        <Text style={st.note}>This test can open your saved contact's phone interface if you request or agree to it. iOS still requires you to complete the call.</Text>
        {rehearsal ? <Text style={st.note}>{rehearsal}</Text> : null}
        {rehearsal && sf.last?.episode.id === 'rehearsal' && sf.last.handoff ? (
          <Text style={st.note}>{
            sf.last.handoff === 'opened' ? 'Phone interface opened. Call connection is not confirmed.'
            : sf.last.handoff === 'missing_contact' ? 'No emergency contact number is saved.'
            : sf.last.handoff === 'invalid_phone' ? 'The saved emergency contact number is invalid.'
            : sf.last.handoff === 'open_failed' ? 'Could not open the phone interface.'
            : 'Phone handoff was cancelled.'
          }</Text>
        ) : null}
        <Text style={st.note}>
          Speech is handled by the phone itself (no paid services). The check speaks at full volume through the speaker or your
          car's Bluetooth, even on silent; turn the phone's volume up. For the most natural voice, download a free Premium or
          Enhanced voice: iPhone Settings → Accessibility → Read & Speak → Voices → English (and Español) → pick one marked
          Premium or Enhanced (about 100–400 MB, on Wi-Fi). On iOS 17–18 the menu is called Spoken Content. The app picks the
          best one automatically (tap "Try the voice check" to hear the new one).
        </Text>
      </Card>

      <CalibrationCard drive={d} />

      <Card>
        <SectionTitle>Demo — trigger a warning</SectionTitle>
        <Text style={st.note}>
          Plays fabricated readings through the real warning engine with this driver's thresholds, 4× faster than real time: a
          few normal seconds, then abnormal ones until the warning flag is raised, confirmed, and the voice check asks if you're
          OK. Nothing is saved, uploaded, or learned from.
        </Text>
        {(
          [
            ['high_critical', 'Very high heart rate (critical)'],
            ['high_warning', 'High heart rate (warning, 15-s check)'],
            ['low', 'Very low heart rate'],
            ['spo2', 'Low oxygen'],
          ] as const
        ).map(([key, label]) => (
          <Btn
            key={key}
            title={label}
            kind="ghost"
            disabled={!sf.th || sf.demo !== null || sf.check !== null}
            onPress={async () => {
              setDemoResult(null);
              setDemoResult(describe(await d.simulate(key)));
            }}
          />
        ))}
        {sf.demo ? (
          <Text style={[st.note, { color: C.warn }]}>
            Second {sf.demo.second}: {sf.demo.value}
            {sf.demo.scenario === 'spo2' ? '%' : ' BPM'} · {sf.demo.step}
          </Text>
        ) : null}
        {demoResult ? <Text style={st.note}>{demoResult}</Text> : null}
      </Card>

      <Card>
        <SectionTitle>Cloud</SectionTitle>
        <Text style={st.note}>
          Drives stream to the dashboard live while you have signal. Anything recorded offline waits on the phone; upload it here.
        </Text>
        {d.live?.legacySchema ? (
          <Text style={[st.note, { color: C.warn }]}>
            The database is missing the v3 update, so some live details (link state, alerts, archives) aren't uploaded yet.
          </Text>
        ) : null}
        <Btn title="Upload waiting drives" kind="ghost" busy={syncing} onPress={uploadBacklog} />
        {syncMsg ? <Text style={st.note}>{syncMsg}</Text> : null}
      </Card>

      <Card>
        <SectionTitle>Connection</SectionTitle>
        <Row label="Auto-connect to the Pi" value={<Switch value={props.autoOn} onValueChange={(v) => {
          if (v) d.autoConnect();
          else void d.stopConnecting();
          props.setAutoOn(v);
        }} />} />
        <Row label="Status" value={d.connection} />
        {d.link ? (
          <>
            <Row label="Device" value={`${d.link.name} (${d.link.source === 'relay' ? 'Pi relay' : 'ESP32 direct'})`} />
            <Row label="Connected at" value={fmtClock(d.link.connectedAt)} />
            <Row label="Connected for" value={fmtDuration(now - d.link.connectedAt.getTime())} />
          </>
        ) : null}
        {d.relay ? (
          <Row
            label="Wheel → Pi"
            value={d.relay.esp ? `up since ${d.relay.espSince ? fmtClock(new Date(d.relay.espSince * 1000)) : '?'}` : 'not connected'}
            tone={d.relay.esp ? 'good' : 'bad'}
          />
        ) : null}
        <Row
          label="Last packet"
          value={d.lastRx ? `${((now - d.lastRx.getTime()) / 1000).toFixed(1)} s ago (#${d.lastSeq})` : '—'}
        />
      </Card>

      <Card>
        <SectionTitle>Link health</SectionTitle>
        <Row label="Packets received" value={String(d.packets)} />
        <Row label="Samples per packet" value={d.samplesPerPacket ? `${d.samplesPerPacket} @ ${d.sampleRate ?? '?'} Hz` : '—'} />
        <Row label="Lost packets" value={String(d.lost)} tone={d.lost ? 'warn' : 'good'} />
        <Row label="CRC errors" value={String(d.crcErrors)} tone={d.crcErrors ? 'bad' : 'good'} />
        <Row label="Duplicates ignored" value={String(d.duplicates)} />
        {d.relay ? <Row label="Pi: from wheel / lost / CRC" value={`${d.relay.rx} / ${d.relay.lost} / ${d.relay.crc}`} /> : null}
        {d.rollovers ? <Row label="Sensor restarts this drive" value={String(d.rollovers)} /> : null}
        <Row label="Rows in cloud (this drive)" value={String(d.live?.pushed ?? 0)} />
        <View style={st.bench}>
          <Text style={[st.note, { flex: 1 }]}>
            Bench testing: connect straight to the ESP32 when no Pi is around. Never in the car — it locks the Pi out.
          </Text>
          <Switch
            value={direct}
            onValueChange={(v) => {
              setDirect(v);
              d.setAllowDirect(v);
            }}
          />
        </View>
        {d.driver ? <Text style={st.id}>driver {d.driver.id}</Text> : null}
        {d.session ? <Text style={st.id}>session {d.session.id}</Text> : null}
      </Card>
      <Card>
        <SectionTitle>Your data</SectionTitle>
        <Btn title="Show the introduction again" kind="ghost" onPress={props.onShowIntro} />
        <Text style={st.note}>
          To delete one driver: go back to "Who's driving?", long-press them, and choose Delete. To delete one drive: open it
          in History. Deleting removes it here and on the dashboard.
        </Text>
        <Btn
          title="Wipe all data on this phone"
          kind="danger"
          disabled={d.hasActiveSession}
          onPress={() =>
            Alert.alert(
              'Wipe everything?',
              'Deletes every driver, drive, reading, alert and waveform this phone has recorded — here and on the dashboard. Other phones\' data is not touched. This cannot be undone.',
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Wipe everything',
                  style: 'destructive',
                  onPress: async () => {
                    const r = await wipeEverything();
                    await props.onWiped();
                    Alert.alert(
                      'Wiped',
                      `${r.drivers} driver(s) deleted.` +
                        (r.queued ? ` ${r.queued} will be removed from the dashboard when the phone is next online.` : ''),
                    );
                  },
                },
              ],
            )
          }
        />
      </Card>
      <Text style={st.disclaimer}>Prototype — not a medical device. Alerts use prototype thresholds. Real checks and Try the voice check can open the saved contact's phone interface with your agreement. Simulated vitals demos never do.</Text>
    </ScrollView>
  );
}

const st = StyleSheet.create({
  container: { padding: 16, gap: 14, paddingBottom: 40 },
  mode: { flexDirection: 'row', gap: 12, padding: 12, borderRadius: 14, borderWidth: 1.5, borderColor: C.line },
  modeOn: { borderColor: C.brand, backgroundColor: '#f0fdfa' },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: C.faint, marginTop: 2 },
  radioOn: { borderColor: C.brand, backgroundColor: C.brand },
  modeTitle: { fontSize: 16, fontWeight: '700', color: C.ink },
  modeBody: { fontSize: 13, color: C.sub, lineHeight: 18 },
  note: { fontSize: 13, color: C.sub, lineHeight: 18 },
  bench: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 6 },
  id: { fontSize: 10, color: C.faint },
  voiceHead: { fontSize: 14, fontWeight: '700', color: C.ink, marginTop: 6 },
  disclaimer: { fontSize: 12, color: C.faint, textAlign: 'center' },
});

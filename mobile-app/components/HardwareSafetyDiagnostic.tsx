import { useEffect, useState } from 'react';
import { AppState, Switch } from 'react-native';
import { LocalizedText as Text } from '../lib/i18n/native';
import type { HardwareSafetySnapshot, HardwareStartBlock } from '../lib/diagnostics/hardwareSafetyTest';
import { BASELINE_MIN_READINGS } from '../lib/analysis/baseline';
import { deriveDiagnosticThresholds, diagnosticReference } from '../lib/diagnostics/personalizedHardwareThreshold';
import type { useDriveSession } from '../lib/hooks/useDriveSession';
import { Btn, fmtClock, Row, SectionTitle } from './ui';
import { DiagnosticDetails } from './DiagnosticUI';
import { SettingsNote } from './SettingsGroup';

const status = {
  idle: 'Ready to start',
  waiting: 'Armed · waiting for qualified sensor readings',
  confirmed: 'FlagEngine confirmed an emergency',
  collecting: 'FlagEngine monitoring',
  recovering: 'Paused · waiting for qualified readings',
  checking: 'Diagnostic VoiceCheck',
  confirming: 'Awaiting in-app approval',
  opening: 'Requesting iPhone dialer',
  finished: 'Test finished',
  cancelled: 'Test cancelled or expired',
} as const;

const startReason: Record<HardwareStartBlock, string> = {
  platform: 'This test requires a supported iPhone.',
  foreground: 'Keep DriveSense open on a supported screen.',
  hardware: 'Connect the wheel sensor to start.',
  recording: 'End the recording before starting the test.',
  profile: 'Select a driver and close the profile editor.',
  safety: 'Finish or close the current safety interaction.',
  active: 'Finish, cancel, or reset the current hardware test.',
  cleanup: 'Waiting for the previous safety check to finish cleanup.',
  cooldown: 'Waiting for the 10-second cooldown after the last warning.',
  contact: 'Save a named emergency contact with a valid number, or turn off real-contact handoff.',
  baseline: 'A personalized HR baseline is required. Save drives with qualifying readings first.',
  thresholds: 'Compatible test thresholds could not be derived from this baseline and the current production limits.',
};

const voiceLabel: Record<HardwareSafetySnapshot['voiceCheck'], string> = {
  idle: 'Not started',
  starting: 'Starting VoiceCheck',
  active: 'VoiceCheck activated',
  completed: 'VoiceCheck completed',
  unavailable: 'VoiceCheck controller did not open an interaction',
  setup_failed: 'VoiceCheck setup failed',
};

type LastFrame = NonNullable<HardwareSafetySnapshot['lastFrame']>;
const sequenceLabel: Record<LastFrame['sequence'], string> = {
  unchecked: 'Not evaluated',
  accepted: 'Accepted',
  duplicate: 'Duplicate sequence',
  replayed: 'Older sequence',
  gap: 'Continuity gap',
  restart: 'Stream reset or backwards sequence',
  stale: 'Outside freshness window',
};
const waveformLabel: Record<LastFrame['waveform'], string> = {
  passed: 'Passed',
  rejected: 'Failed',
  warming: 'Collecting phone waveform window',
  unavailable: 'Phone waveform check unavailable',
};
const rejectionLabel: Record<NonNullable<LastFrame['rejection']>, string> = {
  context: 'Diagnostic context is blocked',
  stale: 'Frame timestamp is outside the freshness window',
  sequence: 'Frame did not pass sequence continuity',
  contact: 'No finger contact',
  vitals: 'Vitals missing, invalid, or out of range',
  firmware: 'ESP32 signal quality below 50%',
  waveform: 'Phone waveform analysis rejected the reading',
  bench_quality: 'Bench signal requirements were not met.',
  handoff_quality: 'Real-contact test requires a passing phone waveform check',
};

function HardwareFrameDetails({ frame, lastQualifiedAt }: { frame?: LastFrame | null; lastQualifiedAt?: number | null }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <DiagnosticDetails title="Last hardware frame">
    <Row label="Last frame received" value={frame ? fmtClock(new Date(frame.at)) : 'No decoded frames received'} />
    <Row label="Frame age" value={frame ? `${Math.max(0, (now - frame.at) / 1000).toFixed(1)} s` : '—'} />
    <Row label="Last qualified frame" value={lastQualifiedAt == null ? '—' : fmtClock(new Date(lastQualifiedAt))} />
    <Row label="Protocol and sequence" value={frame ? `v${frame.version} · #${frame.seq}` : '—'} />
    <Row label="Sequence validity" value={frame ? sequenceLabel[frame.sequence] : '—'} />
    <Row label="Raw measured heart rate" value={frame?.bpm == null ? '—' : `${frame.bpm} BPM`} />
    <Row label="Raw measured SpO₂" value={frame?.spo2 == null ? '—' : `${frame.spo2}%`} />
    <Row label="ESP32 quality" value={frame?.firmwareQuality == null ? 'Unavailable' : `${frame.firmwareQuality}%`} />
    <Row label="Phone waveform quality" value={frame ? waveformLabel[frame.waveform] : '—'} />
    <Row label="Last frame qualification" value={frame ? frame.rejection ? rejectionLabel[frame.rejection] : 'Qualified sensor reading' : '—'} />
  </DiagnosticDetails>;
}

export function HardwareSafetyDiagnostic({ drive }: { drive: ReturnType<typeof useDriveSession> }) {
  const controls = drive.hardwareTestControls;
  const state = drive.hardwareTest;
  const [allowContact, setAllowContact] = useState(false);
  const [benchMode, setBenchMode] = useState(false);
  const [fastDemo, setFastDemo] = useState(false);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', next => {
      if (next !== 'active') { setAllowContact(false); setBenchMode(false); setFastDemo(false); }
    });
    return () => subscription.remove();
  }, []);
  const cancel = controls?.cancel;
  useEffect(() => () => cancel?.(), [cancel]);
  if (!controls) return null;
  const phase = state?.phase ?? 'idle';
  const baseline = drive.baseline;
  const limits = state?.limits ?? deriveDiagnosticThresholds(baseline, drive.safety?.th ?? null);
  const reference = state?.limits ?? diagnosticReference(baseline);
  const production = limits?.production ?? drive.safety?.th;
  const detection = state?.detection;
  const baselineStatus = reference ? 'Established' : baseline?.established ? 'HR baseline unavailable'
    : baseline ? `${baseline.readings} / ${BASELINE_MIN_READINGS} qualifying readings` : 'Unavailable';
  const running = phase !== 'idle' && phase !== 'cancelled' && phase !== 'finished';
  const connected = drive.isConnected && (drive.link?.source !== 'relay' || drive.relay?.esp !== false);
  const block = state ? state.startBlock ?? (allowContact && !state.contactReady ? 'contact' : null) : 'profile';
  return <>
    <SectionTitle>Real Hardware Safety Test</SectionTitle>
    <SettingsNote>Run while parked. This test uses FlagEngine with separate HR warning thresholds. Critical HR and all oxygen thresholds stay at their production values.</SettingsNote>
    <Row label="Active driver" value={drive.driver?.display_name ?? '—'} />
    <Row label="Baseline readiness" value={baselineStatus} />
    <Row label="Typical HR and usual range" value={reference
      ? `${reference.typical.toFixed(1)} BPM · ${reference.p10.toFixed(1)}–${reference.p90.toFixed(1)} BPM` : '—'} />
    <Row label="Production HR warning boundaries" value={production ? `≤ ${production.lowWarn} / ≥ ${production.highWarn} BPM` : '—'} />
    <Row label="Diagnostic HR boundaries" value={limits ? `≤ ${limits.low} / ≥ ${limits.high} BPM` : '—'} />
    <Row label="Hardware" value={connected ? 'Connected' : 'Disconnected'} />
    <Row label="Signal eligibility" value={state?.reading ? 'Qualified sensor reading' : 'Waiting for qualified sensor data'} />
    <Row label="Measured heart rate" value={state?.reading ? `${state.reading.bpm} BPM` : '—'} />
    <Row label="Measured SpO₂" value={state?.reading ? `${state.reading.spo2}%` : '—'} />
    <Row label="Shared critical HR boundaries" value={production ? `≤ ${production.lowCrit} / ≥ ${production.highCrit} BPM` : '—'} />
    <Row label="Shared SpO₂ warning / critical" value={production ? `≤ ${production.spo2Warn}% / ≤ ${production.spo2Crit}%` : '—'} />
    <Row label="Filtered heart rate" value={detection?.filteredBpm == null ? '—' : `${detection.filteredBpm} BPM`} />
    <Row label="Continuity resets" value={String(state?.continuityResets ?? 0)} />
    <Row label="Hampel rejections" value={detection ? String(detection.rejected) : '—'} />
    {detection?.tracks.map(({ episode, required, samples, accepted, beyond, minimumCoverage, minimumBeyond }) => (
      <DiagnosticDetails key={episode.id} title={`${episode.level === 'critical' ? 'CRITICAL' : 'WARNING'} · ${episode.kind}`}>
        <Row label="Confirmation boundary" value={`${episode.kind === 'bpm_high' ? '≥' : '≤'} ${episode.threshold} ${episode.kind === 'spo2_low' ? '%' : 'BPM'}`} />
        <Row label="Confirmation frames" value={`${samples} / ${required}`} />
        <Row label="Qualified frames in window" value={`${accepted} / ${required} (≥${minimumCoverage * 100}%)`} />
        <Row label="Beyond boundary among qualified" value={`${beyond} / ${accepted} (≥${minimumBeyond * 100}%)`} />
        <Row label="Confirmation status" value={samples < required ? 'Collecting the confirmation window'
          : accepted / required < minimumCoverage ? 'Insufficient qualified coverage'
          : beyond / accepted < minimumBeyond ? 'Too few qualified readings beyond the boundary'
          : 'Waiting for FlagEngine to confirm'} />
      </DiagnosticDetails>
    ))}
    {state?.confirmed ? <Row label="Confirmed diagnostic level" value={state.confirmed.level === 'critical' ? 'CRITICAL' : 'WARNING'} /> : null}
    {detection?.cooldowns.some(cooldown => cooldown.until > Date.now()) ? <SettingsNote>FlagEngine cooldown is active for a previously resolved diagnostic episode.</SettingsNote> : null}
    {phase === 'collecting' && !detection?.tracks.length && !state?.confirmed ? <SettingsNote>Waiting for filtered readings to reach a diagnostic threshold.</SettingsNote> : null}
    <Row label="Test status" value={phase === 'idle' && block ? 'Start unavailable'
      : state?.lastCancellation?.source === 'transport_silence' && phase === 'cancelled' ? 'Cancelled · no continuous BLE frames'
      : state?.cancellation === 'signal' ? 'Cancelled · qualified signal lost'
      : state?.cancellation === 'timeout' ? 'Cancelled · time expired'
      : status[phase]} />
    <Row label="VoiceCheck status" value={state?.triggerBlock === 'monitoring' ? 'Waiting for active safety monitoring'
      : state?.triggerBlock === 'qualified_signal' ? 'Waiting for a fresh qualified reading'
      : state?.triggerBlock === 'handoff_quality' ? 'Waiting for a passing phone waveform check'
      : voiceLabel[state?.voiceCheck ?? 'idle']} />
    {phase === 'waiting' || phase === 'recovering' ? <SettingsNote>{state?.frameSilence
      ? 'No recent BLE frames. Checking the connection.'
      : state?.lastFrame?.rejection ? rejectionLabel[state.lastFrame.rejection] : 'No recent qualified frame. Checking the signal.'}</SettingsNote> : null}
    <Row label="Debug Bench Mode" value={<Switch
      accessibilityLabel="Debug Bench Mode" value={running ? !!state?.benchMode : benchMode} disabled={running}
      onValueChange={enabled => { setBenchMode(enabled); if (!enabled) setFastDemo(false); }} />} />
    {(running ? state?.benchMode : benchMode) ? <SettingsNote>High-HR demonstration with relaxed waveform shape checks. Contact handoff still requires a passing waveform and separate approval.</SettingsNote> : null}
    {(running ? state?.benchMode : benchMode) ? <Row label="Fast Demo" value={<Switch
      accessibilityLabel="Fast Demo" value={running ? !!state?.fastDemo : fastDemo}
      disabled={running} onValueChange={setFastDemo} />} /> : null}
    <Row label="Allow real emergency-contact handoff during this test" value={<Switch
      accessibilityLabel="Allow real emergency-contact handoff during this test"
      value={running ? !!state?.allowsContact : allowContact}
      disabled={running} onValueChange={setAllowContact} />} />
    {block ? <SettingsNote>{startReason[block]}</SettingsNote> : null}
    <Btn title="Start real hardware test" disabled={block !== null} onPress={() => {
      if (controls.start(allowContact, benchMode, fastDemo)) { setAllowContact(false); setBenchMode(false); setFastDemo(false); }
    }} />
    <Btn title="Cancel hardware test" kind="ghost" disabled={!running} onPress={() => { setAllowContact(false); setBenchMode(false); setFastDemo(false); controls.cancel(); }} />
    <Btn title="Reset hardware test" kind="ghost" onPress={() => { setAllowContact(false); setBenchMode(false); setFastDemo(false); controls.reset(); }} />
    <HardwareFrameDetails frame={state?.lastFrame} lastQualifiedAt={state?.lastQualifiedAt} />
    {state?.attemptEvidence ? <DiagnosticDetails title="Attempt evidence">
      <Text localize={false} selectable>{JSON.stringify(state.attemptEvidence, null, 2)}</Text>
    </DiagnosticDetails> : null}
    {state?.activation ? <DiagnosticDetails title="Activation evidence">
      <Text localize={false} selectable>{JSON.stringify(state.activation, null, 2)}</Text>
    </DiagnosticDetails> : null}
    {phase === 'cancelled' && state?.handoffEvidence?.decision?.result === 'accepted_offer'
      && state.handoffEvidence.invalidation && !state.handoffEvidence.nativeResult ? <SettingsNote>{
        state.cancellation === 'timeout' ? 'The contact confirmation expired.'
          : state.cancellation === 'signal' ? 'Sensor signal was lost before contact authorization.'
          : 'The response no longer belongs to the active question.'
      }</SettingsNote> : null}
    {state?.handoffEvidence ? <DiagnosticDetails title="Contact authorization evidence">
      <Text localize={false} selectable>{JSON.stringify(state.handoffEvidence, null, 2)}</Text>
    </DiagnosticDetails> : null}
    {state?.captureEvidence && Object.keys(state.captureEvidence).length ? <DiagnosticDetails title="Voice capture evidence">
      <Text localize={false} selectable>{JSON.stringify(state.captureEvidence, null, 2)}</Text>
    </DiagnosticDetails> : null}
    {state?.lastCancellation ? <DiagnosticDetails title="Last cancellation">
      <Text localize={false} selectable>{JSON.stringify(state.lastCancellation, null, 2)}</Text>
    </DiagnosticDetails> : null}
  </>;
}

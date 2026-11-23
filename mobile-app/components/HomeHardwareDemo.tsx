import { useState, type ReactNode } from 'react';
import { View, useWindowDimensions } from 'react-native';
import { LocalizedPressable as Pressable, LocalizedText as Text } from '../lib/i18n/native';
import { SENSOR_STALE_MS } from '../lib/analysis/sensorContinuity';
import type { useDriveSession } from '../lib/hooks/useDriveSession';
import { useTheme } from '../lib/theme/ThemeProvider';
import { Card, Pill, Row } from './ui';
import { Waveform } from './charts';

function Segments({ labels, second, onChange }: {
  labels: readonly [string, string];
  second: boolean;
  onChange(second: boolean): void;
}) {
  const { tokens: t } = useTheme();
  const { fontScale } = useWindowDimensions();
  return <View style={{ flexDirection: fontScale > 1.6 ? 'column' : 'row', padding: 3, gap: 3,
    backgroundColor: t.surfaceMuted, borderRadius: 12 }}>
    {labels.map((label, index) => {
      const selected = second === (index === 1);
      return <Pressable key={label} accessibilityRole="radio" accessibilityState={{ selected }}
        onPress={() => onChange(index === 1)}
        style={{ flexGrow: 1, flexBasis: 0, minWidth: 0, minHeight: 44, paddingHorizontal: 8, paddingVertical: 6,
          justifyContent: 'center', borderRadius: 9, backgroundColor: selected ? t.primary : t.surfaceMuted }}>
        <Text style={{ textAlign: 'center', fontWeight: '700', color: selected ? t.onPrimary : t.textSecondary }}>{label}</Text>
      </Pressable>;
    })}
  </View>;
}

function Action({ label, onPress, disabled, accessibilityLabel }: { label: string; onPress(): void; disabled?: boolean; accessibilityLabel?: string }) {
  const { tokens: t } = useTheme();
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} accessibilityState={{ disabled }} disabled={disabled}
    onPress={onPress} style={{ minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 8 }}>
    <Text style={{ color: disabled ? t.textMuted : t.primary, fontWeight: '700' }}>{label}</Text>
  </Pressable>;
}

type Drive = ReturnType<typeof useDriveSession>;

export function demoVitalPresentation(drive: Drive, now: number) {
  const state = drive.homeHardwareDemo;
  const connected = drive.isConnected && (drive.link?.source !== 'relay' || drive.relay?.esp === true);
  const receivedAt = drive.lastRx?.getTime();
  const connectedAt = drive.link?.connectedAt?.getTime();
  const age = receivedAt === undefined ? null : now - receivedAt;
  const fresh = connected && age !== null && age >= 0 && age < SENSOR_STALE_MS
    && (connectedAt === undefined || receivedAt! >= connectedAt);
  const source = state?.actual;
  // Only show a projection paired with the latest genuine frame. A skipped or
  // rejected frame must not leave an earlier projection visible as current.
  const actual = fresh && source?.at === receivedAt ? source : null;
  const hr = state?.simulation.scenario !== 'low_spo2';
  const reading = (hr ? actual?.hr : actual?.spo2) ?? null;
  const sourceValue = reading !== null && Number.isFinite(reading) ? reading : null;
  const contact = actual?.finger ?? drive.finger;
  const simulated = state?.simulation.enabled ? state.projected : null;
  const projected = contact && sourceValue !== null
    && simulated && Number.isFinite(simulated.value) && Number.isFinite(simulated.offset) ? simulated : null;
  return { connected, age, fresh, contact, projected, sourceValue };
}

export function HomeHardwareDemo({ drive, now, children }: { drive: Drive; now: number; children?: ReactNode }) {
  const { tokens: t } = useTheme();
  const [enableFailed, setEnableFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const controls = drive.homeHardwareDemoControls;
  const state = drive.homeHardwareDemo;
  if (!controls) return null;

  const simulation = state?.simulation;
  const enabled = !!simulation?.enabled;
  const hr = simulation?.scenario !== 'low_spo2';
  const manual = simulation?.mode === 'manual';
  const { connected, fresh, contact, projected } = demoVitalPresentation(drive, now);
  const status = !connected ? 'Disconnected' : !fresh ? 'Connected' : !contact ? 'Waiting for Finger Contact'
    : projected ? 'Ready to Simulate' : enabled ? 'Collecting Valid Readings' : 'Connected';
  const warning = state?.warningReference;
  const offset = hr ? simulation?.hrIncrease ?? 0 : simulation?.spo2Reduction ?? 0;
  const value = (reading: number | null | undefined) => reading == null ? '—'
    : hr ? `${Number(reading.toFixed(2))} BPM` : `${Number(reading.toFixed(2))}%`;
  const ensureEnabled = () => {
    const success = !!state?.enabled || controls.enable();
    setEnableFailed(!success);
    return success;
  };
  const toggleSimulation = () => {
    if (enabled) controls.configureSimulation({ enabled: false });
    else if (ensureEnabled()) controls.configureSimulation({ enabled: true });
  };

  return <Card style={{ gap: 8 }}>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setExpanded(current => !current)}
      style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
      <Text style={{ color: t.primary, fontWeight: '700', flex: 1 }}>Hardware Demo</Text>
      <Text accessible={false} style={{ color: t.primary }}>{expanded ? '−' : '+'}</Text>
    </Pressable>
    {!expanded ? <Text style={{ color: t.textSecondary }}>{enabled ? 'Simulation enabled' : 'Simulation off'}{enabled ? ' · ' : ''}{enabled ? hr ? 'High HR' : 'Low SpO₂' : ''}</Text> : null}
    {expanded ? <>
    <View accessibilityLiveRegion="polite">
      <Pill tone={projected ? 'good' : connected ? 'neutral' : 'warn'}>{status}</Pill>
    </View>
      <Pressable accessibilityRole="switch" accessibilityState={{ checked: enabled }} onPress={toggleSimulation}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44, paddingVertical: 4 }}>
        <Text style={{ flex: 1, color: t.text, fontWeight: '700' }}>Simulated Abnormal Readings</Text>
        <View accessible={false} style={{ width: 42, height: 24, borderWidth: 1, borderColor: enabled ? t.primary : t.border,
          borderRadius: 12, justifyContent: 'center', paddingHorizontal: 3, alignItems: enabled ? 'flex-end' : 'flex-start',
          backgroundColor: enabled ? t.primary : t.surfaceMuted }}>
          <View style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: enabled ? t.onPrimary : t.textMuted }} />
        </View>
      </Pressable>
      {enableFailed ? <Text style={{ color: t.warning }}>Use a supported iPhone and a driver with a valid named test contact.</Text> : null}
      {state?.result === 'expired' ? <Text style={{ color: t.textSecondary }}>The demo expired. Turn simulation off and on to try again.</Text> : null}
      {state?.result === 'failed' && !state.safety?.conversation ? <Text style={{ color: t.warning }}>The demo safety check could not start.</Text> : null}
      {enabled ? <>
        <Segments labels={['High HR', 'Low SpO₂']} second={!hr}
          onChange={low => controls.configureSimulation({ scenario: low ? 'low_spo2' : 'high_hr' })} />
        <Segments labels={['Automatic', 'Manual']} second={manual}
          onChange={useManual => controls.configureSimulation({ mode: useManual ? 'manual' : 'automatic' })} />
        <Row label="Configured warning threshold" value={value(warning?.value)} />
        {manual ? <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
          <Text style={{ flex: 1, minWidth: 100, color: t.textSecondary }}>
            {hr ? 'Selected HR increase' : 'Selected SpO₂ reduction'}{' · '}{offset}{' '}{hr ? 'BPM' : 'percentage points'}
          </Text>
          {[-1, 1].map(step => <Action key={step} label={step < 0 ? '−' : '+'}
            accessibilityLabel={step < 0 ? 'Decrease offset' : 'Increase offset'}
            disabled={offset + step < 0 || offset + step > (hr ? 190 : 30)}
            onPress={() => controls.configureSimulation(hr ? { hrIncrease: offset + step } : { spo2Reduction: offset + step })} />)}
        </View> : null}
      </> : null}
      {children}
    </> : null}
  </Card>;
}


export function HardwareDemoDiagnostics({ drive, now, children }: { drive: Drive; now: number; children: ReactNode }) {
  const { tokens: t } = useTheme();
  const [advanced, setAdvanced] = useState(false);
  const [triggerUnavailable, setTriggerUnavailable] = useState(false);
  const { connected, age, fresh, contact } = demoVitalPresentation(drive, now);
  const state = drive.homeHardwareDemo;
  const controls = drive.homeHardwareDemoControls;
  const enabled = !!state?.simulation.enabled;
  const warning = state?.warningReference;
  const confirmation = state?.confirmationWindow;
  const waveform = fresh && drive.homeDemoWaveform?.at === drive.lastRx?.getTime() ? drive.homeDemoWaveform : null;
  return <View style={{ gap: 8 }}>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: advanced }} onPress={() => setAdvanced(value => !value)}
      style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
      <Text style={{ color: t.primary, fontWeight: '700', flex: 1 }}>Advanced Diagnostics</Text>
      <Text accessible={false} style={{ color: t.primary }}>{advanced ? '−' : '+'}</Text>
    </Pressable>
    {advanced ? <>
      <Row label="Hardware connection" value={connected ? 'Connected' : 'Disconnected'} />
      <Row label="Finger contact" value={fresh ? contact ? 'Detected' : 'Not detected' : '—'} />
      <Row label="ESP32 quality" value={fresh && drive.quality !== null ? `${drive.quality}%` : '—'} />
      <Row label="Phone waveform quality" value={fresh && drive.signal ? drive.signal.good ? 'Passed' : 'Not qualified' : '—'} />
      <Row label="Reading freshness" value={fresh && age !== null ? `${Math.floor(age / 100) / 10} s` : drive.lastRx ? 'Stale · last reading' : 'No readings'} />
      {warning ? <>
        <Row label="Threshold source" value={warning.source === 'baseline_informed' ? 'Baseline-informed'
          : warning.source === 'profile_estimate' ? 'Profile estimate' : 'Standard threshold'} />
        {warning.acknowledgmentAdjusted ? <Text style={{ color: t.textSecondary }}>Includes saved acknowledgment feedback</Text> : null}
      </> : null}
      {enabled ? <>
        <Row label="Confirmation slots" value={confirmation ? `${confirmation.slots} / ${confirmation.required}` : '—'} />
        <Row label="Accepted readings" value={confirmation ? String(confirmation.accepted) : '—'} />
        <Row label="Abnormal readings" value={confirmation ? String(confirmation.beyond) : '—'} />
      </> : null}
      {children}
      {waveform ? <>
        <Text style={{ color: t.textSecondary }}>Actual infrared waveform</Text>
        <Waveform values={waveform.samples.map(sample => sample.ir)} color={t.oxygenAccent} height={48} />
        <Text style={{ color: t.textSecondary }}>Actual red waveform</Text>
        <Waveform values={waveform.samples.map(sample => sample.red)} color={t.heartAccent} height={48} />
      </> : <Text style={{ color: t.textSecondary }}>Live waveform unavailable</Text>}
      {controls && !drive.hasActiveSession ? <Action label="Trigger Demo Emergency"
        disabled={state?.phase === 'checking' || state?.phase === 'review' || state?.phase === 'opening'}
        onPress={() => {
          const ready = !!state?.enabled || controls.enable();
          setTriggerUnavailable(!ready);
          if (ready) void controls.trigger();
        }} /> : null}
      {triggerUnavailable ? <Text style={{ color: t.warning }}>Use a supported iPhone and a driver with a valid named test contact.</Text> : null}
      {controls && state?.enabled ? <Action label="Stop Hardware Demo Mode" onPress={controls.stop} /> : null}
      <Text style={{ color: t.textSecondary }}>Demonstration values are calculated from live hardware measurements using controlled offsets. They do not represent the driver's actual physiological condition.</Text>
    </> : null}
  </View>;
}

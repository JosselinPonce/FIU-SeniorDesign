import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { vitalPresentation, vitalRangePresentation, drivePageAfter } from '../lib/ui/dashboard.ts';
const source = (path: string) => readFileSync(new NodeURL(`../${path}`, import.meta.url), 'utf8');

test('missing and rejected readings display unavailable, never generated samples or zero substitutes', () => {
  for (const [value, received] of [[null,null],[null,new Date(10000)],[72,null],[NaN,new Date(10000)]] as const)
    assert.deepEqual(vitalPresentation(value, received, true, 10000), { value: null, state: 'unavailable', label: 'Unavailable' });
});
test('only connected recent readings display live; stale and disconnected readings retain explicit status', () => {
  assert.equal(vitalPresentation(72, new Date(10000), true, 12999).state, 'live');
  for (const [connected, now] of [[true,13000],[true,20000],[false,10000],[true,9999]] as const) {
    const reading = vitalPresentation(72, new Date(10000), connected, now);
    assert.equal(reading.state, 'stale'); assert.equal(reading.value, 72); assert.match(reading.label, /Stale/);
  }
});
test('dashboard composition orders connectivity, start, compact vitals, detail navigation and drive details', () => {
  const view = source('components/DriveView.tsx');
  const parts = ['<Chain drive={d}', 'props.guard(d.startSession)', '<CompactVitalCard metric="heart" label="Heart Rate"',
    '<CompactVitalCard metric="oxygen" label="SpO₂ (estimate)"', 'title="View Detailed Vitals"', '<SectionTitle>Drive details'];
  const positions = parts.map(part => view.indexOf(part));
  assert.ok(positions.every(pos => pos >= 0)); assert.deepEqual([...positions].sort((a,b) => a-b), positions);
  assert.match(view, /disabled=\{!d.isConnected\}/);
  assert.match(view, /onPress=\{\(\) => props.guard\(d.endSession\)\}/);
  assert.match(view, /value=\{d.bpm\}.*average=\{d.avgBpm\} points=\{d.bpmSeries\}/);
  assert.match(view, /value=\{d.spo2\}.*average=\{d.avgSpo2\} points=\{d.spo2Series\}/);
  assert.match(view, /Cards show sensor data\. The simulated warning reading is separate/);
  assert.doesNotMatch(view, /value=\{sf.demo/);
});
test('compact charts retain actual point data, gap behavior and honest stale/empty labels', () => {
  const card = source('components/CompactVitalCard.tsx');
  assert.match(card, /<VitalChart points=\{props.points\}/);
  assert.match(card, /'last received' : 'no data'/);
  assert.match(card, /No readings/);
  const chart = source('components/charts.tsx');
  assert.match(chart, /v === null \? 0/);
  assert.match(chart, /props.endLabel \?\? 'now'/);
});
test('shell keeps assistant controller, hook, safety modal and original launch ownership', () => {
  const shell = source('components/SmartWheelScreen.tsx');
  assert.equal((shell.match(/const drive = useDriveSession\(\)/g) ?? []).length, 1);
  assert.equal((shell.match(/<DriverAssistant visible=/g) ?? []).length, 1);
  assert.match(shell, /<VoiceCheckModal drive=\{drive\}/);
  assert.match(shell, /<DashboardAssistantEntry[\s\S]*?onPress=\{openAssistant\}/);
  assert.match(shell, /const launch = snapshotAssistantLaunch\(assistantMode, PHONE_CONNECTED_READINESS\)/);
  assert.match(shell, /<SafeAreaView style=\{st.root\}/);
  assert.match(shell, /\['drive', 'Drive'\]/); assert.match(shell, /\['history', 'History'\]/); assert.match(shell, /\['settings', 'Settings'\]/);
  assert.doesNotMatch(shell, /DriverAssistant[^>]*key=/);
});
test('assistant entry reports passive capabilities, respects the guarded pilot gate and never starts audio during checks', () => {
  const entry = source('components/DashboardAssistantEntry.tsx');
  assert.match(entry, /checkDriverAssistantAvailability\(\)/);
  assert.match(entry, /checkOfflineSpeechCapability\('en-US'\)/);
  assert.match(entry, /selectAssistantVoice\(voices, preferred\)/);
  assert.match(entry, /PHONE_CONNECTED_READINESS.verified \? CONNECTED_PILOT_STATUS : CONNECTED_UNAVAILABLE/);
  assert.match(entry, /const disabled = props.disabled \|\| \(props.mode === 'connected' && !PHONE_CONNECTED_READINESS.verified\)/);
  assert.doesNotMatch(entry, /listenOffline\(|speakLocal\(|interpretConversation\(|functions.invoke\(/);
  assert.match(entry, /current && request === version/);
});
test('BrandMark leaves an explicit approved-asset integration point without a substitute image', () => {
  const brand = source('components/BrandMark.tsx');
  assert.match(brand, /approvedLogo\?: ImageSourcePropType/);
  assert.match(brand, /approvedLogo \? <Image source=\{approvedLogo\}/);
  assert.doesNotMatch(brand, /require\(|icon.png|<svg/i);
});

test('dashboard uses official branding, an unadorned primary control and accessible compact entry', () => {
  const brand = source('components/BrandMark.tsx');
  assert.match(brand, /Driven by Safety\. Powered by Insight\./);
  assert.doesNotMatch(brand, /sport edition/i);
  const drive = source('components/DriveView.tsx');
  assert.match(drive, /<Chain drive=\{d\} \/>\s*<View style=\{\{ gap: 8/);
  assert.match(drive, /label="Cloud sync"/);
  assert.match(drive, /awaiting first upload/);
  assert.match(drive, /hop\(d.isConnected && \(piOk \|\| direct\), 'Phone'/);
  const entry = source('components/DashboardAssistantEntry.tsx');
  assert.match(entry, /<Pressable accessibilityRole="button" accessibilityLabel=/);
  assert.match(entry, /accessibilityState=\{\{ disabled \}\} disabled=\{disabled\}/);
  const card = source('components/CompactVitalCard.tsx');
  assert.match(card, /reading.value === null \? '--'/);
  assert.match(card, /tokens.heartAccent : tokens.oxygenAccent/);
  assert.match(card, /backgroundColor=\{tokens.metricChartSurface\}/);
});

test('range qualification respects inclusive warning boundaries and never promotes stale or missing data', () => {
  const bounds = { low: 50, high: 110 };
  for (const value of [49, 50, 110, 111]) assert.equal(vitalRangePresentation(value, new Date(1000), true, 1000, bounds).state, 'warning');
  assert.equal(vitalRangePresentation(72, new Date(1000), true, 1000, bounds).state, 'live');
  assert.equal(vitalRangePresentation(120, new Date(1000), true, 4000, bounds).state, 'stale');
  assert.equal(vitalRangePresentation(null, new Date(1000), true, 1000, bounds).state, 'unavailable');
  assert.equal(vitalRangePresentation(93, new Date(1000), true, 1000, { low: 93 }).state, 'warning');
});
test('details and back use presentation state only while session and safety remain shell-owned', () => {
  assert.equal(drivePageAfter('details'), 'vitals');
  assert.equal(drivePageAfter('back'), 'dashboard');
  assert.equal(drivePageAfter('tab'), 'dashboard');
  const detail = source('components/VitalsDetailView.tsx');
  assert.match(detail, /Back to dashboard/);
  assert.match(detail, /points=\{metric.points\}/);
  assert.match(detail, /No readings available/);
  assert.match(detail, /Last sensor packet/);
  assert.match(detail, /th.lowWarn/);
  assert.doesNotMatch(detail, /useDriveSession\(|startSession\(|endSession\(|speakLocal\(|listenOffline\(/);
  const shell = source('components/SmartWheelScreen.tsx');
  assert.match(shell, /<VitalsDetailView drive=\{drive\}/);
  assert.match(shell, /!drive.safety.check && !drive.safety.demo && !assistantOpen/);
  const entry = source('components/DashboardAssistantEntry.tsx');
  assert.match(entry, /accessibilityLabel="Driver Assistant"/);
  assert.match(entry, /width: 58, height: 58, borderRadius: 29/);
});

test('header shows one driver name above a compact switch action and keeps original switching', () => {
  const shell = source('components/SmartWheelScreen.tsx');
  const header = shell.slice(shell.indexOf('<View style={st.header}>'), shell.indexOf('<DriverAssistant visible='));
  assert.equal((header.match(/drive.driver.display_name/g) ?? []).length, 1);
  assert.ok(header.indexOf('drive.driver.display_name') < header.indexOf('onPress={switchDriver}'));
  assert.match(header, /<Text style=\{st.switchText\}>Switch driver/);
  assert.match(shell, /switch: \{ minHeight: 44, minWidth: 44/);
});
test('Sensi introduction is interface-only and wheel control remains separate from branding', () => {
  const assistant = source('components/DriverAssistant.tsx');
  const presentation = assistant.slice(assistant.indexOf('if (!props.visible) return null;'));
  assert.match(presentation, />Sensi<\/Text>/);
  assert.match(presentation, />Hi, I'm Sensi, your local driving assistant\.<\/Text>/);
  assert.match(presentation, /selectable>Sensi: \{turn.assistant\}/);
  assert.doesNotMatch(presentation, /speakLocal\(|interpretConversation\(/);
  const entry = source('components/DashboardAssistantEntry.tsx');
  assert.match(entry, /Sensi · \{modeLabel\}/);
  assert.match(entry, /accessibilityLabel="Driver Assistant"/);
  assert.match(entry, /width: 29, height: 29, borderRadius: 15/);
  assert.doesNotMatch(entry, /<Image|BrandMark|\[10, 20, 28/);
});

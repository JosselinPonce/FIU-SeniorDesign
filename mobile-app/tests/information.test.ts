import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { createInformationState } from '../lib/ui/information.ts';
import { themes } from '../lib/theme/tokens.ts';
const source = (path: string) => readFileSync(new NodeURL(`../${path}`, import.meta.url), 'utf8');

test('information opens, replaces content and closes through one observable sheet', () => {
  const state = createInformationState(); let changes = 0;
  const unsubscribe = state.subscribe(() => changes++);
  assert.equal(state.getSnapshot(), null);
  assert.equal(state.open({ title: 'Profiles', body: 'Personalized baseline' }), true);
  assert.equal(state.getSnapshot()?.title, 'Profiles');
  state.open({ title: 'Calibration', body: 'Details' });
  assert.equal(state.getSnapshot()?.title, 'Calibration');
  state.close(); assert.equal(state.getSnapshot(), null); assert.equal(changes, 3);
  unsubscribe(); state.close(); assert.equal(changes, 3);
});
test('safety preemption closes information, blocks new sheets, and never reopens stale content', () => {
  const state = createInformationState();
  state.open({ title: 'Details', body: 'Text' }); state.block(true);
  assert.equal(state.getSnapshot(), null);
  assert.equal(state.open({ title: 'Queued', body: 'Must not open' }), false);
  state.block(false); assert.equal(state.getSnapshot(), null);
  assert.equal(state.open({ title: 'New', body: 'Explicit tap required' }), true);
});
test('information UI declares accessible labels, focus, dismissal and themed modal boundaries', () => {
  const ui = source('components/Information.tsx');
  assert.match(ui, /accessibilityRole="button" accessibilityLabel=\{`Information about/);
  assert.match(ui, /minWidth: 44, minHeight: 44/);
  assert.match(ui, /accessibilityViewIsModal/);
  assert.match(ui, /setAccessibilityFocus/);
  assert.match(ui, /onRequestClose=\{state.close\}/);
  assert.match(ui, /title="Close" onPress=\{state.close\}/);
  assert.match(ui, /visible=\{!blocked && content !== null\}/);
  assert.match(ui, /backgroundColor: tokens.surface/);
  assert.match(ui, /if \(value !== 'active'\) state.close\(\)/);
  const shell = source('components/SmartWheelScreen.tsx');
  assert.match(shell, /InformationHost blocked=\{!!drive.safety.check \|\| !!drive.safety.demo \|\| assistantOpen\}/);
  assert.match(shell, /<VoiceCheckModal drive=\{drive\}/);
});
test('essential drive and assistant instructions remain rendered outside information content', () => {
  const drive = source('components/DriveView.tsx');
  for (const text of ['Waiting for the wheel', 'Wheel went quiet', 'Place your hand on the sensor', 'Good signal',
    'Recording since', 'Readings saved', 'End drive', 'No clear call consent was received', 'Call 911', 'DEMO · fabricated'])
    assert.ok(drive.includes(text), text);
  assert.match(drive, /<Btn title="Call 911" kind="danger" onPress=/);
  assert.match(drive, /<Text style=\{st.alertHint\}>/);
  const assistant = source('tests/retired-ai/components/DriverAssistant.tsx');
  assert.match(assistant, /<Text[^>]*>Wait for “Listening” before answering/);
  assert.match(assistant, /<Text[^>]*>This assistant offers suggestions/);
  const calibration = source('components/CalibrationCard.tsx');
  assert.match(calibration, /<Text style=\{st.note\}>Use a clip-on/);
  assert.match(calibration, /Measuring… keep still/);
  assert.match(calibration, /Enter the reference heart rate/);
});
test('driver editing is discoverable without changing selection or long-press paths', () => {
  const picker = source('components/DriverPicker.tsx');
  assert.match(picker, /Select a profile to continue\./);
  assert.match(picker, /onPress=\{\(\) => props.onPick\(p\)\}/);
  assert.match(picker, /onLongPress=\{\(\) => edit\(p\)\}/);
  assert.match(picker, /accessibilityLabel=\{`Edit \$\{p.display_name\}'s profile`\}/);
  assert.match(picker, /backgroundColor: tokens.graphite/);
});
test('diagnostic entry and child panels use runtime themes without dropping development or audio guards', () => {
  const shell = source('components/SmartWheelScreen.tsx');
  assert.match(shell, /gemmaDiagnostics=\{__DEV__ \?/);
  const picker = shell.slice(shell.indexOf('if (!drive.driver)'), shell.indexOf('if (editOpening)'));
  assert.doesNotMatch(picker, /Local AI diagnostics/);
  assert.match(shell, /disabled=\{drive.hasActiveSession \|\| !!drive.safety.check/);
  for (const path of ['components/SensiVoicePlaybackDiagnostic.tsx', 'modules/gemma-poc/GemmaDiagnostic.tsx', 'modules/local-foundation-models/OfflineSpeechTest.tsx']) {
    const ui = source(path);
    assert.match(ui, /useTheme\(\)/);
    assert.doesNotMatch(ui, /import \{[^}]*\bC\b[^}]*\} from .*components\/ui/);
  }
});
test('warm pearl and layered graphite remain distinct from warning and danger colors', () => {
  assert.equal(themes.light.background, '#F6F4F0'); assert.equal(themes.light.border, '#DCD7CF');
  assert.equal(themes.dark.background, '#1C252B');
  assert.notEqual(themes.dark.background, themes.dark.surface);
  for (const t of Object.values(themes)) {
    assert.equal(t.accent, '#D69B8D');
    assert.notEqual(t.accent, t.warning); assert.notEqual(t.accent, t.danger);
  }
});

test('connectivity does not equate a direct wheel connection with a connected Pi or internet', () => {
  const drive = source('components/DriveView.tsx');
  assert.match(drive, /const piOk = d.isConnected && d.link\?\.source === 'relay'/);
  assert.match(drive, /const direct = d.isConnected && d.link\?\.source === 'esp32'/);
  assert.match(drive, /direct \? 'bypassed \(direct\)'/);
  assert.match(drive, /hop\(d.isConnected && \(piOk \|\| direct\), 'Phone'/);
  assert.ok(drive.indexOf("hop(espOk && fresh, 'Wheel'") < drive.indexOf("hop(piOk, 'Raspberry Pi'"));
  assert.match(drive, /hop\(espOk && fresh, 'Wheel'/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { openSensi, sensiDestination, standbyReadiness, type GemmaFileStatus } from '../lib/assistant/sensiStandby.ts';
import type { ReadinessSnapshot } from '../lib/assistant/systemReadiness.ts';
import { systemReadiness, readinessIndicator } from '../lib/assistant/systemReadiness.ts';
import { light, dark } from '../lib/theme/tokens.ts';
const require = createRequire(import.meta.url);
const source = (path: string) => readFileSync(new NodeURL('../' + path, import.meta.url), 'utf8');
function nodes(tree: any): any[] {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...nodes(tree.props?.children)];
}
function harness(model: GemmaFileStatus, tokens = light, observation: Partial<ReadinessSnapshot> = {}) {
  const exports: any = {};
  const deps: Record<string, unknown> = {
    './ScreenHeader': { ScreenHeader: 'ScreenHeader' },
    './DashboardAssistantEntry': { SensiGlyph: 'SensiGlyph' },
    '../lib/ui/profileSummary': { driverInitials: (name: string) => name[0] },
    '../lib/analysis/safetyController': { contactPhone: (phone?: string) => ({phone: phone || null}) },
    './RealContactDemoConfirmation': { RealContactDemoConfirmation: 'RealContactDemoConfirmation' },
    '../lib/i18n/native': { LocalizedText: 'Text', LocalizedPressable: 'Pressable' },
    react: { useState: () => [model, () => {}], useEffect() {} },
    'react/jsx-runtime': require('react/jsx-runtime'),
    'react-native': { ScrollView: 'ScrollView', Modal: 'Modal', SafeAreaView: 'SafeAreaView', Text: 'Text', View: 'View', Pressable: 'Pressable' },
    '../lib/theme/ThemeProvider': { useTheme: () => ({ tokens }) },
    '../lib/assistant/sensiStandby': { standbyReadiness },
    '../lib/assistant/systemReadiness': { systemReadiness, readinessIndicator },
    '../lib/assistant/useSystemReadiness': { useSystemReadiness: () => ({ file: model, runtime: { busy: false, phase: 'Not checked', error: '', installed: false, loaded: false, progress: null }, speech: null, installedLocales: [], responses: 'unknown', foreground: true, ...observation }) },
    '../lib/i18n/LanguageProvider': { useAppLanguage: () => ({ t: (s: string) => s }) },
    'expo/node_modules/@expo/vector-icons/Feather': { __esModule: true, default: 'Feather' },
    '../modules/gemma-poc/phone': { inspectGemmaModelFile: () => { throw Error('render must not load or verify a model'); } },
    './ui': { Btn: 'Btn', Card: 'Card', Pill: 'Pill' },
  };
  const load = (path: string) => {
    const js = ts.transpileModule(source(path), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
    new Function('require', 'exports', js)((name: string) => { assert.ok(name in deps, name); return deps[name]; }, exports);
  };
  load('components/DashboardAssistantEntry.tsx'); load('components/SensiStandby.tsx');
  return exports;
}
test('homepage tap opens Sensi standby independently of model/mode readiness', () => {
  const ui = harness('missing'); let visible = false;
  const safety = Object.freeze({ check: null, conversation: null });
  const tree = ui.DashboardAssistantEntry({ mode: null, language: 'en', disabled: false, error: 'Gemma unavailable',
    onPress: () => openSensi(safety, open => { visible = open; }) });
  const button = nodes(tree).find(node => node.type === 'Pressable');
  assert.equal(button.props.disabled, false); button.props.onPress(); assert.equal(visible, true);
  assert.equal(sensiDestination(safety), 'standby');
});
test('tap with an active VoiceCheck preserves the current conversation and capture', () => {
  const check = Object.freeze({ episode: Object.freeze({ id: 'episode' }), captureId: 'capture', question: 'contact_offer', phase: 'listening' });
  const conversation = Object.freeze({ episodeId: 'episode', messages: Object.freeze(['existing prompt']), finished: false });
  const safety = Object.freeze({ check, conversation }); let standby = true;
  const ui = harness('present');
  const tree = ui.DashboardAssistantEntry({ mode: 'local', disabled: false,
    onPress: () => openSensi(safety, open => { standby = open; }) });
  nodes(tree).find(node => node.type === 'Pressable').props.onPress();
  assert.equal(standby, false); assert.equal(sensiDestination(safety), 'safety');
  assert.equal(safety.check, check); assert.equal(safety.conversation, conversation);
  assert.equal(safety.check.captureId, 'capture'); assert.equal(safety.check.question, 'contact_offer');
  // CORE's active check also stays in its existing modal without starting another.
  assert.equal(sensiDestination({ check, conversation: null }), 'safety');
});
for (const tokens of [light, dark]) {
  test(`${tokens === light ? 'Warm Pearl' : 'Soft Graphite'}: standby retains honest readiness and Try Sensi without a model row`, () => {
    const ui = harness('missing', tokens); let closed = false, tried = 0;
    const tree = ui.SensiStandby({ visible: true, mode: 'local', onClose: () => { closed = true; }, onTrySafetyCheck: () => { tried++; },
      drive: { driver: { id: 'driver' }, hasActiveSession: false, isConnected: false, connection: 'disconnected', voice: null } });
    const rendered = nodes(tree);
    const text = rendered.filter(node => node.type === 'Text').map(node => node.props.children).flat().join(' ');
    assert.match(text, /Hi, I'm Sensi!/); assert.match(text, /driving safety companion/);
    assert.doesNotMatch(text, /Gemma|Installation unverified/); assert.match(text, /Sensor connection needed/);
    assert.match(text, /Checked when a safety check starts/);
    assert.match(text, /Manual responses/); assert.doesNotMatch(text, /Voice recognition|Typed and button responses\./);
    assert.equal(rendered.find(node => node.type === 'SafeAreaView').props.style.backgroundColor, tokens.background);
    assert.equal(rendered.some(node => /TextInput|TypedResponse|ConversationThread/.test(String(node.type))), false);
    const buttons = rendered.filter(node => node.type === 'Btn'); assert.deepEqual(buttons.map(node => node.props.title), ['Try Sensi']);
    buttons[0].props.onPress(); assert.equal(tried, 1);
    assert.equal(rendered.filter(node => node.type === 'SensiGlyph').length, 1);
    assert.equal(rendered.filter(node => node.type === 'View' && node.props.accessible && node.props.accessibilityLabel).length, 3);
    assert.equal(rendered.find(node => node.type === 'ScrollView').props.contentContainerStyle.padding, 16);
    assert.ok(!rendered.some(node => node.props.numberOfLines));
    rendered.find(node => node.type === 'ScreenHeader').props.onBack(); assert.equal(closed, true);
    assert.equal(ui.SensiStandby({ visible: false }), null);
  });
}
test('file presence does not claim verified inference or bypass speech prerequisites', () => {
  const ready = standbyReadiness({ hasDriver: true, activeDrive: true, connected: true, voice: { granted: false, onDevice: false }, model: 'present', core: false }).join(' ');
  assert.match(ready, /Integrity and runtime availability are checked before use/);
  assert.match(ready, /Voice access or offline recognition is unavailable/);
});
test('Settings remains a separate tab; homepage handler cannot start/reset a check or ordinary chat', () => {
  const shell = source('components/SmartWheelScreen.tsx');
  const handler = shell.split('function openAssistant()')[1]!.split('// First run:')[0]!;
  assert.match(handler, /openSensi\(drive.safety, setAssistantOpen\)/);
  assert.doesNotMatch(handler, /setTab|rehearse|simulate|cancel|startSession|respondAlert|DriverAssistant/);
  assert.match(shell, /\['settings', 'Settings'\]/); assert.match(shell, /setTab\(key\)/);
  assert.match(shell, /standby=\{assistantOpen && sensiDestination\(drive.safety\) === 'standby'/);
  assert.match(shell, /<SensiSafetyConversation drive=\{drive\}/); assert.match(shell, /<VoiceCheckModal drive=\{drive\}/);
  assert.doesNotMatch(shell, /PHONE_CONNECTED_READINESS|<DriverAssistant/);
  const standby = source('components/SensiStandby.tsx');
  assert.doesNotMatch(standby, /prepareVoice|\.load\(|\.run\(|\.provision\(|TextInput|respondAlert|startSession/);
});


test('compact home hierarchy has exactly three indicators and no recognition or explanatory row text', () => {
  const ui=harness('present');
  const rendered=nodes(ui.SensiStandby({visible:true,drive:{driver:{id:'p'},connection:'connected',link:{source:'esp32'},safety:{monitoring:'active'}},onClose(){},onTrySafetyCheck(){}}));
  const text=rendered.filter(n=>n.type==='Text').flatMap(n=>n.props.children).join(' ');
  assert.match(text,/If DriveSense detects unusual health readings, I'll check in to see how you're feeling\./);
  assert.match(text,/Simulated safety check · No live emergency actions/);
  assert.doesNotMatch(text,/Meet Sensi|Experience a simulated safety check|Voice recognition|Integrity and runtime availability|playback is checked|Opens Safety Testing/);
  const headers=rendered.filter(n=>n.props.accessibilityRole==='header').map(n=>n.props.children);
  assert.deepEqual(headers,["Hi, I'm Sensi!",'System Readiness']);
  const rows=rendered.filter(n=>n.type==='View'&&n.props.accessible&&n.props.accessibilityLabel);
  assert.deepEqual(rows.map(n=>n.props.accessibilityLabel.split('. ')[0]),['Steering-wheel sensors','Voice responses','Manual responses']);
  assert.equal(rendered.filter(n=>n.type==='Feather').length,3);
  assert.match(rows[1].props.accessibilityLabel,/Checked when a safety check starts/);
  assert.equal(rendered.filter(n=>n.type==='SensiGlyph').length,1);
});

test('compact name/status rows wrap without fixed text heights or truncation', () => {
  const ui=harness('present');const rendered=nodes(ui.SensiStandby({visible:true,drive:{driver:{id:'p'},connection:'disconnected',safety:{}},onClose(){},onTrySafetyCheck(){}}));
  const rows=rendered.filter(n=>n.type==='View'&&n.props.accessible&&n.props.accessibilityLabel);
  for(const row of rows){
    assert.equal(row.props.style.flexDirection,'row');assert.equal(row.props.style.flexWrap,'wrap');
    const contents=nodes(row);const label=contents.find(n=>n.type==='Text');
    assert.equal(label.props.style.flexGrow,1);assert.equal(label.props.style.flexShrink,1);
    assert.ok(contents.some(n=>n.type==='View'&&n.props.style?.maxWidth==='100%'));
    for(const node of contents.filter(n=>n.type==='Text')){assert.equal(node.props.numberOfLines,undefined);assert.equal(node.props.style.height,undefined);assert.notEqual(node.props.allowFontScaling,false);}
  }
});

for (const tokens of [light, dark]) test(`home applies shared semantic color to each status and icon in ${tokens === light ? 'light' : 'dark'} mode`, () => {
  const ui = harness('present', tokens, { responses: 'available' });
  const rendered = nodes(ui.SensiStandby({ visible: true, drive: { driver: { id: 'p' }, connection: 'connecting', safety: {} }, onClose() {}, onTrySafetyCheck() {} }));
  const rows = rendered.filter(n => n.type === 'View' && n.props.accessible && n.props.accessibilityLabel);
  for (const [i, status, color] of [[0, 'Connecting', tokens.warning], [1, 'Available', tokens.connected], [2, 'Available', tokens.connected]] as const) {
    const row = rows[i]; assert.ok(row.props.accessibilityLabel.includes(status));
    const contents = nodes(row); assert.equal(contents.find(n => n.type === 'Feather').props.color, color);
    const text = contents.find(n => n.type === 'Text' && n.props.children === status);
    assert.ok(text); assert.equal(text.props.style.color, color);
  }
  assert.ok(rendered.some(n => n.type === 'Text' && n.props.children === 'Connecting sensors'));
});

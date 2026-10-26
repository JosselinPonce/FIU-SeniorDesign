import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { openSensi, sensiDestination, standbyReadiness, type GemmaFileStatus } from '../lib/assistant/sensiStandby.ts';
import { light, dark } from '../lib/theme/tokens.ts';
const require = createRequire(import.meta.url);
const source = (path: string) => readFileSync(new NodeURL('../' + path, import.meta.url), 'utf8');
function nodes(tree: any): any[] {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...nodes(tree.props?.children)];
}
function harness(model: GemmaFileStatus, tokens = light) {
  const exports: any = {};
  const deps: Record<string, unknown> = {
    react: { useState: () => [model, () => {}], useEffect() {} },
    'react/jsx-runtime': require('react/jsx-runtime'),
    'react-native': { Modal: 'Modal', SafeAreaView: 'SafeAreaView', Text: 'Text', View: 'View', Pressable: 'Pressable' },
    '../lib/theme/ThemeProvider': { useTheme: () => ({ tokens }) },
    '../lib/assistant/sensiStandby': { standbyReadiness },
    '../modules/gemma-poc/phone': { inspectGemmaModelFile: () => { throw Error('render must not load or verify a model'); } },
    './ui': { Btn: 'Btn' },
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
  test(`${tokens === light ? 'Warm Pearl' : 'Soft Graphite'}: unavailable Gemma still shows a read-only themed standby with honest readiness`, () => {
    const ui = harness('missing', tokens); let closed = false;
    const tree = ui.SensiStandby({ visible: true, mode: 'local', onClose: () => { closed = true; },
      drive: { driver: { id: 'driver' }, hasActiveSession: false, isConnected: false, voice: null } });
    const rendered = nodes(tree);
    const text = rendered.filter(node => node.type === 'Text').map(node => node.props.children).flat().join(' ');
    assert.match(text, /Hi, I'm Sensi!/); assert.match(text, /driver safety assistant/);
    assert.match(text, /Gemma model unavailable/); assert.match(text, /Waiting for.*sensor connection/);
    assert.match(text, /Voice readiness is checked/);
    assert.equal(rendered.find(node => node.type === 'SafeAreaView').props.style.backgroundColor, tokens.background);
    assert.equal(rendered.some(node => /TextInput|TypedResponse|ConversationThread/.test(String(node.type))), false);
    const buttons = rendered.filter(node => node.type === 'Btn'); assert.deepEqual(buttons.map(node => node.props.title), ['Back']);
    buttons[0].props.onPress(); assert.equal(closed, true);
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

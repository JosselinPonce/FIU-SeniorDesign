import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { URL as NodeURL } from 'node:url';
import ts from 'typescript';
import { light, dark, presentationColors } from '../lib/theme/tokens.ts';
import { conversationStatus, conversationMessage } from '../modules/local-foundation-models/conversationPolicy.ts';
import { nearThreadBottom, playbackLabel } from '../lib/assistant/threadPresentation.ts';
import { connectedUnavailableMessage } from '../lib/assistant/connectedPilotPolicy.ts';

const require = createRequire(import.meta.url);
const jsx = require('react/jsx-runtime');

// Execute the actual TSX render functions with host/hook adapters. Effects are
// registered, never run: no native APIs, preparation, speech or provider requests.
// This checks initial rendering, not native layout or React reconciliation.
function harness(theme: typeof light) {
  let hooks = 0;
  let stateIndex = 0;
  let overrides: Record<number, unknown> = {};
  const react = {
    useState(initial: unknown) { hooks++; const index = stateIndex++; return [index in overrides ? overrides[index] : initial, () => {}]; },
    useRef(value: unknown) { hooks++; return { current: value }; },
    useEffect() { hooks++; },
  };
  const native = Object.fromEntries(['View', 'Text', 'ScrollView', 'SafeAreaView', 'Pressable'].map(name => [name, name]));
  const forbidden = () => { throw new Error('Initial render must not access app services'); };
  const dependencies: Record<string, unknown> = {
    react, 'react/jsx-runtime': jsx, 'react-native': native,
    '../lib/theme/ThemeProvider': { useTheme: () => { hooks++; return { tokens: theme, colors: presentationColors(theme) }; } },
    '../lib/assistant/threadPresentation': { nearThreadBottom, playbackLabel },
    './ui': { Btn: 'Btn' }, '../lib/db/repositories': {},
    '../lib/voice/audioOwnership': { appAudio: { acquire: forbidden } },
    '../lib/voice/responsivenessDiagnostics': { responsivenessProbe: forbidden },
    './ResponsivenessDiagnostics': { ResponsivenessDiagnostics: 'Diagnostics' },
    '../modules/local-foundation-models/assistantConversation': { AssistantConversation: forbidden, CONVERSATION_REVISION: 'test' },
    '../modules/local-foundation-models/conversationPolicy': { conversationStatus, conversationMessage },
    '../modules/local-foundation-models': {},
    '../lib/assistant/phoneAssistantProvider': { phoneAssistantProvider: forbidden },
    '../lib/assistant/connectedPilotPolicy': { connectedUnavailableMessage },
  };
  function load(file: string) {
    const source = readFileSync(new NodeURL(`../components/${file}.tsx`, import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
    } }).outputText;
    const exports: Record<string, any> = {};
    new Function('require', 'exports', '__DEV__', compiled)((name: string) => {
      assert.ok(name in dependencies, `Unexpected runtime import: ${name}`); return dependencies[name];
    }, exports, true);
    return exports;
  }
  const { SensiConversationThread } = load('SensiConversationThread');
  dependencies['./SensiConversationThread'] = { SensiConversationThread };
  const { DriverAssistant } = load('DriverAssistant');
  const props = { visible: false, mode: 'local', language: 'en', ownershipKey: 'fixture', onClose: forbidden,
    contactAvailability: forbidden, captureOwnership: forbidden, handoff: forbidden };
  function render(visible: boolean, mode: string, stateOverrides: Record<number, unknown> = {}) {
    hooks = 0; stateIndex = 0; overrides = stateOverrides;
    const tree = DriverAssistant({ ...props, visible, mode });
    const driverHooks = hooks;
    const texts: string[] = [];
    const controls: any[] = [];
    function visit(node: any): void {
      if (node == null || typeof node === 'boolean') return;
      if (typeof node === 'string') { texts.push(node); return; }
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (typeof node.type === 'function') { visit(node.type(node.props)); return; }
      if (node.type === 'Pressable' || node.type === 'Btn') controls.push(node);
      visit(node.props?.children);
    }
    visit(tree);
    return { tree, driverHooks, texts, controls };
  }
  return render;
}

for (const [name, theme] of [['light', light], ['dark', dark]] as const) {
  test(`assistant hidden-to-visible initial render retains hook count and mounts empty thread (${name})`, () => {
    const render = harness(theme);
    const hidden = render(false, 'local'); assert.equal(hidden.tree, null);
    for (const mode of ['local', 'connected']) {
      const opened = render(true, mode);
      assert.equal(opened.driverHooks, hidden.driverHooks);
      assert.ok(opened.texts.includes('Sensi'));
      assert.ok(opened.texts.some(t => t.includes('Hi, I’m Sensi')));
      assert.ok(opened.texts.includes('Ready when you are'));
    }
  });
}

for (const theme of [light, dark]) {
  test('compact shell keeps one primary action, accessible Close and expandable truthful guidance', () => {
    const render = harness(theme);
    const idle = render(true, 'connected');
    assert.deepEqual(idle.controls.filter(c => c.type === 'Btn').map(c => c.props.title), ['Start conversation']);
    assert.ok(idle.controls.find(c => c.props.accessibilityLabel === 'Close assistant'));
    assert.equal(idle.controls.find(c => c.props.accessibilityLabel === 'Conversation information').props.accessibilityState.expanded, false);
    assert.equal(idle.texts.some(t => t.includes('Text is temporary')), false);
    const expanded = render(true, 'connected', { 6: true });
    assert.ok(expanded.texts.some(t => t.includes('Text is temporary')));
    assert.ok(expanded.texts.some(t => t.includes('does not confirm a connected call')));
    assert.ok(expanded.texts.some(t => t.includes('Wait for “Listening”')));
    assert.ok(expanded.texts.some(t => t.includes('sends final text responses online')));
    const busy = render(true, 'local', { 5: true });
    assert.deepEqual(busy.controls.filter(c => c.type === 'Btn').map(c => c.props.title), ['Stop conversation']);
    assert.ok(busy.controls.find(c => c.props.accessibilityLabel === 'Close assistant'));
    assert.ok(busy.controls.find(c => c.props.accessibilityLabel === 'Developer diagnostics'));
    for (const control of idle.controls.filter(c => c.type === 'Pressable')) {
      assert.ok(control.props.style.minHeight >= 44);
      assert.ok(control.props.style.minWidth >= 44);
    }
    const error = render(true, 'local', { 0: { phase: 'error', turns: [], transcript: '', timings: {}, message: 'test failure' } });
    assert.ok(error.texts.some(t => t.includes("I couldn't finish")), 'errors remain visible with information collapsed');
  });
}

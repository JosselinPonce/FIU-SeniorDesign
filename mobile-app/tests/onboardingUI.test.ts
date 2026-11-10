import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { light, dark } from '../lib/theme/tokens.ts';
import { GEMMA_ARTIFACT } from '../modules/gemma-poc/artifact.ts';
import { GEMMA_TERMS_TEXT, GEMMA_POLICY_TEXT } from '../lib/onboarding/gemmaTerms.ts';
import { GEMMA_TERMS_URL, GEMMA_POLICY_URL } from '../lib/onboarding/setup.ts';
const require = createRequire(import.meta.url);
const source = (path: string) => readFileSync(new NodeURL('../' + path, import.meta.url), 'utf8');
function harness(page: number, tokens = light, accepted = false, busy = false, education = 0, review = false) {
  const calls: any[] = []; let index = 0; let background: any;
  const controller = { state: { page, notices: accepted, terms: accepted, busy, modelReady: false, ready: false, recovery: false, error: '' },
    runtime: { state: { phase: 'Downloading model', installed: false, loaded: false, progress: { stage: 'download', completed: 120000000, total: GEMMA_ARTIFACT.bytes } } },
    subscribe: (fn: any) => { fn(controller.state); return () => {}; },
    cancel: () => calls.push('cancel'), acknowledge: (...args: any[]) => { calls.push(['ack', ...args]); }, go: (p: number) => calls.push(['go', p]),
    prepare: () => { calls.push('prepare'); }, complete: async () => { calls.push('complete'); return true; },
  };
  const deps: Record<string, any> = {
    '../lib/i18n/native': { LocalizedText: 'Text', LocalizedPressable: 'Pressable' },
    './LanguageMenu': { LanguageMenu: 'LanguageMenu' },
    '../lib/db/repositories': { getSetting: async () => null, setSetting: async (key: string, value: string) => { calls.push(['saved', key, value]); } },
    react: { useState: (initial: any) => { const current = index++; return [current === 1 && review ? page : current === 5 ? education : initial, (value: any) => calls.push(['state', value])]; }, useRef: (value: any) => ({ current: value }), useEffect: (fn: any) => fn() },
    'react/jsx-runtime': require('react/jsx-runtime'),
    'react-native': { ...Object.fromEntries(['Image', 'Modal', 'Pressable', 'SafeAreaView', 'ScrollView', 'Text', 'View'].map(n => [n, n])),
      StyleSheet: { hairlineWidth: 1 }, AppState: { addEventListener: (_: any, fn: any) => { background = fn; return { remove() {} }; } },
      Linking: { openURL: async () => {} } },
    '../lib/theme/ThemeProvider': { useTheme: () => ({ tokens }) }, '../lib/onboarding/setup': { GEMMA_TERMS_URL, GEMMA_POLICY_URL },
    '../lib/onboarding/gemmaTerms': { GEMMA_TERMS_TEXT, GEMMA_POLICY_TEXT }, '../modules/gemma-poc/artifact': { GEMMA_ARTIFACT },
    '../lib/voice/speechIO': { prepareVoice: async () => ({ granted: true }) },
    './BrandMark': { BrandMark: 'BrandMark' }, './DashboardAssistantEntry': { DashboardAssistantEntry: 'SensiIcon' },
    './VoicePicker': { VoicePicker: 'VoicePicker' }, './ui': { Btn: 'Btn' }, '../assets/branding/drivesense-logo.png': 'approved-logo',
  };
  const exports: any = {};
  new Function('require', 'exports', ts.transpileModule(source('components/Onboarding.tsx'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText)((name: string) => { assert.ok(name in deps, name); return deps[name]; }, exports);
  const tree = exports.Onboarding({ controller, review, onDone: () => calls.push('done'), onChooseDriver: () => calls.push('drivers') });
  const nodes: any[] = [];
  function visit(n: any) { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) { n.forEach(visit); return; }
    nodes.push(n); if (n.type === 'Modal' && !n.props.visible) return;
    if (typeof n.type === 'function') visit(n.type(n.props)); else visit(n.props?.children);
  }
  visit(tree);
  return { tree, nodes, controller, calls, background, text: nodes.filter(n => n.type === 'Text').flatMap(n => n.props.children).join(' ') };
}
for (const tokens of [light, dark]) test(`${tokens === light ? 'Warm Pearl' : 'Soft Graphite'} onboarding uses safe areas, approved branding and no Skip action`, () => {
  for (let page = 0; page < 6; page++) {
    const f = harness(page, tokens);
    assert.equal(f.tree.type, 'SafeAreaView'); assert.equal(f.tree.props.style.backgroundColor, tokens.background);
    assert.equal(f.nodes.some(n => n.type === 'Btn' && n.props.title === 'Skip'), false);
    assert.ok(f.nodes.some(n => n.type === 'ScrollView'));
    if (page === 0) assert.ok(f.nodes.some(n => n.type === 'Image' && n.props.source === 'approved-logo'));
  }
});

test('new baseline and alert slides persist progress without shifting notice/license gates', async () => {
  const baseline = harness(1, light, false, false, 1);
  assert.match(baseline.text, /Monitoring That’s Personal/);
  assert.match(baseline.text, /60 heart-rate readings/);
  assert.match(baseline.text, /oxygen is compared, never corrected/);
  baseline.nodes.find(node => node.type === 'Btn' && node.props.title === 'Next').props.onPress();
  await Promise.resolve(); await Promise.resolve();
  assert.ok(baseline.calls.some(call => Array.isArray(call) && call[0] === 'saved' && call[1] === 'setup_education_step' && call[2] === '2'));
  assert.equal(baseline.calls.some(call => Array.isArray(call) && call[0] === 'go'), false);
  const alerts = harness(1, light, false, false, 2);
  assert.match(alerts.text, /15 seconds.*8 seconds/);
  assert.match(alerts.text, /explicit consent/);
  alerts.nodes.find(node => node.type === 'Btn' && node.props.title === 'Next').props.onPress();
  assert.deepEqual(alerts.calls.at(-1), ['go', 2]);
});

test('onboarding exposes app language immediately and persists spoken defaults separately', async () => {
  assert.ok(harness(0).nodes.some(node => node.type === 'LanguageMenu'));
  const voice = harness(3);
  const spanish = voice.nodes.find(node => node.type === 'Btn' && node.props.title === 'Español');
  assert.ok(spanish); spanish.props.onPress();
  await Promise.resolve(); await Promise.resolve();
  assert.ok(voice.calls.some(call => Array.isArray(call) && call[0] === 'saved' && call[1] === 'voicecheck_default_language' && call[2] === 'es'));
  assert.equal(voice.calls.some(call => Array.isArray(call) && call[1] === 'app_language'), false);
});
test('notices and model terms have separate explicit checkbox and navigation gates', () => {
  for (const page of [2, 4]) {
    const f = harness(page); const checkbox = f.nodes.find(n => n.props.accessibilityRole === 'checkbox');
    assert.equal(checkbox.props.accessibilityState.checked, false); checkbox.props.onPress();
    assert.deepEqual(f.calls.at(-1), ['ack', page === 2 ? 'notices' : 'terms', true]);
    assert.equal(f.nodes.find(n => n.type === 'Btn' && n.props.title === 'Next').props.disabled, true);
    if (page === 4) {
      assert.equal(f.nodes.find(n => n.type === 'Btn' && /install Sensi/.test(n.props.title)).props.disabled, true);
      assert.ok(f.nodes.some(n => n.props.title === 'Read Gemma Terms of Use'));
      assert.ok(f.nodes.some(n => n.props.title === 'Read Gemma Prohibited Use Policy'));
    }
  }
});
test('install progress includes bytes, integrity/runtime status and cancellation on background', () => {
  const f = harness(4, light, true, true);
  assert.match(f.text, /120.0.*241.4.*MB/); assert.match(f.text, /Verification:/); assert.match(f.text, /Runtime:/);
  assert.ok(f.nodes.some(n => n.props.accessibilityRole === 'progressbar'));
  f.background('background'); assert.ok(f.calls.includes('cancel'));
  const g = harness(4, light, true, false);
  g.nodes.find(n => n.type === 'Btn' && /install Sensi/.test(n.props.title)).props.onPress();
  assert.ok(g.calls.includes('prepare'));
});
test('copy accurately separates foreground monitoring, recording, local inference and connected data', () => {
  assert.match(harness(1).text, /Start Drive controls trip recording/);
  assert.match(harness(1).text, /locked-phone VoiceCheck are not supported/);
  assert.match(harness(2).text, /not a medical device/); assert.match(harness(2).text, /Supabase/);
  assert.match(harness(2).text, /explicit request or agreement/);
  assert.match(harness(3).text, /not general chat/); assert.match(harness(3).text, /fixed rules/);
  assert.match(GEMMA_TERMS_TEXT, /Section 3/); assert.match(GEMMA_POLICY_TEXT, /You may not use/);
});
test('setup is launch-only, deferred for existing work, and preserves the normal profile selection path', () => {
  const shell = source('components/SmartWheelScreen.tsx');
  assert.match(shell, /if \(!ongoing\) void sensiSetup.boot/);
  assert.match(shell, /drive.safety.monitoring === 'active'/);
  assert.match(shell, /setupState.booted && !setupState.ready && !ongoing/);
  assert.match(shell, /<DriverPicker profiles=\{profiles\} onPick=\{setPendingDriver\}/);
  assert.match(shell, /drive.selectDriver\(pendingDriver\)/);
  assert.match(shell, /setupState.ready \|\| ongoing/);
  assert.doesNotMatch(source('lib/onboarding/setup.ts'), /createProfile|startSession|setRecordingSession|handoffContact|VoiceCheck\(/);
});


test('review reuses every onboarding page without setup writes, downloads or completion', async () => {
  for (let page = 0; page < 6; page++) {
    const f = harness(page, light, true, false, 2, true);
    assert.ok(f.nodes.some(n => n.props?.title === 'Return to application'));
    f.nodes.find(n => n.props?.title === 'Return to application').props.onPress();
    f.nodes.find(n => n.props?.title === 'Choose or create a driver').props.onPress();
    const next = f.nodes.find(n => n.props?.title === (page === 5 ? 'Continue to DriveSense' : 'Next'));
    assert.equal(next.props.disabled, false); next.props.onPress();
    await Promise.resolve(); await Promise.resolve();
    assert.equal(f.calls.some(c => c === 'prepare' || c === 'complete' || c === 'cancel' || Array.isArray(c) && ['saved','go','ack'].includes(c[0])), false);
    assert.ok(f.calls.includes('done')); assert.ok(f.calls.includes('drivers'));
  }
});

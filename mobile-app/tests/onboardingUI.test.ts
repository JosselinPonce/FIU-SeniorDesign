import * as sensiPresentation from '../lib/ui/sensiPresentation.ts';
import { SENSI_PROVIDERS } from '../lib/assistant/sensiPreferences.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { light, dark } from '../lib/theme/tokens.ts';
import { GEMMA_ARTIFACT } from '../modules/gemma-poc/artifact.ts';
import { GEMMA_TERMS_TEXT, GEMMA_POLICY_TEXT } from '../lib/onboarding/gemmaTerms.ts';
import { GEMMA_TERMS_URL, GEMMA_POLICY_URL, LEGACY_SETUP_KEY, NOTICE_VERSION, SETUP_KEY } from '../lib/onboarding/setup.ts';
const require = createRequire(import.meta.url);
const source = (path: string) => readFileSync(new NodeURL('../' + path, import.meta.url), 'utf8');
function harness(page: number, tokens = light, accepted = false, busy = false, education = 0, review = false) {
  const calls: any[] = []; let index = 0; let background: any;
  const controller = { state: { page, notices: accepted, terms: accepted, busy, modelReady: false, ready: false, recovery: false, error: '' },
    runtime: { state: { phase: 'Downloading model', installed: false, loaded: false, progress: { stage: 'download', completed: 120000000, total: GEMMA_ARTIFACT.bytes } } },
    subscribe: (fn: any) => { fn(controller.state); return () => {}; },
    cancel: () => calls.push('cancel'), acknowledge: (...args: any[]) => { calls.push(['ack', ...args]); }, go: (p: number) => calls.push(['go', p]),
    prepare: () => { calls.push('prepare'); }, complete: async () => { calls.push('complete'); return true; },
    continueWithoutGemma: async () => { calls.push('without model'); return true; },
  };
  const deps: Record<string, any> = {
    '../lib/i18n/native': { LocalizedText: 'Text', LocalizedPressable: 'Pressable' },
    './CloudPrivacyInfo': { CloudPrivacyInfo: 'CloudPrivacyInfo' }, '../lib/ui/sensiPresentation': sensiPresentation, '../lib/assistant/sensiPreferences': { SENSI_PROVIDERS },
    './LanguageMenu': { LanguageMenu: 'LanguageMenu' },
    '../lib/db/repositories': { getSetting: async () => null, setSetting: async (key: string, value: string) => { calls.push(['saved', key, value]); } },
    react: { useState: (initial: any) => { const current = index++; return [current === 1 && review ? page : current === 4 ? education : initial, (value: any) => calls.push(['state', value])]; }, useRef: (value: any) => ({ current: value }), useEffect: (fn: any) => fn() },
    'react/jsx-runtime': require('react/jsx-runtime'),
    'react-native': { ...Object.fromEntries(['Image', 'Modal', 'Pressable', 'SafeAreaView', 'ScrollView', 'Text', 'View'].map(n => [n, n])),
      StyleSheet: { hairlineWidth: 1 }, AppState: { addEventListener: (_: any, fn: any) => { background = fn; return { remove() {} }; } },
      Linking: { openURL: async () => {} } },
    '../lib/theme/ThemeProvider': { useTheme: () => ({ tokens }) }, '../lib/onboarding/setup': { GEMMA_TERMS_URL, GEMMA_POLICY_URL },
    '../lib/onboarding/gemmaTerms': { GEMMA_TERMS_TEXT, GEMMA_POLICY_TEXT }, '../modules/gemma-poc/artifact': { GEMMA_ARTIFACT },
    '../lib/voice/speechIO': { prepareVoice: async () => ({ granted: true }) },
    './SettingsGroup': { SettingsGroup: 'SettingsGroup', SettingsRow: 'SettingsRow', SettingsNote: 'SettingsNote' },
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
test('setup completion requires notice consent and has no model step', async () => {
  const f = harness(4, light, true);
  const button = f.nodes.find(n => n.props?.title === 'Continue to DriveSense');
  assert.equal(button.props.disabled, false);
  button.props.onPress();
  await Promise.resolve(); await Promise.resolve();
  assert.ok(f.calls.includes('complete'));
  assert.ok(f.calls.includes('done'));
  assert.ok(!f.calls.includes('prepare'));
  assert.equal(harness(4).nodes.find(n => n.props?.title === 'Continue to DriveSense').props.disabled, true);
});
for (const tokens of [light, dark]) test(`${tokens === light ? 'Warm Pearl' : 'Soft Graphite'} onboarding preserves notices and excludes model installation`, () => {
  for (let page = 0; page < 5; page++) {
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
test('safety notices retain an explicit checkbox gate and setup exposes no model tools', () => {
  const f = harness(2);
  const checkbox = f.nodes.find(n => n.props.accessibilityRole === 'checkbox');
  assert.equal(checkbox.props.accessibilityState.checked, false);
  checkbox.props.onPress();
  assert.deepEqual(f.calls.at(-1), ['ack', true]);
  assert.equal(f.nodes.find(n => n.props?.title === 'Next').props.disabled, true);
  for (let page = 0; page < 5; page++) {
    assert.doesNotMatch(harness(page).text, /Gemma|OpenAI|model installation/i);
  }
});

test('copy separates foreground monitoring, recording, built-in safety, and synchronization', () => {
  assert.match(harness(1).text, /Start Drive controls trip recording/);
  assert.match(harness(1).text, /locked-phone VoiceCheck are not supported/);
  assert.match(harness(2).text, /not a medical device/);
  assert.match(harness(2).text, /dashboard synchronization are separate/);
  assert.match(harness(2).text, /explicit request or agreement/);
  assert.match(harness(3).text, /built-in driving safety assistant/);
  assert.match(harness(3).text, /explicit authorization/);
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
  for (let page = 0; page < 5; page++) {
    const f = harness(page, light, true, false, 2, true);
    assert.ok(f.nodes.some(n => n.props?.title === 'Return to application'));
    f.nodes.find(n => n.props?.title === 'Return to application').props.onPress();
    f.nodes.find(n => n.props?.title === 'Choose or create a driver').props.onPress();
    const next = f.nodes.find(n => n.props?.title === (page === 4 ? 'Continue to DriveSense' : 'Next'));
    assert.equal(next.props.disabled, false); next.props.onPress();
    await Promise.resolve(); await Promise.resolve();
    assert.equal(f.calls.some(c => c === 'prepare' || c === 'complete' || c === 'cancel' || Array.isArray(c) && ['saved','go','ack'].includes(c[0])), false);
    assert.ok(f.calls.includes('done')); assert.ok(f.calls.includes('drivers'));
  }
});

test('built-in admission restores completed legacy notices and new setup saves no model state', async () => {
  const code = ts.transpileModule(source('lib/onboarding/builtInPhone.ts'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  function setup(settings: Map<string, string>) {
    const exports: any = {};
    const modules: Record<string, unknown> = {
      '../db/repositories': { getSetting: async (key: string) => settings.get(key) ?? null,
        setSetting: async (key: string, value: string) => { settings.set(key, value); } },
      './setup': { LEGACY_SETUP_KEY, NOTICE_VERSION, SETUP_KEY },
    };
    new Function('require', 'exports', code)((name: string) => { assert.ok(name in modules); return modules[name]; }, exports);
    return exports.sensiSetup;
  }
  const previous = setup(new Map([[SETUP_KEY, JSON.stringify({
    version: 2, noticeVersion: NOTICE_VERSION, notices: true, completed: true, page: 5, artifact: 'legacy',
  })]]));
  await previous.boot();
  assert.equal(previous.state.ready, true);
  const saved = new Map<string, string>();
  const current = setup(saved);
  await current.boot();
  await current.go(4);
  assert.equal(current.state.page, 0);
  await current.acknowledge(true);
  await current.go(4);
  assert.equal(await current.complete(), true);
  assert.deepEqual(JSON.parse(saved.get(SETUP_KEY)!), {
    version: 3, noticeVersion: NOTICE_VERSION, page: 4, notices: true, completed: true,
  });
});

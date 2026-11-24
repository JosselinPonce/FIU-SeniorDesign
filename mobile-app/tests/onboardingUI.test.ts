import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { light, dark } from '../lib/theme/tokens.ts';
import { translateText } from '../lib/i18n/translate.ts';
import * as driverProgress from '../lib/onboarding/driverProgress.ts';
import { LEGACY_SETUP_KEY, NOTICE_VERSION, SETUP_KEY } from '../lib/onboarding/setup.ts';
const require = createRequire(import.meta.url);
const source = (path: string) => readFileSync(new NodeURL('../' + path, import.meta.url), 'utf8');
const compilerOptions = { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 };
function load(path: string, deps: Record<string, unknown>) {
  const exports: any = {};
  new Function('require', 'exports', ts.transpileModule(source(path), { compilerOptions }).outputText)(
    (name: string) => { assert.ok(name in deps, name); return deps[name]; }, exports);
  return exports;
}
function harness(page: number, tokens = light, accepted = false, review = false, language: 'en' | 'es' = 'en', askOpen = false) {
  const calls: any[] = [];
  let index = 0;
  const controller = { state: { page, notices: accepted, busy: false, error: '' },
    subscribe: () => () => {}, acknowledge: (value: boolean) => { calls.push(['ack', value]); },
    go: (value: number) => calls.push(['go', value]), complete: async () => { calls.push('complete'); return true; },
  };
  const { Onboarding } = load('components/Onboarding.tsx', {
    '../lib/i18n/native': { LocalizedText: 'Text', LocalizedPressable: 'Pressable' },
    '../lib/i18n/LanguageProvider': { useAppLanguage: () => ({ t: (key: string) => translateText(key, language) }) },
    '../lib/db/repositories': { getSetting: async () => null, setSetting: async (...args: unknown[]) => { calls.push(['saved', ...args]); } },
    './LanguageMenu': { LanguageMenu: 'LanguageMenu' },
    react: { useState: (initial: unknown) => { const i = index++; return [i === 1 && review ? page : i === 3 && askOpen ? true : initial, (value: unknown) => calls.push(['state', value])]; }, useEffect: (fn: () => void) => fn() },
    'react/jsx-runtime': require('react/jsx-runtime'),
    'react-native': { ...Object.fromEntries(['Image', 'SafeAreaView', 'ScrollView', 'View'].map(n => [n, n])), StyleSheet: { hairlineWidth: 1 } },
    'expo/node_modules/@expo/vector-icons/Feather': { __esModule: true, default: 'Feather' },
    '../lib/theme/ThemeProvider': { useTheme: () => ({ tokens }) },
    '../lib/voice/speechIO': { prepareVoice: async () => ({ granted: true }) },
    './DashboardAssistantEntry': { SensiGlyph: 'SensiGlyph' },
    './VoicePicker': { VoicePicker: 'VoicePicker' }, './ui': { Btn: 'Btn' }, './AskSensi': { AskSensi: 'AskSensi' },
    '../assets/branding/drivesense-logo.png': 'approved-logo',
  });
  const tree = Onboarding({ controller, review, driverId: 'driver-a', onDone: () => calls.push('done'), onLeave: () => calls.push('leave') });
  const nodes: any[] = [];
  function visit(n: any) {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(visit); return; }
    nodes.push(n); visit(n.props?.children);
  }
  visit(tree);
  return { tree, nodes, calls, button: (title: string) => nodes.find(n => n.props?.title === title).props,
    text: nodes.filter(n => n.type === 'Text').flatMap(n => n.props.children).join(' ') };
}

test('all six real stages report matching progress and render in both themes', () => {
  for (const palette of [light, dark]) for (let page = 0; page < 6; page++) {
    const f = harness(page, palette, false, false, 'es');
    assert.equal(f.tree.props.style.backgroundColor, palette.background);
    assert.deepEqual(f.nodes.find(n => n.props?.accessibilityRole === 'progressbar').props.accessibilityValue, { min: 0, max: 6, now: page + 1 });
    assert.match(f.text, new RegExp('Paso ' + (page + 1) + ' de 6'));
    assert.ok(f.nodes.some(n => n.type === 'ScrollView'));
    if (!page) assert.ok(f.nodes.some(n => n.type === 'Image' && n.props.source === 'approved-logo'));
  }
});

test('onboarding keeps optional native voice, separate Ask settings, and explicit safety acknowledgment', async () => {
  assert.match(harness(1).text, /locked-phone VoiceCheck are not supported/);
  assert.match(harness(2).text, /60 qualifying heart-rate readings/);
  assert.match(harness(2).text, /15-second warning.*8-second critical/);
  const voice = harness(3);
  assert.ok(voice.nodes.some(n => n.type === 'SensiGlyph'));
  assert.match(voice.text, /Speech is processed on this phone/);
  assert.match(voice.text, /iOS asks for confirmation/);
  voice.button('Spanish').onPress();
  await Promise.resolve();
  assert.ok(voice.calls.some(c => Array.isArray(c) && c[1] === 'voicecheck_default_language' && c[2] === 'es'));
  const ask = harness(4, light, false, false, 'en', true);
  const settings = ask.nodes.find(n => n.type === 'AskSensi');
  assert.equal(settings.props.driverId, 'driver-a');
  assert.equal(settings.props.settingsOnly, true);
  assert.match(ask.text, /requires separate approval/);
  assert.doesNotMatch(source('components/Onboarding.tsx'), /createAskSensiClient|sendAsk\(/);
  const gate = harness(5);
  assert.equal(gate.button('Continue to DriveSense').disabled, true);
  gate.nodes.find(n => n.props?.accessibilityRole === 'checkbox').props.onPress();
  assert.deepEqual(gate.calls.at(-1), ['ack', true]);
  assert.match(gate.text, /not a medical device/);
  const completed = harness(5, light, true);
  completed.button('Continue to DriveSense').onPress();
  await Promise.resolve();
  assert.deepEqual(completed.calls.filter(c => typeof c === 'string'), ['complete', 'done']);
});

test('review offers a single close action and does not update setup progress', async () => {
  for (let page = 0; page < 6; page++) {
    const f = harness(page, dark, false, true);
    assert.equal(f.nodes.filter(n => n.props?.title === 'Close review').length, 1);
    f.button('Close review').onPress();
    f.button(page === 5 ? 'Continue to DriveSense' : 'Next').onPress();
    await Promise.resolve();
    assert.ok(f.calls.includes('leave'));
    assert.ok(!f.calls.includes('complete'));
    assert.ok(!f.nodes.some(n => n.props?.accessibilityRole === 'checkbox'));
  }
});

test('driver-scoped setup migrates legacy completion, starts new drivers clean, and resumes without affecting another driver', async () => {
  const { driverIntroKey, newDriverIntro } = driverProgress;
  const settings = new Map<string, string>([[SETUP_KEY, JSON.stringify({
    version: 3, noticeVersion: NOTICE_VERSION, notices: true, completed: true, page: 4,
  })], [driverIntroKey('new'), newDriverIntro]]);
  const app = load('lib/onboarding/builtInPhone.ts', {
    '../db/repositories': { getSetting: async (key: string) => settings.get(key) ?? null,
      setSetting: async (key: string, value: string) => { settings.set(key, value); } },
    './driverProgress': driverProgress, './setup': { LEGACY_SETUP_KEY, NOTICE_VERSION, SETUP_KEY },
  });
  assert.equal((await app.setupForDriver('existing')).state.ready, true);
  let pending = await app.setupForDriver('new');
  assert.equal(pending.state.ready, false);
  assert.equal(pending.state.notices, false);
  await pending.go(3);
  pending = await app.setupForDriver('new');
  assert.equal(pending.state.page, 3);
  await pending.go(5);
  assert.equal(await pending.complete(), false);
  await pending.acknowledge(true);
  assert.equal(await pending.complete(), true);
  assert.equal((await app.setupForDriver('new')).state.ready, true);
  assert.equal((await app.setupForDriver('existing')).state.ready, true);
  assert.match(source('lib/db/repositories.ts'), /withExclusiveTransactionAsync[\s\S]*driverIntroKey\(profile.id\), newDriverIntro/);
  assert.match(source('components/SmartWheelScreen.tsx'), /await setupForDriver\(profile.id\)/);
  assert.match(source('components/DriverPicker.tsx'), /if \(savingProfile.current\) return/);
});

test('personalized monitoring uses four consistent scrollable cards with unchanged technical copy', () => {
  const copy = [
    ['Your personal reference', 'Your profile sets starting ranges. At least 60 qualifying heart-rate readings from finished drives are needed to establish a personal reference.'],
    ['Adaptive baseline', 'DriveSense uses recent drives from 28 days, extending to the last 10 drives when needed. Poor-quality readings and periods around NOT OK or unanswered events are excluded.'],
    ['Reference-device calibration', 'The reference refreshes after saved drives. Optional reference-device calibration corrects heart rate only; oxygen is compared, never corrected. Calibration is not required to start monitoring.'],
    ['How alerts are confirmed', 'Tracking uses a 15-second warning window or an 8-second critical window. Only sustained, usable evidence can confirm an event and start VoiceCheck.'],
  ];
  for (const tokens of [light, dark]) {
    const { tree, nodes } = harness(2, tokens);
    const [header, scroll, footer] = tree.props.children;
    assert.equal(scroll.type, 'ScrollView');
    assert.ok(header.props.children[0].props.children.some((node: any) => node.props.title === 'Finish later'));
    assert.deepEqual(footer.props.children.map((node: any) => node.props.title), ['Back', 'Next']);
    const cards = nodes.filter(node => node.props?.style?.backgroundColor === tokens.surfaceMuted);
    assert.equal(cards.length, 4);
    assert.equal(new Set(cards.map((card: any) => JSON.stringify(card.props.style))).size, 1);
    for (const [i, card] of cards.entries()) {
      const [icon, content] = card.props.children;
      assert.equal(icon.type, 'Feather');
      const [heading, body] = content.props.children;
      assert.deepEqual([heading.props.children, body.props.children], copy[i]);
      assert.equal(body.props.style.color, tokens.textSecondary);
      assert.equal(body.props.numberOfLines, undefined);
      for (const text of copy[i]) assert.notEqual(translateText(text, 'es'), text);
    }
  }
});

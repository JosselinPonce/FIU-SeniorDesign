import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { URL as NodeURL } from 'node:url';
import ts from 'typescript';
import { HomeHardwareDemo, type HomeHardwareDemoSnapshot } from '../lib/diagnostics/homeHardwareDemo.ts';
import { thresholds } from '../lib/analysis/flagEngine.ts';
import { profilePrior, personalBand } from '../lib/analysis/profileModel.ts';
import type { Frame } from '../lib/ble/protocol.ts';
import type { SignalQuality } from '../lib/analysis/signal.ts';
import type { DriverProfile } from '../lib/db/repositories.ts';

Object.assign(globalThis, { __DEV__: true });

const driver = {
  id: 'driver', updated_at: '1', display_name: 'Driver', language: 'en',
  emergency_name: 'Test Contact', emergency_phone: '+1 (202) 555-0124',
} as DriverProfile;
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

const prior = profilePrior({ age: 40, sex: 'female', weight_kg: 70, height_cm: 165, conditions: [], medications: [] });
const reference = thresholds(prior, personalBand(prior, null));

function fixture(prepareVoice = async () => ({ granted: true, onDevice: true })) {
  let now = 10_000;
  let selected = { ...driver };
  let saved = { ...driver };
  let account: string | null = null;
  let currentContext = true;
  let sequence = 0;
  let frameSequence = 0;
  let state!: HomeHardwareDemoSnapshot;
  let releases = 0;
  let readBarrier: Promise<void> | undefined;
  const urls: string[] = [];
  const spoken: string[] = [];
  const demo = new HomeHardwareDemo({
    currentContext: () => currentContext,
    driver: () => selected,
    account: () => account,
    readDriver: async () => { if (readBarrier) await readBarrier; return saved; },
    prepareVoice,
    thresholds: () => reference,
    voiceIO: () => ({ speak: async text => { spoken.push(text); }, listen: async () => new Promise(() => {}), cancel() {} }),
    releaseAudio: () => { releases++; },
    openURL: async url => { urls.push(url); },
    change: next => { state = next; },
    now: () => now,
    id: () => String(++sequence),
  });
  function scope() {
    const check = state.safety?.check;
    assert.ok(check);
    return { episodeId: check.episode.id, captureId: check.captureId, question: check.question };
  }
  async function review() {
    const running = demo.trigger();
    await flush();
    const wellness = scope();
    assert.equal(demo.answer('not_ok', wellness), true);
    await flush();
    const offer = scope();
    assert.equal(offer.question, 'contact_offer');
    assert.equal(demo.answer('call_yes', wellness), false);
    assert.equal(demo.answer('call_yes', offer), true);
    assert.equal(await running, true);
    return state.confirmation!;
  }
  function feed(bpm: number, opts: { age?: number; missing?: number; quality?: number; feasible?: boolean; seq?: number; spo2?: number; finger?: boolean; phoneHr?: number } = {}) {
    now += 1000;
    const seq = opts.seq ?? ++frameSequence;
    const frame = { seq, version: 3, endMs: seq * 1000, finger: opts.finger ?? true, usable: true,
      heartRate: bpm, spo2: opts.spo2 ?? 98, quality: opts.quality ?? 90 } as Frame;
    const signal: SignalQuality = { good: false, hrBeats: opts.phoneHr ?? bpm, beats: 12, templateR: 0.8, skewness: 0.2,
      perfusion: 0.5, feasible: opts.feasible ?? true, agree: true };
    demo.frame(frame, now - (opts.age ?? 0), opts.missing ?? 0, signal, bpm);
  }
  return { demo, scope, review, urls, spoken, feed, state: () => state, releases: () => releases,
    saved: (update: Partial<DriverProfile>) => { saved = { ...saved, ...update }; },
    driver: (update: Partial<DriverProfile>) => { selected = { ...selected, ...update }; },
    account: (next: string | null) => { account = next; },
    context: (enabled: boolean) => { currentContext = enabled; },
    holdSavedRead: (barrier: Promise<void>) => { readBarrier = barrier; },
    advance: (ms: number) => { now += ms; },
  };
}

test('Home Demo launches an isolated simulated warning offline and requires two explicit steps to open the dialer', async () => {
  const f = fixture();
  assert.equal(await f.demo.trigger(), false);
  assert.equal(f.demo.enable(), true);
  const review = await f.review();
  assert.equal(f.state().safety?.conversation?.simulation, true);
  assert.equal(f.state().safety?.conversation?.cloudSimulation, false);
  assert.equal(f.state().safety?.conversation?.finished, true);
  assert.equal(f.state().safety?.last?.result.contactCall, 'accepted_offer');
  assert.ok(f.spoken.length >= 3);
  assert.deepEqual(review, { id: 'home-hardware-demo-1', name: 'Test Contact', phone: '+12025550124' });
  assert.deepEqual(f.urls, []);
  await f.demo.confirm('live-production-episode');
  assert.deepEqual(f.urls, []);
  await Promise.all([f.demo.confirm(review.id), f.demo.confirm(review.id)]);
  assert.deepEqual(f.urls, ['tel:+12025550124']);
  assert.equal(f.state().result, 'requested');
  assert.equal(f.releases(), 1);
  f.demo.stop();
  assert.equal(f.state().enabled, false);
  assert.equal(f.state().safety, null);
});

test('Home Demo excludes absent, unnamed and short-code saved contacts', () => {
  for (const update of [{ emergency_name: '' }, { emergency_phone: '' }, { emergency_phone: '911' }, { emergency_phone: '112' }]) {
    const f = fixture();
    f.driver(update);
    assert.equal(f.demo.enable(), false);
  }
});

test('Home Demo refuses stale contact, account, expiry, shutdown and context at the native boundary', async () => {
  for (const invalidate of [
    (f: ReturnType<typeof fixture>) => f.saved({ emergency_phone: '+12025550125' }),
    (f: ReturnType<typeof fixture>) => f.account('different-account'),
    (f: ReturnType<typeof fixture>) => f.driver({ id: 'other-driver' }),
    (f: ReturnType<typeof fixture>) => f.advance(30_000),
    (f: ReturnType<typeof fixture>) => f.demo.stop(),
    (f: ReturnType<typeof fixture>) => f.demo.cancelEpisode(),
    (f: ReturnType<typeof fixture>) => f.context(false),
  ]) {
    const f = fixture();
    assert.equal(f.demo.enable(), true);
    const review = await f.review();
    invalidate(f);
    await f.demo.confirm(review.id);
    assert.deepEqual(f.urls, []);
    assert.equal(f.state().confirmation, null);
  }
});

test('Home Demo cancellation and episode replacement invalidate a stale permit', async () => {
  const f = fixture();
  assert.equal(f.demo.enable(), true);
  const first = await f.review();
  f.demo.cancelEpisode();
  const next = await f.review();
  assert.notEqual(first.id, next.id);
  await f.demo.confirm(first.id);
  assert.deepEqual(f.urls, []);
  assert.equal(f.state().confirmation?.id, next.id);
  f.demo.stop();
});

test('declining the current offer finishes without a permit', async () => {
  const f = fixture();
  assert.equal(f.demo.enable(), true);
  const running = f.demo.trigger();
  await flush();
  assert.equal(f.demo.answer('not_ok', f.scope()), true);
  await flush();
  assert.equal(f.demo.answer('call_no', f.scope()), true);
  await running;
  assert.equal(f.state().safety?.last?.result.contactCall, 'declined_offer');
  assert.equal(f.state().confirmation, null);
  assert.deepEqual(f.urls, []);
});

test('compact demo controls show readiness, qualify the displayed snapshot and disclose diagnostics', () => {
  const source = readFileSync(new NodeURL('../components/HomeHardwareDemo.tsx', import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } });
  const require = createRequire(import.meta.url);
  const exports: any = {};
  const slots: unknown[] = [];
  let index = 0;
  const mocks: Record<string, unknown> = {
    react: { useState: (initial: unknown) => {
      const i = index++;
      slots[i] ??= initial;
      return [slots[i], (next: any) => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }];
    } },
    'react/jsx-runtime': require('react/jsx-runtime'),
    'react-native': { View: 'View', useWindowDimensions: () => ({ fontScale: 1 }) },
    '../lib/i18n/native': { LocalizedText: 'Text', LocalizedPressable: 'Pressable' },
    '../lib/analysis/sensorContinuity': { SENSOR_STALE_MS: 3000 },
    '../lib/theme/ThemeProvider': { useTheme: () => ({ tokens: {} }) },
    './ui': { Card: 'Card', Row: 'Row', SectionTitle: 'Title', Pill: 'Pill' },
    './charts': { Waveform: 'Waveform' },
  };
  new Function('require', 'exports', outputText)((id: string) => mocks[id], exports);
  let enabled = 0, triggered = 0, stopped = 0;
  const drive = {
    homeHardwareDemoControls: { enable: () => { enabled++; drive.homeHardwareDemo.enabled = true; return true; },
      configureSimulation: (change: object) => Object.assign(drive.homeHardwareDemo.simulation, change),
      trigger: () => { triggered++; }, stop: () => { stopped++; } },
    homeHardwareDemo: { enabled: false, phase: 'idle', actual: { at: 10_000, hr: 86, spo2: 98, finger: true },
      simulation: { enabled: false, scenario: 'high_hr', mode: 'automatic' }, projected: { value: 114, offset: 28 } as { value: number; offset: number } | null,
      confirmationWindow: { slots: 5, required: 5, accepted: 4, beyond: 4 } },
    isConnected: true, link: { source: 'relay', connectedAt: new Date(9900) }, relay: { esp: true },
    lastRx: new Date(10_000), homeDemoWaveform: { at: 10_000, samples: [{ ir: 800, red: 400 }] }, finger: true, quality: 92, signal: { good: false }, hasActiveSession: false,
  };
  const nodes = (node: any): any[] => Array.isArray(node) ? node.flatMap(nodes)
    : node?.props ? [node, ...nodes(node.props.children)] : [];
  const view = (now: number) => { index = 0; return nodes(exports.HomeHardwareDemo({ drive, now })); };
  const diagnostics = (now: number) => { index = 2; return nodes(exports.HardwareDemoDiagnostics({ drive, now, children: { props: { sentinel: 'history' } } })); };
  const row = (items: any[], label: string) => items.find(node => node.props.label === label)?.props.value;
  const pressable = (items: any[], role: string) => items.find(node => node.props.accessibilityRole === role).props;
  const segment = (items: any[], label: string) => items.find(node => node.props.labels?.includes(label)).props;
  const action = (items: any[], label: string) => items.find(node => node.props.label === label)?.props;
  const hasText = (items: any[], text: string) => items.some(node => node.props.children === text);
  assert.ok(hasText(view(10_200), 'Hardware Demo'));
  pressable(view(10_200), 'button').onPress();
  assert.ok(hasText(view(10_200), 'Connected'));
  pressable(view(10_200), 'switch').onPress();
  assert.equal(enabled, 1);
  const live = view(10_200);
  const vitals = () => exports.demoVitalPresentation(drive, 10_200);
  assert.deepEqual(vitals().projected, { value: 114, offset: 28 });
  assert.equal(vitals().sourceValue, 86);
  assert.ok(!hasText(live, '114 BPM'));
  drive.lastRx = new Date(10_100);
  assert.equal(vitals().projected, null, 'a later rejected or skipped frame hides the older projection');
  drive.lastRx = new Date(10_000);
  assert.ok(hasText(live, 'Ready to Simulate'));
  pressable(live, 'button').onPress();
  const collapsed = view(10_200);
  assert.ok(collapsed.some(node => Array.isArray(node.props.children) && node.props.children.includes('Simulation enabled')));
  assert.ok(!collapsed.some(node => node.props.accessibilityRole === 'switch' || node.props.labels));
  assert.equal(pressable(collapsed, 'button').accessibilityState.expanded, false);
  assert.equal(drive.homeHardwareDemo.simulation.enabled, true);
  assert.deepEqual(vitals().projected, { value: 114, offset: 28 });
  pressable(collapsed, 'button').onPress();
  assert.equal(pressable(view(10_200), 'switch').accessibilityState.checked, true);
  assert.equal(row(live, 'ESP32 quality'), undefined);
  assert.ok(!diagnostics(10_200).some(item => item.props.sentinel === 'history'));
  pressable(diagnostics(10_200), 'button').onPress();
  const advanced = diagnostics(10_200);
  assert.ok(advanced.some(item => item.props.sentinel === 'history'));
  assert.deepEqual(advanced.filter(item => item.type === 'Waveform').map(item => item.props.values), [[800], [400]]);
  assert.ok(!diagnostics(13_000).some(item => item.type === 'Waveform'));
  assert.equal(row(advanced, 'ESP32 quality'), '92%');
  assert.equal(row(advanced, 'Phone waveform quality'), 'Not qualified');
  assert.equal(row(advanced, 'Reading freshness'), '0.2 s');
  assert.equal(row(advanced, 'Confirmation slots'), '5 / 5');
  assert.equal(row(advanced, 'Accepted readings'), '4');
  segment(live, 'Low SpO₂').onChange(true);
  segment(live, 'Manual').onChange(true);
  assert.equal(drive.homeHardwareDemo.simulation.scenario, 'low_spo2');
  assert.equal(drive.homeHardwareDemo.simulation.mode, 'manual');
  assert.equal(exports.demoVitalPresentation(drive, 13_000).projected, null);
  assert.equal(row(diagnostics(13_000), 'Reading freshness'), 'Stale · last reading');
  drive.homeHardwareDemo.actual.finger = false;
  drive.homeHardwareDemo.projected = null;
  assert.ok(hasText(view(10_200), 'Waiting for Finger Contact'));
  drive.homeHardwareDemo.actual.finger = true;
  assert.ok(hasText(view(10_200), 'Collecting Valid Readings'));
  drive.link.connectedAt = new Date(10_100);
  assert.equal(vitals().sourceValue, null);
  drive.relay.esp = false;
  assert.equal(row(diagnostics(10_200), 'Hardware connection'), 'Disconnected');
  action(diagnostics(10_200), 'Trigger Demo Emergency').onPress();
  assert.equal(triggered, 1);
  drive.hasActiveSession = true;
  assert.equal(action(diagnostics(10_200), 'Trigger Demo Emergency'), undefined);
  action(diagnostics(10_200), 'Stop Hardware Demo Mode').onPress();
  assert.equal(stopped, 1);
  pressable(view(10_200), 'switch').onPress();
  assert.equal(drive.homeHardwareDemo.simulation.enabled, false);
  assert.equal(vitals().projected, null);

});

test('account changes during the saved-contact reread invalidate the one-use permit', async () => {
  const f = fixture();
  assert.equal(f.demo.enable(), true);
  const pending = await f.review();
  let release!: () => void;
  f.holdSavedRead(new Promise<void>(resolve => { release = resolve; }));
  const opening = f.demo.confirm(pending.id);
  f.account('replacement');
  f.demo.tick();
  release();
  await opening;
  assert.equal(f.state().enabled, false);
  assert.deepEqual(f.urls, []);
});

test('Home Demo connection entry reuses the driver-owned BLE stream and has no recording or upload step', () => {
  const source = readFileSync(new NodeURL('../lib/hooks/useDriveSession.ts', import.meta.url), 'utf8');
  const controls = source.slice(source.indexOf('const homeHardwareDemoControls'), source.indexOf('const respondAlert'));
  assert.match(controls, /homeDemo\.enable\(\)[^]*if \(enabled\) connection\.start\(\)/);
  assert.doesNotMatch(controls, /new WheelConnection|startSession|live\.follow|syncToSupabase/);
});

test('sensor-derived high HR confirms the projection and opens the real adapter only after explicit scoped consent', async () => {
  const f = fixture();
  assert.equal(f.demo.enable(), true);
  f.demo.configureSimulation({ enabled: true });
  for (let i = 0; i < 7; i++) f.feed(85);
  assert.equal(f.state().phase, 'idle');
  f.feed(86);
  await flush();
  const wellness = f.scope();
  assert.equal(f.state().liveEpisode, true);
  assert.match(wellness.episodeId, /^home-biometric-simulation-/);
  assert.equal(f.state().safety?.check?.episode.value, reference.highWarn + 3);
  assert.ok(f.spoken.some(text => /simulated biometric abnormality/.test(text)));
  assert.deepEqual(f.urls, []);
  assert.equal(f.demo.answer('not_ok', wellness), true);
  await flush();
  assert.ok(f.spoken.some(text => /open the iPhone dialer/.test(text)));
  assert.ok(f.spoken.some(text => /may start a real call/.test(text)));
  const offer = f.scope();
  assert.equal(f.demo.answer('call_yes', wellness), false);
  assert.deepEqual(f.urls, []);
  assert.equal(f.demo.answer('call_yes', offer), true);
  assert.equal(f.demo.answer('call_yes', offer), false);
  await flush();
  assert.equal(f.state().confirmation, null);
  assert.deepEqual(f.urls, ['tel:+12025550124']);
  await f.demo.confirm(offer.episodeId);
  assert.deepEqual(f.urls, ['tel:+12025550124']);
});

test('manual below-threshold projections, rejected frames and prior-mode readings cannot confirm', async () => {
  for (const bpm of [40, 32, 85]) {
    const f = fixture();
    assert.equal(f.demo.enable(), true);
    f.demo.configureSimulation({ enabled: true, mode: 'manual', hrIncrease: 0 });
    for (let i = 0; i < 12; i++) f.feed(bpm);
    assert.equal(f.state().phase, 'idle');
  }
  const f = fixture();
  assert.equal(f.demo.enable(), true);
  f.demo.configureSimulation({ enabled: true });
  for (let i = 0; i < 7; i++) f.feed(85);
  f.demo.configureSimulation({ enabled: false });
  f.feed(85);
  f.demo.configureSimulation({ enabled: true });
  for (let i = 0; i < 7; i++) f.feed(85);
  assert.equal(f.state().phase, 'idle');
  f.feed(85, { age: 3000 });
  f.feed(85, { missing: 1 });
  for (let i = 0; i < 12; i++) f.feed(85, { feasible: false });
  assert.equal(f.state().phase, 'idle');
  assert.deepEqual(f.urls, []);
});

test('live consent cannot open after stale telemetry, cancellation, or context loss during contact reread', async () => {
  for (const invalidate of [
    (f: ReturnType<typeof fixture>) => f.advance(3000),
    (f: ReturnType<typeof fixture>) => f.demo.cancelEpisode(),
    (f: ReturnType<typeof fixture>) => f.context(false),
    (f: ReturnType<typeof fixture>) => f.feed(85, { missing: 1 }),
  ]) {
    const f = fixture();
    assert.equal(f.demo.enable(), true);
    f.demo.configureSimulation({ enabled: true });
    for (let i = 0; i < 8; i++) f.feed(85);
    await flush();
    assert.equal(f.demo.answer('not_ok', f.scope()), true);
    await flush();
    let release!: () => void;
    f.holdSavedRead(new Promise<void>(resolve => { release = resolve; }));
    assert.equal(f.demo.answer('call_yes', f.scope()), true);
    await flush();
    invalidate(f);
    release();
    await flush();
    assert.deepEqual(f.urls, []);
  }
});

test('Home enable and live arming share voice preflight without blocking live confirmation', async () => {
  let requests = 0;
  let finish!: (result: { granted: boolean; onDevice: boolean }) => void;
  const pending = new Promise<{ granted: boolean; onDevice: boolean }>(resolve => { finish = resolve; });
  const f = fixture(() => { requests++; return pending; });
  assert.equal(f.demo.enable(), true);
  f.demo.configureSimulation({ enabled: true });
  await flush();
  assert.equal(requests, 1);
  for (let i = 0; i < 10 && f.state().phase !== 'checking'; i++) f.feed(82);
  await flush();
  assert.equal(f.state().phase, 'checking');
  assert.equal(f.demo.answer('ok', f.scope()), true);
  f.demo.stop();
  finish({ granted: true, onDevice: true });
  await flush();
  assert.equal(f.state().enabled, false);
});

test('Home manual trigger remains answerable after permission preflight fails', async () => {
  const f = fixture(async () => ({ granted: false, onDevice: false }));
  assert.equal(f.demo.enable(), true);
  await flush();
  const running = f.demo.trigger();
  await flush();
  assert.equal(f.demo.answer('ok', f.scope()), true);
  assert.equal(await running, true);
});

test('automatic offsets use changing live inputs and the selected production threshold', () => {
  const f = fixture();
  f.demo.enable();
  f.demo.configureSimulation({ enabled: true });
  f.feed(95);
  assert.equal(f.state().actual?.hr, 95);
  assert.deepEqual(f.state().projected, { value: reference.highWarn + 3, offset: reference.highWarn + 3 - 95 });
  f.feed(90);
  assert.deepEqual(f.state().projected, { value: reference.highWarn + 3, offset: reference.highWarn + 3 - 90 });
  f.demo.configureSimulation({ scenario: 'low_spo2' });
  assert.equal(f.state().projected, null);
  f.feed(95, { spo2: 99 });
  assert.equal(f.state().actual?.spo2, 99);
  assert.deepEqual(f.state().projected, { value: reference.spo2Warn - 2, offset: 101 - reference.spo2Warn });
});

test('manual oxygen offsets stay in range and changing offsets discards earlier confirmation slots', async () => {
  const f = fixture();
  f.demo.enable();
  f.demo.configureSimulation({ enabled: true, scenario: 'low_spo2', mode: 'manual', spo2Reduction: 1 });
  for (let i = 0; i < 10; i++) f.feed(95);
  assert.deepEqual(f.state().projected, { value: 97, offset: 1 });
  assert.equal(f.state().phase, 'idle');
  f.demo.configureSimulation({ spo2Reduction: 30 });
  for (let i = 0; i < 7; i++) f.feed(95);
  assert.deepEqual(f.state().projected, { value: 70, offset: 28 });
  f.demo.configureSimulation({ spo2Reduction: 8 });
  for (let i = 0; i < 7; i++) f.feed(95);
  assert.equal(f.state().phase, 'idle');
  f.feed(95);
  await flush();
  assert.equal(f.state().safety?.check?.episode.kind, 'spo2_low');
  assert.equal(f.state().safety?.check?.episode.value, 90);
  f.demo.stop();
});

test('invalid vitals cannot be projected or replaced with another estimator or older reading', () => {
  const f = fixture();
  f.demo.enable();
  f.demo.configureSimulation({ enabled: true });
  f.feed(95);
  assert.ok(f.state().projected);
  f.feed(NaN, { phoneHr: 95 });
  assert.equal(f.state().actual?.hr, null);
  assert.equal(f.state().actual?.spo2, 98);
  assert.equal(f.state().projected, null);
  f.feed(95, { phoneHr: 80 });
  assert.equal(f.state().projected, null);
  f.demo.configureSimulation({ scenario: 'low_spo2' });
  f.feed(95, { spo2: 101 });
  assert.equal(f.state().actual?.hr, 95);
  assert.equal(f.state().actual?.spo2, null);
  assert.equal(f.state().projected, null);
  f.feed(95);
  assert.ok(f.state().projected);
  f.advance(3000);
  f.demo.tick();
  assert.equal(f.state().projected, null);
  assert.equal(f.state().actual, null);
});

test('five slots with four accepted projections confirm and continuous contact loss preserves the consent workflow', async () => {
  const f = fixture();
  f.demo.enable();
  f.demo.configureSimulation({ enabled: true });
  for (let i = 0; i < 6; i++) f.feed(95);
  f.feed(95, { finger: false });
  assert.equal(f.state().projected, null);
  assert.equal(f.state().phase, 'idle');
  f.feed(95);
  await flush();
  const wellness = f.scope();
  f.feed(95, { finger: false });
  assert.equal(f.state().projected, null);
  assert.deepEqual(f.scope(), wellness);
  assert.equal(f.demo.answer('not_ok', wellness), true);
  await flush();
  f.feed(95, { finger: false });
  assert.deepEqual(f.urls, []);
  assert.equal(f.demo.answer('call_yes', f.scope()), true);
  await flush();
  assert.deepEqual(f.urls, ['tel:+12025550124']);
});

test('manual HR accepts exactly 80% abnormal slots even when the final reading is in range', async () => {
  const f = fixture();
  f.demo.enable();
  f.demo.configureSimulation({ enabled: true, mode: 'manual', hrIncrease: 10 });
  for (let i = 0; i < 7; i++) f.feed(reference.highWarn - 8);
  assert.equal(f.state().phase, 'idle');
  f.feed(reference.highWarn - 11);
  await flush();
  assert.equal(f.state().projected?.value, reference.highWarn - 1);
  assert.equal(f.state().safety?.check?.episode.kind, 'bpm_high');
  f.demo.stop();
});

test('Drive dashboard mode changes leave recording, genuine tiles, and demo ownership untouched', () => {
  const source = readFileSync(new NodeURL('../components/DriveView.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const require = createRequire(import.meta.url);
  const exports: any = {};
  let mode = false;
  let dimensions = { width: 390, fontScale: 1 };
  let effectDep: unknown;
  let cleanup: (() => void) | undefined;
  const mocks: Record<string, any> = {
    react: { useRef: (current: unknown) => ({ current }),
      useEffect: (fn: () => () => void, [dep]: unknown[]) => {
        if (dep !== effectDep) { cleanup?.(); effectDep = dep; cleanup = fn(); }
      } },
    'react/jsx-runtime': require('react/jsx-runtime'),
    'react-native': { ScrollView: 'ScrollView', View: 'View', StyleSheet: { create: (styles: unknown) => styles },
      useWindowDimensions: () => dimensions },
    '../lib/i18n/native': { LocalizedText: 'Text', LocalizedPressable: 'Pressable' },
    '../lib/theme/ThemeProvider': { useTheme: () => ({ tokens: {}, colors: {} }) },
    '../lib/theme/tokens': { presentationColors: () => ({}) },
    './HomeHardwareDemo': { HomeHardwareDemo: 'DemoPanel', HardwareDemoDiagnostics: 'DemoDiagnostics', demoVitalPresentation: () => ({ projected: { value: 114, offset: 29 }, sourceValue: 85 }) },
    './CompactVitalCard': { CompactVitalCard: 'Vital' },
    './PersonalizedBaseline': { PersonalizedBaseline: 'Baseline' },
    './Information': { InformationButton: 'InformationButton' },
    '../lib/analysis/sensorContinuity': { monitoringMessage: () => 'monitoring' },
    '../lib/ui/dashboard': { liveBaselineHeartRate: () => null },
    './ui': { Btn: 'Button', Card: 'Card', Pill: 'Pill', fmtDuration: () => 'timer' },
  };
  new Function('require', 'exports', '__DEV__', compiled)((id: string) => mocks[id] ?? {}, exports, true);
  const sideEffects: string[] = [];
  const drive = {
    lastRx: new Date(), isConnected: true, link: { source: 'relay' }, relay: { esp: true },
    safety: {}, fold: {}, bpm: 85, spo2: 98, hasActiveSession: true,
    session: { id: 'live-drive', started_at: new Date().toISOString() },
    startSession: () => sideEffects.push('start'), endSession: () => sideEffects.push('end'),
    homeHardwareDemo: { simulation: { enabled: true, scenario: 'high_hr' } },
    homeHardwareDemoControls: { stop: () => sideEffects.push('stop'), configureSimulation: () => sideEffects.push('configure') },
  };
  const nodes = (node: any): any[] => Array.isArray(node) ? node.flatMap(nodes)
    : node?.props ? [node, ...nodes(node.props.children)] : [];
  let scrollStarts = 0;
  const view = () => nodes(exports.DriveView({ drive, demoView: mode, onDashboardScrollStart: () => { scrollStarts++; } }));
  const node = (type: string) => view().find(item => item.type === type);
  const assertDrive = () => {
    assert.deepEqual(view().filter(item => item.type === 'Vital' && item.props.demoLayout !== 'history').map(item => item.props.value), [85, 98]);
    assert.ok(view().some(item => item.props.title === 'End drive'));
    assert.ok(view().some(item => Array.isArray(item.props.children) && item.props.children.includes('timer')));
  };
  assertDrive();
  assert.equal(node('DemoPanel'), undefined);
  node('ScrollView').props.onScroll({ nativeEvent: { contentOffset: { y: 50 } } });
  assert.equal(scrollStarts, 0);
  node('ScrollView').props.onScrollBeginDrag();
  assert.equal(scrollStarts, 1);
  mode = true;
  node('ScrollView').props.onScrollBeginDrag();
  assert.equal(scrollStarts, 2);
  assert.equal(node('ScrollView').props.onScrollEndDrag, undefined);
  assert.ok(node('DemoPanel'));
  const tiles = () => view().filter(item => item.type === 'Vital').map(item => item.props);
  assert.deepEqual(tiles()[0].simulation, { value: 114, actual: 85, offset: 29 });
  assert.equal(tiles()[1].simulation, undefined);
  assert.deepEqual(tiles().map(tile => tile.demoLayout), ['summary', 'summary', 'history', 'history']);
  const demoNodes = view();
  const order = [
    demoNodes.findIndex(item => item.type?.name === 'Chain'),
    demoNodes.findIndex(item => item.props.title === 'End drive'),
    demoNodes.findIndex(item => item.props.children === 'Live Vitals'),
    demoNodes.findIndex(item => item.props.demoLayout === 'summary'),
    demoNodes.findIndex(item => item.props.title === 'View Detailed Vitals'),
    demoNodes.findIndex(item => item.type === 'Baseline'),
    demoNodes.findIndex(item => item.type === 'DemoPanel'),
    demoNodes.findIndex(item => item.type === 'DemoDiagnostics'),
    demoNodes.findIndex(item => item.props.demoLayout === 'history'),
  ];
  assert.ok(order.every(i => i >= 0));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.equal(demoNodes.filter(item => item.type === 'DemoPanel').length, 1);
  const chain = demoNodes[order[0]];
  const chainNodes = nodes(chain.type(chain.props));
  for (const label of ['Wheel', 'Raspberry Pi', 'Phone', 'streaming', 'connected', 'BLE connected']) {
    assert.ok(chainNodes.some(item => item.props.children === label), label);
  }
  assert.equal(chainNodes.find(item => item.type === 'InformationButton').props.title, 'Connectivity');
  drive.homeHardwareDemo.simulation.scenario = 'low_spo2';
  assert.ok(tiles()[1].simulation);
  assert.equal(tiles()[0].simulation, undefined);
  drive.homeHardwareDemo.simulation.enabled = false;
  assert.ok(tiles().every(tile => tile.simulation === undefined));
  assert.ok(view().some(item => item.props.children === 'Showing actual sensor readings only'));
  drive.homeHardwareDemo.simulation.enabled = true;
  assertDrive();
  mode = false;
  assert.equal(node('DemoPanel'), undefined);
  assert.ok(tiles().every(tile => !tile.demoLayout && !tile.simulation));
  assert.ok(view().some(item => item.props.children === 'Hardware Demo simulation enabled'));
  assertDrive();
  for (const demoView of [false, true]) {
    mode = demoView;
    for (const width of [375, 430]) {
      for (const fontScale of [1, 1.6]) {
        dimensions = { width, fontScale };
        const tileRow = view().find(item => Array.isArray(item.props.children)
          && item.props.children.length === 2 && item.props.children.every((child: any) => child?.type === 'Vital'));
        assert.ok(tileRow);
        assert.equal(tileRow.props.style[1]?.flexDirection, fontScale > 1.4 ? 'column' : undefined);
      }
    }
  }
  assert.deepEqual(sideEffects, []);
  cleanup?.();
  assert.deepEqual(sideEffects, ['stop']);
});

test('simulation tile renders the selected projection and leaves genuine chart and average inputs intact', () => {
  const source = readFileSync(new NodeURL('../components/CompactVitalCard.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const require = createRequire(import.meta.url);
  const exports: any = {};
  const mocks: Record<string, unknown> = {
    'react/jsx-runtime': require('react/jsx-runtime'),
    'react-native': { View: 'View', StyleSheet: { hairlineWidth: 1 } },
    '../lib/i18n/native': { LocalizedText: 'Text' },
    '../lib/theme/ThemeProvider': { useTheme: () => ({ tokens: {} }) },
    '../lib/ui/dashboard': { vitalRangePresentation: (value: number) => ({ value, state: 'live', label: 'Live' }) },
    './ui': { Card: 'Card', fmtNum: String }, './charts': { VitalChart: 'Chart' },
  };
  new Function('require', 'exports', '__DEV__', compiled)((id: string) => mocks[id], exports, true);
  const nodes = (node: any): any[] => Array.isArray(node) ? node.flatMap(nodes)
    : node?.props ? [node, ...nodes(node.props.children)] : [];
  const words = (items: any[]) => items.filter(item => item.type === 'Text')
    .map(item => Array.isArray(item.props.children) ? item.props.children.join('') : String(item.props.children));
  for (const metric of ['heart', 'oxygen']) {
    const hr = metric === 'heart';
    const actual = hr ? 86 : 98;
    const projected = hr ? 114 : 91;
    const unit = hr ? 'BPM' : '%';
    const points = [{ v: actual }, { v: null }];
    const props = { metric, value: actual, unit, points, average: actual - 1 };
    const render = (extra: object) => nodes(exports.CompactVitalCard({ ...props, ...extra }));
    const showing = render({ demoLayout: 'summary', simulation: { value: projected, actual, offset: Math.abs(projected - actual) } });
    assert.ok(words(showing).includes(hr ? 'Simulated HR' : 'Simulated SpO₂'));
    assert.ok(words(showing).includes(String(projected)));
    assert.ok(words(showing).includes(`${hr ? 'Actual HR' : 'Actual SpO₂ (estimate)'} · ${actual} ${unit}`));
    assert.ok(words(showing).includes(hr ? 'Applied offset · +28 BPM' : 'Applied offset · −7 percentage points'));
    assert.ok(!showing.some(item => item.type === 'Chart'));
    assert.equal(showing[0].props.style.padding, 9);
    assert.equal(showing[0].props.style.height, undefined);
    assert.ok(showing.some(item => item.props.style?.flexWrap === 'wrap'));
    assert.ok(showing.filter(item => item.type === 'Text')
      .every(item => item.props.allowFontScaling !== false && item.props.numberOfLines === undefined));
    assert.ok(words(render({ demoLayout: 'summary' })).includes(hr ? 'Actual HR' : 'Actual SpO₂ (estimate)'));
    const history = render({ demoLayout: 'history' });
    assert.ok(words(history).includes('Actual sensor history'));
    assert.ok(words(history).includes(`Average ${actual - 1} ${unit}`));
    assert.equal(history.find(item => item.type === 'Chart').props.points, points);
    assert.ok(!words(history).includes(String(projected)));
    const invalid = words(render({ demoLayout: 'summary', simulation: { value: null, actual: null, offset: null } }));
    assert.ok(invalid.includes('Simulation unavailable'));
    assert.ok(!invalid.includes(String(projected)));
    const normalCard = render({});
    assert.equal(normalCard[0].props.style.padding, showing[0].props.style.padding);
    assert.equal(normalCard.find(item => item.type === 'Chart').props.height, 52);
    const normal = words(normalCard);
    assert.ok(normal.includes(String(actual)));
    assert.ok(!normal.some(text => text.includes('Simulated') || text.includes('Actual sensor history')));
  }
});

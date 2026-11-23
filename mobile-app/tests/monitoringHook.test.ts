import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { URL as NodeURL } from 'node:url';
import ts from 'typescript';
import { saveSelectedProfile } from '../lib/db/profileEditing.ts';
import { SafetyController, initialSafety } from '../lib/analysis/safetyController.ts';
import { SeqTracker } from '../lib/ble/protocol.ts';
import { openAuthorizedPhoneInterface, openConfirmedDemoPhoneInterface, hasSystemPhoneConfirmation } from '../lib/voice/phoneHandoff.ts';
import { recognitionEvidence } from '../lib/voice/coreRecognition.ts';
import { HomeHardwareDemo, demoThresholdProvenance } from '../lib/diagnostics/homeHardwareDemo.ts';
import { HardwareSafetyTest } from '../lib/diagnostics/hardwareSafetyTest.ts';
const require = createRequire(import.meta.url);
const tick = async () => { for (let n = 0; n < 20; n++) await new Promise<void>(r => setImmediate(r)); };

// Executes the real hook/reducer/controller, with only native transport, storage,
// React scheduling and cloud side effects replaced. No fabricated trip for safety.
function harness(development = false) {
  let index = 0, callbacks: any, appListener: any, input: any;
  let now = 100000;
  let lastSeq = -1;
  let connectionStarts = 0;
  let spoken: string[] | null = null;
  let accountId: string | null = null;
  const accountListeners = new Set<() => void>();
  let waveform: 'warming' | 'rejected' | 'passed' = 'passed';
  const cells: any[] = [], effects: (() => void)[] = [], timers: (() => void)[] = [];
  const demoEvents: any[] = [], demoOutcomes: any[] = [];
  const saved: any[] = [], stored: any[] = [], followed: string[] = [], finished: string[] = [], calls: string[] = [];
  const app = { currentState: 'active', addEventListener: (_: string, fn: any) => { appListener = fn; return { remove() {} }; } };
  const memo = (fn: () => any, deps: any[]) => {
    const id = index++, previous = cells[id];
    if (!previous || deps.some((v, i) => v !== previous.deps[i])) cells[id] = { deps, value: fn() };
    return cells[id].value;
  };
  const react = {
    useRef: (initial: any) => { const id = index++; return cells[id] ??= { current: initial }; },
    useMemo: memo, useCallback: (fn: any, deps: any[]) => memo(() => fn, deps),
    useReducer: (reducer: any, initial: any) => {
      const id = index++;
      cells[id] ??= { value: initial, dispatch: (action: any) => { cells[id].value = reducer(cells[id].value, action); } };
      return [cells[id].value, cells[id].dispatch];
    },
    useEffect: (fn: any, deps: any[]) => memo(() => { effects.push(fn); }, deps),
  };
  let trip = 0, id = 0;
  const profileSaves: any[] = [];
  const repo = {
    getProfile: async () => driver,
    updateProfile: async (id: string, input: any, revision: string, languageOnly: boolean) => {
      profileSaves.push({ id, input, revision, languageOnly });
      return { ...driver, language: input.language };
    },
    saveDriveDemoEvent: async (row: any) => { demoEvents.push(row); },
    saveDriveDemoOutcome: async (row: any, outcome: string) => { demoOutcomes.push([row.id, outcome]); },
    saveAlert: async (row: any) => { saved.push(row); }, setAck: async () => {}, saveSnapshot: async () => {},
    recoverInterruptedSessions: async () => 0, getStorageMode: async () => 'vitals', getSetting: async () => null,
    driverBaseline: async () => development ? { established: true, readings: 80, sessions: 2,
      bpmP10: 70, bpmMedian: 74, bpmP90: 78, spo2P10: 94, spo2Median: 98 } : null, getAck: async () => ({ high: null, low: null }), driveMedians: async () => [],
    startSession: async (profile_id: string, storage_mode: string) => ({ id: `trip-${++trip}`, profile_id, storage_mode, status: 'active', started_at: new Date(now).toISOString() }),
    endSession: async (session: any) => ({ ...session, status: 'ended' }),
    storeFrame: async (...args: any[]) => { stored.push(args); return 'stored'; },
    setSessionSampleRate: async () => {}, setSetting: async () => {},
  };
  const deps: Record<string, any> = {
    '../diagnostics/hardwareSafetyTest': { HardwareSafetyTest },
    '../diagnostics/homeHardwareDemo': { HomeHardwareDemo, demoThresholdProvenance },
    '../assistant/phoneCloudAuth': { sensiCloudAuth: { subscribe: (listener: () => void) => { accountListeners.add(listener); return () => accountListeners.delete(listener); },
      cachedCredential: () => accountId ? { userId: accountId } : null } },
    '../voice/phoneHandoff': { openAuthorizedPhoneInterface, openConfirmedDemoPhoneInterface, hasSystemPhoneConfirmation },
    '../assistant/mode': { SENSI_MODE: 'gemma' },
    '../voice/basicOfflineAcknowledgment': { VOICECHECK_BASIC_OFFLINE: true },
    '../assistant/phoneSensiRouting': { phoneSensiAcknowledgment: () => ({ get: () => 'Thank you for telling me.', cancel() {}, source: 'fallback' }),
      sensiPreferences: { boot: async () => {}, selectDriver: async () => {} } },
    react, 'react-native': { Platform: { OS: 'ios', Version: 26 }, AppState: app, Linking: { openURL: async (url: string) => { calls.push(url); } } },
    'expo-haptics': { notificationAsync: async () => {}, NotificationFeedbackType: {} },
    '../../modules/gemma-poc/phone': { phoneSafetySemantic: () => ({ get: () => null, cancel() {} }), phoneSafetyAcknowledgment: () => ({ get: () => 'I hear you.', source: 'fallback', cancel() {} }) },
    '../ble/bleService': { WheelConnection: class { constructor(cb: any) { callbacks = cb; } start() { connectionStarts++; } stop() {} setAllowDirect() {} } },
    '../ble/protocol': { SeqTracker, uuidv4: () => `id-${++id}`, Deframer: class { crcErrors = 0; feed() { return [input]; } } },
    '../db/liveSync': { LiveUploader: class { status = { bytesSent: 0 }; nudge() {} stop() {} follow(id: string) { followed.push(id); } async finish(id: string) { finished.push(id); } } },
    '../db/repositories': repo, '../db/sync': { syncToSupabase: async () => {} }, '../db/profileEditing': { saveSelectedProfile },
    '../db/profileSync': { syncProfiles: async () => {} }, '../db/deletion': { processPendingDeletes: async () => {} },
    '../voice/audioOwnership': { appAudio: { stopActive: async () => {} } }, '../archive/archiveStore': { foldSession: async () => null },
    '../analysis/signal': { SignalAnalyzer: class {
      get hasWindow() { return waveform !== 'warming'; }
      feed() { return development ? { good: waveform === 'passed', hrBeats: waveform === 'warming' ? null : input.heartRate,
        feasible: waveform !== 'warming', agree: waveform !== 'warming', templateR: waveform === 'rejected' ? 0.7 : 0.95,
        skewness: 0.1 } : null; }
    } },
    '../analysis/calibration': { CAL_SECONDS: 20, applyCalibration: (bpm: number, spo2: number) => ({ bpm, spo2 }) },
    '../analysis/trend': { computeTrend: () => null }, '../analysis/safetyController': { SafetyController, initialSafety },
    '../voice/speechIO': { phoneVoiceIO: voice, phoneSensiVoiceIO: voice, prepareVoice: async () => ({ granted: true, onDevice: true }),
      releaseAudio() {}, resetVoiceCache() {}, setPreferredVoice() {} },
  };
  function voice() { return { speak: async () => {}, listen: (_l: string, _m: number, _h: string[], id: string) => {
    if (!spoken) return new Promise(() => {});
    const text = spoken.shift();
    return Promise.resolve(text ? recognitionEvidence(id, { status: 'success', transcript: text,
      finalTranscript: text, isFinal: true, finalResultReceived: true }) : null);
  }, cancel() {} }; }
  const compiled = ts.transpileModule(readFileSync(new NodeURL('../lib/hooks/useDriveSession.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: any = {};
  class ClockDate extends Date { constructor() { super(now); } static now() { return now; } }
  new Function('require', 'exports', 'setInterval', 'clearInterval', 'Date', '__DEV__', compiled)(
    (name: string) => { assert.ok(name in deps, name); return deps[name]; }, exports,
    (fn: () => void) => { timers.push(fn); return timers.length; }, () => {}, ClockDate, development);
  function render() { index = 0; const value = exports.useDriveSession(); effects.splice(0).forEach(fn => fn()); return value; }
  const driver = { id: 'driver', display_name: 'Driver', age: 30, gender: 'male', height_cm: 180, weight_kg: 80,
    emergency_name: 'Test Contact', emergency_phone: '+13055550123', created_at: '', updated_at: '' };
  return { profileSaves, render, demoEvents, demoOutcomes, saved, stored, followed, finished, calls, connectionStarts: () => connectionStarts,
    waveform: (status: typeof waveform) => { waveform = status; },
    spoken: (answers: string[]) => { spoken = answers; },
    get nextSequence() { return lastSeq + 1; },
    async select() { render().selectDriver(driver); await tick(); render().setSafetyPresentationEnabled(true); callbacks.onStateChange('connected'); },
    feed(seq: number, bpm = 155, finger = true) {
      lastSeq = seq;
      now = 100000 + seq * 1000;
      input = { version: 3, seq, rateHz: development ? 100 : 0, quality: 90, startMs: seq * 1000, endMs: (seq + 1) * 1000,
        heartRate: bpm, spo2: 98, flags: 15, samples: [], finger, usable: finger, raw: new Uint8Array() };
      callbacks.onBytes(new Uint8Array());
    },
    account(id: string | null) { accountId = id; for (const listener of accountListeners) listener(); },
    app(state: string) { app.currentState = state; appListener(state); },
    link(state: string) { callbacks.onStateChange(state); },
  };
}

test('actual hook automatically monitors without recording; recording/upload start and stop independently', async () => {
  const f = harness(); await f.select();
  for (let i = 0; i < 14 && !f.render().safety.check; i++) f.feed(i);
  await tick(); const before = f.render(); assert.ok(before.safety.check); assert.equal(before.hasActiveSession, false);
  assert.deepEqual(f.saved, []); assert.deepEqual(f.stored, []); assert.deepEqual(f.followed, []);
  assert.equal(before.savedDriveRevision, 0);
  const scope = { episodeId: before.safety.check.episode.id, question: before.safety.check.question, captureId: before.safety.check.captureId };
  await before.startSession(); await tick();
  assert.equal(f.render().safety.check.captureId, scope.captureId);
  assert.deepEqual(f.followed, ['trip-1']);
  f.feed(f.nextSequence); await tick(); assert.equal(f.stored.at(-1)?.[0], 'trip-1');
  assert.equal(f.render().savedDriveRevision, 0);
  await f.render().endSession(); await tick();
  assert.equal(f.render().savedDriveRevision, 1);
  assert.deepEqual(f.finished, ['trip-1', 'trip-1']); // existing finish plus post-baseline republish
  assert.equal(f.render().hasActiveSession, false);
  assert.equal(f.render().safety.check.captureId, scope.captureId);
  assert.equal(f.render().respondAlert('not_ok', scope), true); await tick();
  const check = f.render().safety.check;
  assert.equal(check.question, 'contact_offer');
  f.render().respondAlert('call_yes', { episodeId: check.episode.id, question: check.question, captureId: check.captureId }); await tick();
  assert.deepEqual(f.calls, ['tel:+13055550123']);
  assert.deepEqual(f.saved, [], 'event activated without a recording is never fabricated into a trip');
});

test('actual hook revokes background/disconnected questions and only restores from new readings', async () => {
  const f = harness(); await f.select();
  for (let i = 0; i < 14 && !f.render().safety.check; i++) f.feed(i);
  await tick(); const check = f.render().safety.check; assert.ok(check);
  f.app('background'); await tick();
  assert.equal(f.render().safety.check, null); assert.equal(f.render().safety.monitoring, 'unavailable');
  assert.equal(f.render().respondAlertText('call my mom', { episodeId: check.episode.id, question: check.question, captureId: check.captureId }), false);
  f.app('active'); assert.equal(f.render().safety.check, null);
  f.feed(20, 74); assert.equal(f.render().safety.monitoring, 'active');
  f.link('disconnected'); assert.equal(f.render().safety.monitoring, 'disconnected');
  f.link('connected'); assert.equal(f.render().safety.monitoring, 'waiting');
  assert.deepEqual(f.calls, []);
});

test('a recorded check finishing after End Drive saves and republishes its original recording', async () => {
  const f = harness(); await f.select(); await f.render().startSession();
  for (let i = 0; i < 14 && !f.render().safety.check; i++) f.feed(i);
  await tick(); const check = f.render().safety.check; assert.ok(check);
  await f.render().endSession(); const uploads = f.finished.length;
  f.render().respondAlert('not_ok', { episodeId: check.episode.id, question: check.question, captureId: check.captureId }); await tick();
  const offer = f.render().safety.check;
  f.render().respondAlert('call_no', { episodeId: offer.episode.id, question: offer.question, captureId: offer.captureId }); await tick();
  assert.equal(f.saved.at(-1)?.session_id, 'trip-1'); assert.equal(f.saved.at(-1)?.response, 'not_ok');
  assert.equal(f.render().savedDriveRevision, 2);
  assert.equal(f.finished.length, uploads + 1); assert.equal(f.finished.at(-1), 'trip-1');
  assert.equal(f.render().safety.monitoring, 'active'); assert.deepEqual(f.calls, []);
});

for (const entry of ['rehearsal', 'simulator'] as const) for (const channel of ['voice', 'typed', 'button'] as const) {
  test(`Settings ${entry}: ${channel} consent/refusal reaches simulation completion, never Linking`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    for (const accepted of [true, false]) {
      const f = harness(); await f.select(); f.feed(0, 74);
      if (channel === 'voice') f.spoken(["I'm dizzy", accepted ? 'yes' : 'no thanks']);
      let done = false;
      const pending = (entry === 'rehearsal' ? f.render().rehearseVoice() : f.render().simulate('high_critical'))
        .then((result: any) => { done = true; return result; });
      const seen = new Set<string>();
      for (let n = 0; n < 100 && !done; n++) {
        await tick();
        const drive = f.render(), check = drive.safety.check;
        if (channel !== 'voice' && check && !seen.has(check.captureId)) {
          seen.add(check.captureId);
          const scope = { episodeId: check.episode.id, question: check.question, captureId: check.captureId };
          const wellness = check.question === 'wellness';
          if (channel === 'typed') drive.respondAlertText(wellness ? "I'm dizzy" : accepted ? 'yes' : 'no thanks', scope);
          else drive.respondAlert(wellness ? 'not_ok' : accepted ? 'call_yes' : 'call_no', scope);
        }
        t.mock.timers.tick(250);
      }
      assert.equal(done, true); const result = await pending;
      assert.equal(result.contactCall, accepted ? 'accepted_offer' : 'declined_offer');
      assert.equal(f.render().safety.last.simulation, true);
      assert.equal(f.render().safety.last.handoff, accepted ? 'simulated' : undefined);
      assert.deepEqual(f.calls, [], 'actual hook Linking.openURL must never run');
      assert.ok(f.render().safety.conversation.messages.some((m: any) => /[Ss]imulation complete/.test(m.text)));
      assert.deepEqual(f.saved, []);
    }
  });
}

test('actual hook real-event final spoken yes retains explicit phone handoff', async () => {
  const f = harness(); await f.select(); f.spoken(["I'm dizzy", 'yes']);
  for (let i = 0; i < 14 && !f.render().safety.check; i++) f.feed(i);
  await tick();
  assert.deepEqual(f.calls, ['tel:+13055550123']);
  assert.equal(f.render().safety.last.simulation, false);
  assert.equal(f.render().safety.last.handoff, 'opened');
});

test('a genuine live incident preempts simulator warm-up without inheriting simulation identity or UI', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = harness(); await f.select(); f.feed(0, 74);
  const pending = f.render().simulate('high_critical'); await tick();
  assert.ok(f.render().safety.demo);
  f.spoken(["I'm dizzy", 'yes']);
  for (let i = 1; i < 20 && !f.render().safety.check; i++) f.feed(i);
  await tick();
  assert.equal(f.render().safety.demo, null);
  const episode = f.render().safety.last.episode.id;
  assert.equal(f.render().safety.last.simulation, false);
  assert.deepEqual(f.calls, ['tel:+13055550123'], 'only the explicitly authorized genuine live event may hand off');
  t.mock.timers.tick(250); await tick();
  assert.equal(await pending, null);
  assert.equal(f.render().safety.last.episode.id, episode);
  assert.equal(f.render().safety.conversation.simulation, false);
  assert.equal(f.render().safety.conversation.messages.some((m: any) => /[Ss]imulation complete/.test(m.text)), false);
});


test('compact VoiceCheck language uses guarded profile lifecycle and publishes Spanish without a drive', async () => {
  const f = harness(); await f.select();
  const before = f.render().driver;
  await f.render().updateVoiceCheckLanguage('es'); await tick();
  assert.equal(f.profileSaves.length, 1);
  assert.equal(f.profileSaves[0].languageOnly, true);
  assert.equal(f.profileSaves[0].id, before.id);
  assert.equal(f.profileSaves[0].input.language, 'es');
  assert.equal(f.render().driver.language, 'es');
  assert.equal(f.render().driver.display_name, before.display_name);
  assert.equal(f.render().hasActiveSession, false);
  await f.render().startSession(); await tick();
  await assert.rejects(f.render().updateVoiceCheckLanguage('en'), /drive/);
  assert.equal(f.profileSaves.length, 1);
});

test('real hardware test leaves production evaluation running and yields to a production warning', async t => {
  const globals = globalThis as typeof globalThis & { __DEV__?: boolean };
  const original = globals.__DEV__;
  globals.__DEV__ = true;
  t.after(() => { if (original === undefined) delete globals.__DEV__; else globals.__DEV__ = original; });
  const f = harness(true); await f.select();
  f.feed(0, 74);
  const productionThresholds = f.render().safety.th;
  const productionBaseline = f.render().baseline;
  assert.equal(f.render().hardwareTestControls.start(false), true);
  for (let seq = 1; seq <= 18; seq++) f.feed(seq, 77);
  assert.ok(f.render().safety.check?.episode.id.startsWith('hardware-'));
  assert.deepEqual(f.render().safety.th, productionThresholds);
  assert.equal(f.render().baseline, productionBaseline);
  assert.deepEqual(f.saved, []);
  assert.deepEqual(f.stored, []);
  assert.deepEqual(f.followed, []);
  for (let seq = 19; seq <= 35 && f.render().hardwareTest.phase !== 'cancelled'; seq++) f.feed(seq, 180);
  assert.equal(f.render().hardwareTest.phase, 'cancelled');
  assert.ok(f.render().safety.tracking);
  assert.equal(f.render().safety.check, null);
  assert.deepEqual(f.calls, []);
});

test('decoded frames reach the diagnostic while production monitoring waits for waveform warm-up', async () => {
  const f = harness(true); await f.select();
  f.waveform('warming');
  f.feed(0, 79);
  const ready = f.render();
  assert.equal(ready.safety.monitoring, 'waiting');
  assert.equal(ready.bpm, 79);
  assert.equal(ready.hardwareTest.startBlock, null);
  assert.equal(ready.hardwareTest.lastFrame.waveform, 'warming');
  assert.equal(ready.hardwareTestControls.start(false), true);
  f.feed(1, 74);
  f.feed(2, 76);
  assert.equal(f.render().hardwareTest.confirmed, null);
  f.waveform('rejected');
  f.feed(3, 80);
  assert.equal(f.render().hardwareTest.phase, 'recovering');
  assert.equal(f.render().hardwareTest.confirmed, null);
  assert.equal(f.render().hardwareTest.lastFrame.rejection, 'waveform');
  assert.equal(f.render().hardwareTest.lastFrame.bpm, 80);
  assert.deepEqual(f.calls, []);
});

test('Home hardware demo reuses BLE, keeps live vitals genuine, and opens only the explicitly reviewed test contact', async t => {
  const globals = globalThis as typeof globalThis & { __DEV__?: boolean };
  const original = globals.__DEV__;
  globals.__DEV__ = true;
  t.after(() => { if (original === undefined) delete globals.__DEV__; else globals.__DEV__ = original; });
  const f = harness(true);
  await f.select();
  const starts = f.connectionStarts();
  assert.equal(f.render().homeHardwareDemoControls.enable(), true);
  assert.equal(f.connectionStarts(), starts + 1);
  f.waveform('rejected');
  f.feed(0, 79);
  const running = f.render().homeHardwareDemoControls.trigger();
  await tick();
  const respond = (answer: string) => {
    const drive = f.render();
    const check = drive.safety.check;
    assert.ok(check);
    return drive.respondAlert(answer, { episodeId: check.episode.id, captureId: check.captureId, question: check.question });
  };
  assert.equal(f.render().safety.monitoring, 'waiting');
  assert.equal(f.render().bpm, 79);
  assert.equal(f.render().spo2, 98);
  assert.equal(respond('not_ok'), true);
  await tick();
  assert.equal(respond('call_yes'), true);
  await running;
  const drive = f.render();
  assert.equal(drive.safety.conversation.simulation, true);
  assert.equal(drive.safety.conversation.cloudSimulation, false);
  assert.equal(drive.homeHardwareDemo.confirmation.name, 'Test Contact');
  assert.equal(drive.hasActiveSession, false);
  assert.deepEqual(f.saved, []);
  assert.deepEqual(f.stored, []);
  assert.deepEqual(f.followed, []);
  assert.deepEqual(f.calls, []);
  await drive.homeHardwareDemoControls.confirm(drive.homeHardwareDemo.confirmation.id);
  assert.deepEqual(f.calls, ['tel:+13055550123']);
});

test('an actual production warning ends Home Demo ownership before any test-contact handoff', async t => {
  const globals = globalThis as typeof globalThis & { __DEV__?: boolean };
  const original = globals.__DEV__;
  globals.__DEV__ = true;
  t.after(() => { if (original === undefined) delete globals.__DEV__; else globals.__DEV__ = original; });
  const f = harness(true);
  await f.select();
  f.feed(0, 79);
  assert.equal(f.render().homeHardwareDemoControls.enable(), true);
  const running = f.render().homeHardwareDemoControls.trigger();
  await tick();
  const demoId = f.render().safety.check.episode.id;
  for (let seq = 1; seq <= 17 && f.render().homeHardwareDemo.enabled; seq++) f.feed(seq, 180);
  await running;
  assert.equal(f.render().homeHardwareDemo.enabled, false);
  assert.ok(f.render().safety.tracking || f.render().safety.check);
  await f.render().homeHardwareDemoControls.confirm(demoId);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.stored, []);
  assert.deepEqual(f.followed, []);
});

test('biometric simulation uses decoded firmware frames after production and never creates a recorded session', async t => {
  const globals = globalThis as typeof globalThis & { __DEV__?: boolean };
  const original = globals.__DEV__;
  globals.__DEV__ = true;
  t.after(() => { if (original === undefined) delete globals.__DEV__; else globals.__DEV__ = original; });
  const f = harness(true);
  await f.select();
  const before = f.render().safety.th;
  assert.equal(f.render().homeHardwareDemoControls.enable(), true);
  f.render().homeHardwareDemoControls.configureSimulation({ enabled: true });
  f.waveform('rejected');
  for (let seq = 0; seq < 7; seq++) f.feed(seq, 85);
  assert.equal(f.render().safety.check, null);
  f.feed(7, 85);
  await tick();
  const respond = (answer: string) => {
    const d = f.render();
    const check = d.safety.check;
    assert.ok(check);
    return d.respondAlert(answer, { episodeId: check.episode.id, captureId: check.captureId, question: check.question });
  };
  const d = f.render();
  assert.equal(d.bpm, 85);
  assert.equal(d.spo2, 98);
  assert.equal(d.safety.monitoring, 'waiting');
  assert.deepEqual(d.safety.th, before);
  assert.equal(d.homeHardwareDemo.liveEpisode, true);
  assert.equal(respond('not_ok'), true);
  await tick();
  assert.deepEqual(f.calls, []);
  assert.equal(respond('call_yes'), true);
  await tick();
  assert.deepEqual(f.calls, ['tel:+13055550123']);
  assert.equal(f.render().homeHardwareDemo.confirmation, null);
  assert.deepEqual(f.saved, []);
  assert.deepEqual(f.stored, []);
  assert.deepEqual(f.followed, []);
});

test('active drive saves a separate simulated episode and End Drive invalidates its offered contact', async t => {
  const globals = globalThis as typeof globalThis & { __DEV__?: boolean };
  const original = globals.__DEV__;
  globals.__DEV__ = true;
  t.after(() => { if (original === undefined) delete globals.__DEV__; else globals.__DEV__ = original; });
  const f = harness(true);
  await f.select();
  await f.render().startSession();
  assert.equal(f.render().hasActiveSession, true);
  assert.equal(f.render().homeHardwareDemoControls.enable(), true);
  assert.equal(await f.render().homeHardwareDemoControls.trigger(), false);
  f.render().homeHardwareDemoControls.configureSimulation({ enabled: true });
  f.waveform('rejected');
  for (let seq = 0; seq < 8; seq++) f.feed(seq, 85);
  await tick();
  const d = f.render();
  assert.equal(d.hasActiveSession, true);
  assert.deepEqual(f.followed, ['trip-1']);
  assert.equal(d.bpm, 85);
  assert.equal(d.homeHardwareDemo.warningReference.source, 'baseline_informed');
  assert.equal(f.demoEvents.length, 1);
  const event = f.demoEvents[0];
  assert.equal(event.session_id, 'trip-1');
  assert.equal(event.profile_id, 'driver');
  assert.equal(event.episode_id, d.safety.check.episode.id);
  assert.equal(event.actual_value, 85);
  assert.equal(event.simulated_value, event.warning_threshold + 3);
  assert.equal(event.applied_offset, event.simulated_value - 85);
  assert.deepEqual([event.slots, event.accepted_slots, event.abnormal_slots], [5, 5, 5]);
  assert.ok(f.stored.length > 0);
  assert.ok(f.stored.every(([session, frame]) => session === 'trip-1' && frame.heartRate === 85));
  assert.deepEqual(f.saved, []);
  assert.equal(d.respondAlert('not_ok', { episodeId: event.episode_id, captureId: d.safety.check.captureId, question: 'wellness' }), true);
  await tick();
  const offer = f.render().safety.check;
  assert.equal(offer.question, 'contact_offer');
  await f.render().endSession();
  assert.equal(f.render().respondAlert('call_yes', { episodeId: event.episode_id, captureId: offer.captureId, question: offer.question }), false);
  assert.deepEqual(f.calls, []);
  assert.equal(f.demoEvents.length, 1);
  assert.equal(f.render().homeHardwareDemo.enabled, false);
});

test('an active demo requires explicit captured offer consent and saves its outcome once', async t => {
  const globals = globalThis as typeof globalThis & { __DEV__?: boolean };
  const original = globals.__DEV__;
  globals.__DEV__ = true;
  t.after(() => { if (original === undefined) delete globals.__DEV__; else globals.__DEV__ = original; });
  const f = harness(true);
  await f.select();
  await f.render().startSession();
  f.render().homeHardwareDemoControls.enable();
  f.render().homeHardwareDemoControls.configureSimulation({ enabled: true, scenario: 'low_spo2', mode: 'manual' });
  f.waveform('rejected');
  for (let seq = 0; seq < 8; seq++) f.feed(seq, 85);
  await tick();
  const answer = (response: string, scope: any) =>
    f.render().respondAlert(response, { episodeId: scope.episode.id, captureId: scope.captureId, question: scope.question });
  assert.equal(f.demoEvents[0].actual_value, 98);
  assert.equal(f.demoEvents[0].simulated_value, 90);
  assert.equal(f.demoEvents[0].threshold_source, 'standard');
  const wellness = f.render().safety.check;
  assert.equal(answer('not_ok', wellness), true);
  await tick();
  assert.equal(answer('call_yes', wellness), false);
  const offer = f.render().safety.check;
  assert.deepEqual(f.calls, []);
  assert.equal(answer('call_yes', offer), true);
  assert.equal(answer('call_yes', offer), false);
  await tick();
  assert.deepEqual(f.calls, ['tel:+13055550123']);
  assert.deepEqual(f.demoOutcomes, [[f.demoEvents[0].id, 'not_ok']]);
  assert.deepEqual(f.saved, []);
});

test('rollover, account change and production tracking each end active-drive demo ownership', async t => {
  const globals = globalThis as typeof globalThis & { __DEV__?: boolean };
  const original = globals.__DEV__;
  globals.__DEV__ = true;
  t.after(() => { if (original === undefined) delete globals.__DEV__; else globals.__DEV__ = original; });
  for (const cause of ['rollover', 'account', 'production']) {
    const f = harness(true);
    await f.select();
    f.account('original');
    await f.render().startSession();
    f.render().homeHardwareDemoControls.enable();
    f.render().homeHardwareDemoControls.configureSimulation({ enabled: true });
    f.waveform('rejected');
    for (let seq = 0; seq < 8; seq++) f.feed(seq, 85);
    await tick();
    const old = f.render().safety.check;
    const scope = { episodeId: old.episode.id, captureId: old.captureId, question: old.question };
    if (cause === 'rollover') f.feed(1, 85);
    if (cause === 'account') f.account('changed');
    if (cause === 'production') {
      f.waveform('passed');
      for (let seq = 8; seq < 24 && f.render().homeHardwareDemo.enabled; seq++) f.feed(seq, 180);
    }
    await tick();
    assert.equal(f.render().homeHardwareDemo.enabled, false, cause);
    assert.equal(f.render().respondAlert('not_ok', scope), false, cause);
    assert.equal(f.demoEvents.length, 1, cause);
    assert.equal(f.demoEvents[0].session_id, 'trip-1', cause);
    if (cause === 'rollover') assert.deepEqual(f.followed, ['trip-1', 'trip-2']);
    if (cause === 'production') assert.ok(f.render().safety.tracking || f.render().safety.check);
    assert.deepEqual(f.calls, []);
  }
});

test('confirmation ending with finger-contact loss saves the preceding accepted same-frame pair', async t => {
  const globals = globalThis as typeof globalThis & { __DEV__?: boolean };
  const original = globals.__DEV__;
  globals.__DEV__ = true;
  t.after(() => { if (original === undefined) delete globals.__DEV__; else globals.__DEV__ = original; });
  const f = harness(true);
  await f.select();
  await f.render().startSession();
  f.render().homeHardwareDemoControls.enable();
  f.render().homeHardwareDemoControls.configureSimulation({ enabled: true });
  f.waveform('rejected');
  for (let seq = 0; seq < 7; seq++) f.feed(seq, seq === 6 ? 86 : 85);
  f.feed(7, 99, false);
  await tick();
  const [event] = f.demoEvents;
  assert.equal(event.actual_value, 86);
  assert.equal(event.simulated_value, 86 + event.applied_offset);
  assert.equal(Date.parse(event.confirmed_at) - Date.parse(event.measured_at), 1000);
  assert.deepEqual([event.slots, event.accepted_slots, event.abnormal_slots], [5, 4, 4]);
  assert.equal(f.render().homeHardwareDemo.projected, null);
  f.render().homeHardwareDemoControls.stop();
});

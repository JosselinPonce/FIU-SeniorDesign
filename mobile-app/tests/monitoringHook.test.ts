import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { URL as NodeURL } from 'node:url';
import ts from 'typescript';
import { SafetyController, initialSafety } from '../lib/analysis/safetyController.ts';
import { SeqTracker } from '../lib/ble/protocol.ts';
import { openAuthorizedPhoneInterface } from '../lib/voice/phoneHandoff.ts';
import { recognitionEvidence } from '../lib/voice/coreRecognition.ts';
const require = createRequire(import.meta.url);
const tick = async () => { for (let n = 0; n < 20; n++) await new Promise<void>(r => setImmediate(r)); };

// Executes the real hook/reducer/controller, with only native transport, storage,
// React scheduling and cloud side effects replaced. No fabricated trip for safety.
function harness() {
  let index = 0, callbacks: any, appListener: any, input: any;
  let now = 100000;
  let lastSeq = -1;
  let spoken: string[] | null = null;
  const cells: any[] = [], effects: (() => void)[] = [], timers: (() => void)[] = [];
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
  const repo = {
    saveAlert: async (row: any) => { saved.push(row); }, setAck: async () => {}, saveSnapshot: async () => {},
    recoverInterruptedSessions: async () => 0, getStorageMode: async () => 'vitals', getSetting: async () => null,
    driverBaseline: async () => null, getAck: async () => ({ high: null, low: null }), driveMedians: async () => [],
    startSession: async (profile_id: string, storage_mode: string) => ({ id: `trip-${++trip}`, profile_id, storage_mode, status: 'active', started_at: new Date(now).toISOString() }),
    endSession: async (session: any) => ({ ...session, status: 'ended' }),
    storeFrame: async (...args: any[]) => { stored.push(args); return 'stored'; },
    setSessionSampleRate: async () => {}, setSetting: async () => {},
  };
  const deps: Record<string, any> = {
    '../voice/phoneHandoff': { openAuthorizedPhoneInterface },
    '../assistant/mode': { SENSI_MODE: 'gemma' },
    react, 'react-native': { AppState: app, Linking: { openURL: async (url: string) => { calls.push(url); } } },
    'expo-haptics': { notificationAsync: async () => {}, NotificationFeedbackType: {} },
    '../../modules/gemma-poc/phone': { phoneSafetyAcknowledgment: () => ({ get: () => 'I hear you.', source: 'fallback', cancel() {} }) },
    '../ble/bleService': { WheelConnection: class { constructor(cb: any) { callbacks = cb; } start() {} stop() {} setAllowDirect() {} } },
    '../ble/protocol': { SeqTracker, uuidv4: () => `id-${++id}`, Deframer: class { crcErrors = 0; feed() { return [input]; } } },
    '../db/liveSync': { LiveUploader: class { status = { bytesSent: 0 }; nudge() {} stop() {} follow(id: string) { followed.push(id); } async finish(id: string) { finished.push(id); } } },
    '../db/repositories': repo, '../db/sync': { syncToSupabase: async () => {} }, '../db/profileEditing': {},
    '../db/profileSync': { syncProfiles: async () => {} }, '../db/deletion': { processPendingDeletes: async () => {} },
    '../voice/audioOwnership': { appAudio: { stopActive: async () => {} } }, '../archive/archiveStore': { foldSession: async () => null },
    '../analysis/signal': { SignalAnalyzer: class { feed() { return null; } } },
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
  new Function('require', 'exports', 'setInterval', 'clearInterval', 'Date', compiled)(
    (name: string) => { assert.ok(name in deps, name); return deps[name]; }, exports,
    (fn: () => void) => { timers.push(fn); return timers.length; }, () => {}, ClockDate);
  function render() { index = 0; const value = exports.useDriveSession(); effects.splice(0).forEach(fn => fn()); return value; }
  const driver = { id: 'driver', display_name: 'Driver', age: 30, gender: 'male', height_cm: 180, weight_kg: 80,
    emergency_phone: '+13055550123', created_at: '', updated_at: '' };
  return { render, saved, stored, followed, finished, calls,
    spoken: (answers: string[]) => { spoken = answers; },
    get nextSequence() { return lastSeq + 1; },
    async select() { render().selectDriver(driver); await tick(); render().setSafetyPresentationEnabled(true); callbacks.onStateChange('connected'); },
    feed(seq: number, bpm = 155) {
      lastSeq = seq;
      now = 100000 + seq * 1000;
      input = { version: 3, seq, rateHz: 0, quality: 90, startMs: seq * 1000, endMs: (seq + 1) * 1000,
        heartRate: bpm, spo2: 98, flags: 15, samples: [], finger: true, usable: true, raw: new Uint8Array() };
      callbacks.onBytes(new Uint8Array());
    },
    app(state: string) { app.currentState = state; appListener(state); },
    link(state: string) { callbacks.onStateChange(state); },
  };
}

test('actual hook automatically monitors without recording; recording/upload start and stop independently', async () => {
  const f = harness(); await f.select();
  for (let i = 0; i < 14 && !f.render().safety.check; i++) f.feed(i);
  await tick(); const before = f.render(); assert.ok(before.safety.check); assert.equal(before.hasActiveSession, false);
  assert.deepEqual(f.saved, []); assert.deepEqual(f.stored, []); assert.deepEqual(f.followed, []);
  const scope = { episodeId: before.safety.check.episode.id, question: before.safety.check.question, captureId: before.safety.check.captureId };
  await before.startSession(); await tick();
  assert.equal(f.render().safety.check.captureId, scope.captureId);
  assert.deepEqual(f.followed, ['trip-1']);
  f.feed(f.nextSequence); await tick(); assert.equal(f.stored.at(-1)?.[0], 'trip-1');
  await f.render().endSession(); await tick();
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
      assert.ok(f.render().safety.conversation.messages.some((m: any) => /Simulation complete/.test(m.text)));
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
  assert.equal(f.render().safety.conversation.messages.some((m: any) => /Simulation complete/.test(m.text)), false);
});

import type { RecognitionPhase, VoiceCaptureMilestones } from '../lib/voice/voiceCheck.ts';
import type { SignalQuality } from '../lib/analysis/signal.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HardwareSafetyTest, type HardwareSafetySnapshot, type HardwareStartBlock, type HardwareWaveformQuality } from '../lib/diagnostics/hardwareSafetyTest.ts';
import { FlagEngine, type Thresholds } from '../lib/analysis/flagEngine.ts';
import type { Baseline } from '../lib/analysis/baseline';
import { deriveDiagnosticThresholds } from '../lib/diagnostics/personalizedHardwareThreshold.ts';
import type { DriverProfile } from '../lib/db/repositories';
import type { Frame } from '../lib/ble/protocol';
import { recognitionEvidence } from '../lib/voice/coreRecognition.ts';

Object.assign(globalThis, { __DEV__: true });
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const profile: DriverProfile = {
  id: 'driver', custom_id: null, display_name: 'Test Driver', language: 'en', age: 35,
  gender: 'female', height_cm: 166, weight_kg: 65, created_at: '', updated_at: 'revision',
  emergency_name: 'Saved Contact', emergency_phone: '+1 (202) 555-0124',
};

const reference: Baseline = { established: true, readings: 78, sessions: 3,
  bpmP10: 74, bpmMedian: 78, bpmP90: 82, spo2P10: 95, spo2Median: 97 };

const production: Thresholds = {
  highWarn: 105, highCrit: 131, highNotice: 95, lowWarn: 45, lowCrit: 40, lowNotice: 50,
  spo2Warn: 93, spo2Crit: 91, spo2Notice: 95,
};

function fixture(answers?: (string | null)[], holdQuestion: boolean | number = false) {
  const heldQuestion = holdQuestion === true ? 1 : holdQuestion;
  let questionNumber = 0;
  let finishSpeech: (() => void) | undefined;
  let cancels = 0, releases = 0;
  const spokenLanguages: string[] = [];
  let now = 10_000, seq = 0, id = 0;
  let blocked: HardwareStartBlock | null = null;
  let monitoring = true;
  let voiceAvailable = true;
  let promptUnavailable = false;
  let rejectDialer = false;
  let savedReadBarrier: Promise<void> | undefined;
  let nextRecognition: ((captureId: string, observe?: (milestones: VoiceCaptureMilestones) => void, onPhase?: (phase: RecognitionPhase) => void) => ReturnType<typeof recognitionEvidence> | null) | undefined;
  let onVoiceSetup: (() => void) | undefined;
  let driver = { ...profile }, saved = { ...profile };
  let state!: HardwareSafetySnapshot;
  const baselines = new Map<string, Baseline | null>([[profile.id, reference]]);
  const urls: string[] = [];
  const test = new HardwareSafetyTest({
    contextBlock: () => blocked, monitoringActive: () => monitoring,
    productionState: () => ({ monitoring: monitoring ? 'active' : 'waiting', tracking: blocked === 'safety' }), driver: () => driver, baseline: id => baselines.get(id) ?? null, thresholds: () => production, readDriver: async () => { if (savedReadBarrier) await savedReadBarrier; return saved; },
    change: next => { state = next; }, releaseAudio() { releases++; },
    voiceIO: () => {
      onVoiceSetup?.();
      if (!voiceAvailable) throw Error('Voice setup unavailable');
      return { prepareRecognition() { questionNumber++; }, speak: async (_text, language) => {
        spokenLanguages.push(language);
        if (promptUnavailable) return { status: 'unavailable' as const };
        if (heldQuestion === questionNumber && !finishSpeech) await new Promise<void>(resolve => { finishSpeech = resolve; });
      }, cancel() { cancels++; finishSpeech?.(); }, listen: async (_language, _duration, _hints, capture, phase, observe) => {
      if (nextRecognition) return nextRecognition(capture, observe, phase);
      if (!answers) return new Promise(() => {});
      const text = answers.shift();
      return text ? recognitionEvidence(capture, { status: 'success', transcript: text, finalTranscript: text,
        isFinal: true, finalResultReceived: true }) : null;
    } }; },
    openURL: async url => { urls.push(url); if (rejectDialer) throw Error('native open failed'); }, id: () => `id-${++id}`, now: () => now,
  });
  function feed(override: Partial<Frame> = {}, quality: boolean | HardwareWaveformQuality = true, age = 0, elapsed = 1000, calibratedBpm?: number, options?: { missingInput?: boolean; signalQuality?: SignalQuality; missingFrames?: number }) {
    now += elapsed; seq++;
    const frame = { seq, version: 3, endMs: seq * 1000, heartRate: 78, spo2: 97, quality: 90,
      finger: true, usable: true, flags: 15, ...override } as Frame;
    const waveform = typeof quality === 'boolean' ? quality ? 'passed' : 'rejected' : quality;
    const at = now - age;
    test.frame(frame, at, options?.missingFrames ?? 0, waveform, options?.missingInput ? null : { t: at, bpm: frame.usable ? calibratedBpm ?? frame.heartRate : null,
      spo2: frame.usable ? frame.spo2 : null, finger: frame.finger, quality: frame.version === 2 ? null : frame.quality,
      good: waveform === 'passed' ? true : waveform === 'rejected' ? false : null }, false, options?.signalQuality, calibratedBpm ?? frame.heartRate);

  }
  return {
    test, feed, urls, spokenLanguages, finishSpeech: () => finishSpeech?.(), audio: () => ({ cancels, releases }), baseline: (id: string, b: Baseline | null) => { baselines.set(id, b); test.tick(); }, state: () => state, sequence: () => seq,
    wait(ms: number) { now += ms; test.tick(); },
    block(reason: HardwareStartBlock | null) { blocked = reason; test.tick(); },
    monitoring(value: boolean) { monitoring = value; test.tick(); },
    breakVoiceSetup() { voiceAvailable = false; },
    breakPromptPlayback() { promptUnavailable = true; },
    failNativeDialer() { rejectDialer = true; },
    scriptRecognition(script: typeof nextRecognition) { nextRecognition = script; },
    duringVoiceSetup(action: () => void) { onVoiceSetup = action; },
    disconnect() { blocked = 'hardware'; test.tick(); },
    select(updated: Partial<DriverProfile>) { driver = { ...driver, ...updated }; test.tick(); },
    holdSavedReadUntil(barrier: Promise<void>) { savedReadBarrier = barrier; },
    changeSaved(updated: Partial<DriverProfile>) { saved = { ...saved, ...updated }; },
    async trigger(allow = true) { assert.equal(test.start(allow), true); for (let n = 0; n < 18; n++) feed({ heartRate: 80 }); await flush(); },
    scope() {
      const check = state.safety?.check;
      assert.ok(check);
      return { episodeId: check.episode.id, captureId: check.captureId, question: check.question };
    },
  };
}

test('derive frozen personalized warning limits without mutating production or overriding critical and oxygen', () => {
  const derived = deriveDiagnosticThresholds(reference, production)!;
  assert.deepEqual([derived.low, derived.high], [76, 80]);
  assert.deepEqual(derived.production, production);
  assert.deepEqual(derived.test, { ...production, lowWarn: 76, highWarn: 80 });
  assert.notEqual(derived.test, production);
  assert.equal(Object.isFrozen(derived.test), true);
  assert.equal(deriveDiagnosticThresholds({ ...reference, bpmMedian: null }, production), null);
  assert.equal(deriveDiagnosticThresholds({ ...reference, established: false }, production), null);
  assert.equal(deriveDiagnosticThresholds(reference, { ...production, lowCrit: 78 }), null);
  assert.equal(deriveDiagnosticThresholds({ ...reference, bpmP10: 128, bpmMedian: 130, bpmP90: 134 },
    { ...production, highWarn: 140, highCrit: 150 }), null, 'NEWS2 critical branch cannot become a warning boundary');
  const extreme = deriveDiagnosticThresholds({ ...reference, bpmP10: 92, bpmMedian: 93, bpmP90: 94 }, production)!;
  assert.equal(extreme.low - production.lowWarn, 40);
});

test('missing or incomplete driver baseline blocks Start; switching drivers cancels and selects only their baseline', () => {
  const f = fixture();
  f.baseline('driver', null); f.feed();
  assert.equal(f.state().startBlock, 'baseline');
  f.baseline('driver', { ...reference, established: false, readings: 59 });
  assert.equal(f.test.start(), false);
  f.baseline('driver', reference);
  assert.equal(f.test.start(), true);
  f.baseline('driver', { ...reference, bpmP10: 94, bpmMedian: 98, bpmP90: 102 });
  assert.equal(f.state().limits?.high, 80);
  f.select({ id: 'other' });
  assert.equal(f.state().phase, 'cancelled');
  assert.equal(f.state().startBlock, 'baseline');
  f.baseline('other', { ...reference, bpmP10: 84, bpmMedian: 88, bpmP90: 92 });
  assert.equal(f.test.start(), true);
  assert.equal(f.state().limits?.high, 90);
});

for (const [bpm, kind, level, wait] of [
  [82, 'bpm_high', 'warning', 15], [75, 'bpm_low', 'warning', 15], [135, 'bpm_high', 'critical', 8],
] as const) {
  test(`isolated hardware engine starts VoiceCheck only on the actual ${kind} ${level} emergency`, () => {
    const f = fixture();
    f.test.start();
    const direct = new FlagEngine(deriveDiagnosticThresholds(reference, production)!.test, () => 'comparison');
    for (let i = 1; i <= 3 + wait; i++) {
      f.feed({ heartRate: bpm });
      const events = direct.feed({ t: 10_000 + i * 1000, bpm, spo2: 97, quality: 90, finger: true, good: true });
      assert.equal(!!f.state().confirmed, events.some(event => event.type === 'emergency'), `frame ${i}`);
      if (i === 3) assert.equal(f.state().detection?.tracks[0]?.required, wait);
    }
    assert.equal(f.state().voiceCheck, 'active');
    assert.equal(f.state().confirmed?.kind, kind);
    assert.equal(f.state().confirmed?.level, level);
    assert.equal(f.state().confirmed?.confirmedAt, direct.pending?.confirmedAt);
    f.test.cancel();
  });
}

test('in-range values and a single Hampel outlier do not trigger', () => {
  const f = fixture();
  f.test.start();
  for (let i = 0; i < 7; i++) f.feed({ heartRate: 78 });
  f.feed({ heartRate: 140 });
  assert.equal(f.state().detection?.filteredBpm, 78);
  assert.ok(f.state().detection!.rejected > 0);
  assert.equal(f.state().confirmed, null);
});

test('continuity gaps reset production-style confirmation; invalid contiguous frames count against coverage', () => {
  const f = fixture();
  f.test.start();
  for (let i = 0; i < 10; i++) f.feed({ heartRate: 82, quality: i > 2 && i % 2 === 0 ? 20 : 90 });
  const before = f.state().detection?.tracks[0];
  assert.equal(before?.samples, 7);
  assert.equal(before?.accepted, 4);
  f.wait(3000);
  assert.equal(f.state().detection?.tracks.length, 0);
  assert.equal(f.state().continuityResets, 1);
  for (let i = 0; i < 10; i++) f.feed({ heartRate: 82 });
  assert.equal(f.state().confirmed, null);
});

test('arming before telemetry is stable and invalid data does not flap Start', () => {
  const f = fixture();
  assert.equal(f.test.startBlock(), null);
  assert.equal(f.test.start(), true);
  assert.equal(f.state().phase, 'waiting');
  f.feed({ finger: false });
  assert.equal(f.state().lastFrame?.rejection, 'contact');
  assert.equal(f.state().voiceCheck, 'idle');
  f.test.reset();
  assert.equal(f.state().startBlock, null);
});

test('confirmed evidence reports the production blocker until a fresh frame can launch VoiceCheck', () => {
  const f = fixture();
  f.monitoring(false);
  f.test.start();
  for (let i = 0; i < 18; i++) f.feed({ heartRate: 80 });
  assert.equal(f.state().phase, 'confirmed');
  assert.equal(f.state().triggerBlock, 'monitoring');
  assert.equal(f.state().voiceCheck, 'idle');
  f.monitoring(true);
  f.feed({ heartRate: 80 });
  assert.equal(f.state().voiceCheck, 'active');
  f.test.cancel();
});

test('a VoiceCheck startup failure is reported without implying activation', async () => {
  const f = fixture();
  f.breakVoiceSetup();
  await f.trigger(false);
  assert.equal(f.state().voiceCheck, 'setup_failed');
  assert.equal(f.state().safety, null);
  assert.deepEqual(f.urls, []);
});

test('duplicate, replayed, stale, and implausible readings cannot count', () => {
  const f = fixture();
  f.feed(); f.test.start(); f.feed(); f.feed({ heartRate: 80 });
  f.feed({ seq: f.sequence(), endMs: f.sequence() * 1000, heartRate: 80 });
  f.feed({ seq: 1, endMs: 1000, heartRate: 80 });
  f.feed({ heartRate: 80 }, true, 3000);
  f.feed({ spo2: 101, heartRate: 80 });
  assert.equal(f.state().confirmed, null);
  assert.equal(f.state().safety, null);
});

for (const [name, change] of [
  ['prolonged loss', (f: ReturnType<typeof fixture>) => { f.wait(3000); assert.equal(f.state().phase, 'recovering'); f.wait(12_000); }],
  ['driver change', (f: ReturnType<typeof fixture>) => f.select({ id: 'other' })],
  ['disconnect', (f: ReturnType<typeof fixture>) => f.disconnect()],
  ['background', (f: ReturnType<typeof fixture>) => f.block('foreground')],
] as const) {
  test(`${name} terminates the evaluator without handoff`, () => {
    const f = fixture();
    f.feed(); f.test.start(true); f.feed();
    change(f);
    assert.equal(f.state().phase, 'cancelled');
    assert.deepEqual(f.urls, []);
  });
}

test('reset after cancellation respects hardware readiness and unblocks automatically on a fresh sample', () => {
  const f = fixture();
  f.feed(); f.test.start();
  f.disconnect(); f.test.reset();
  assert.equal(f.state().phase, 'idle');
  assert.equal(f.state().startBlock, 'hardware');
  f.block(null);
  assert.equal(f.state().startBlock, null);
  f.feed();
  assert.equal(f.state().startBlock, null);
  assert.equal(f.test.start(), true);
});

test('reset after completed runs preserves cooldown and refreshes Start without another reset', async () => {
  const f = fixture(['yes']);
  await f.trigger(false);
  assert.equal(f.state().phase, 'finished');
  f.test.reset();
  assert.equal(f.state().phase, 'idle');
  assert.equal(f.state().startBlock, 'cooldown');
  assert.equal(f.test.start(), false);
  for (let i = 0; i < 10; i++) f.feed();
  assert.equal(f.state().startBlock, null);
  assert.equal(f.test.start(), true);
  assert.ok(f.state().detection?.cooldowns.some(cooldown => cooldown.kind === 'bpm_high'));
  for (let i = 0; i < 18; i++) f.feed({ heartRate: 82 });
  assert.equal(f.state().confirmed, null, 'a new session retains the engine cooldown for the resolved warning');
});

test('Start and its readiness reason share the same context gates', () => {
  const f = fixture();
  for (const reason of ['platform', 'foreground', 'hardware', 'recording', 'profile', 'safety'] as const) {
    f.block(reason);
    assert.equal(f.state().startBlock, reason);
    assert.equal(f.test.start(), false);
  }
  f.block(null);
  assert.equal(f.state().startBlock, null);
  f.feed();
  f.select({ emergency_phone: '911' });
  assert.equal(f.state().contactReady, false);
  assert.equal(f.test.startBlock(true), 'contact');
  assert.equal(f.test.start(true), false);
  assert.equal(f.test.start(), true);
});

for (const channel of ['button', 'typed', 'voice'] as const) {
  test(`${channel} offer consent prepares a permit and only exact in-app approval requests the dialer`, async () => {
    const f = fixture(channel === 'voice' ? ['no', 'yes'] : undefined);
    await f.trigger();
    if (channel !== 'voice') {
      assert.equal(f.test.answer('not_ok', f.scope()), true);
      await flush();
      assert.equal(f.scope().question, 'contact_offer');
      assert.equal(channel === 'button' ? f.test.answer('call_yes', f.scope()) : f.test.answerText('yes please', f.scope()), true);
      await flush();
    }
    const pending = f.state().confirmation;
    assert.equal(pending?.phone, '+12025550124');
    assert.equal(pending?.name, 'Saved Contact');
    assert.deepEqual(f.urls, []);
    await Promise.all([f.test.confirm(pending!.id), f.test.confirm(pending!.id)]);
    assert.deepEqual(f.urls, ['tel:+12025550124']);
    assert.equal(f.state().result, 'requested');
    assert.equal(f.state().confirmation, null);
  });
}

for (const [name, allow, answers] of [
  ['permission off', false, ['no', 'yes']],
  ['refusal', true, ['no', 'no']],
  ['silence after offer', true, ['no', null, null]],
  ['direct request without accepting an offer', true, ['call my emergency contact']],
  ['emergency services request', true, ['no', 'call 911']],
] as const) {
  test(`${name} cannot prepare a dialer handoff`, async () => {
    const f = fixture([...answers]);
    await f.trigger(allow);
    assert.equal(f.state().confirmation, null);
    assert.deepEqual(f.urls, []);
    f.test.cancel();
  });
}

test('final approval re-reads saved contact and rejects a changed number or service code', async () => {
  const f = fixture(['no', 'yes']);
  await f.trigger();
  const pending = f.state().confirmation!;
  f.changeSaved({ emergency_phone: '+12025550125' });
  await f.test.confirm(pending.id);
  assert.equal(f.state().phase, 'cancelled');
  assert.deepEqual(f.urls, []);
  for (const number of ['911', '112', '999', '9-1-1']) {
    const invalid = fixture();
    invalid.select({ emergency_phone: number });
    invalid.feed();
    assert.equal(invalid.test.start(true), false);
  }
});

test('the permit expires while telemetry is still fresh', async () => {
  const f = fixture(['no', 'yes']);
  await f.trigger();
  const pending = f.state().confirmation!;
  for (let i = 0; i < 30; i++) f.feed();
  assert.equal(f.state().phase, 'cancelled');
  await f.test.confirm(pending.id);
  assert.deepEqual(f.urls, []);
});

test('reset after session expiration clears the run but preserves cooldown', async () => {
  const f = fixture();
  await f.trigger();
  for (let i = 0; i < 162; i++) f.feed();
  assert.equal(f.state().phase, 'cancelled');
  assert.equal(f.state().allowsContact, false);
  f.test.reset();
  await flush();
  assert.equal(f.state().phase, 'idle');
  assert.equal(f.state().startBlock, 'cooldown');
  for (let i = 0; i < 10; i++) f.feed();
  assert.equal(f.test.start(), true);
});

test('loss of eligibility during the final saved-contact read prevents the native request', async () => {
  const f = fixture(['no', 'yes']);
  await f.trigger();
  const confirming = f.test.confirm(f.state().confirmation!.id);
  f.disconnect();
  await confirming;
  assert.equal(f.state().phase, 'cancelled');
  assert.deepEqual(f.urls, []);
});

test('hardware quality can qualify while the phone waveform window fills, but failed waveform analysis cannot', () => {
  const f = fixture();
  f.feed({}, 'warming');
  assert.equal(f.state().startBlock, null);
  assert.equal(f.state().lastFrame?.waveform, 'warming');
  assert.equal(f.state().lastFrame?.rejection, null);
  const lastGood = f.state().lastQualifiedAt;
  f.feed({}, 'rejected');
  assert.equal(f.state().startBlock, null);
  assert.equal(f.state().lastFrame?.rejection, 'waveform');
  assert.deepEqual([f.state().lastFrame?.bpm, f.state().lastFrame?.spo2], [78, 97]);
  assert.equal(f.state().lastQualifiedAt, lastGood);
  f.feed({ quality: 49 }, 'unavailable');
  assert.equal(f.state().lastFrame?.rejection, 'firmware');
  f.feed({ version: 2, quality: 0 }, 'unavailable');
  assert.equal(f.state().startBlock, null);
  assert.equal(f.state().lastFrame?.firmwareQuality, null);
});

test('real-contact run can collect firmware-qualified frames but retains the passing waveform requirement', async () => {
  const f = fixture(['no', 'yes']);
  f.feed({}, 'warming');
  assert.equal(f.test.start(true), true);
  for (let i = 0; i < 18; i++) f.feed({ heartRate: 80 }, 'warming');
  assert.ok(f.state().confirmed);
  assert.equal(f.state().triggerBlock, 'handoff_quality');
  assert.equal(f.state().safety, null);
  f.feed({ heartRate: 80 }, 'passed');
  await flush();
  assert.ok(f.state().confirmation);
  f.feed({}, 'warming');
  assert.equal(f.state().phase, 'cancelled');
  assert.equal(f.state().lastFrame?.rejection, 'handoff_quality');
  assert.equal(f.state().confirmation, null);
  assert.deepEqual(f.urls, []);
});

test('last-frame evidence distinguishes an old or duplicate frame from transport silence', () => {
  const f = fixture();
  f.feed();
  const lastGood = f.state().lastQualifiedAt;
  f.feed({ seq: f.sequence() });
  assert.equal(f.state().lastFrame?.sequence, 'duplicate');
  assert.equal(f.state().lastQualifiedAt, lastGood);
  f.feed({}, true, 3000);
  assert.equal(f.state().lastFrame?.rejection, 'stale');
  f.wait(5000);
  assert.equal(f.state().lastFrame?.rejection, 'stale', 'no new frame means the prior observation remains visible');
  assert.equal(f.state().startBlock, null);
});

test('detector consumes calibrated production input while retaining raw frame evidence', () => {
  const f = fixture();
  f.test.start();
  for (let i = 0; i < 18; i++) f.feed({ heartRate: 78 }, true, 0, 1000, 82);
  assert.equal(f.state().lastFrame?.bpm, 78);
  assert.equal(f.state().detection?.filteredBpm, 82);
  assert.equal(f.state().confirmed?.value, 82);
  f.test.cancel();
});

test('poor coverage cannot confirm even while qualified readings stay beyond the boundary', () => {
  const f = fixture();
  f.test.start();
  for (let i = 0; i < 3; i++) f.feed({ heartRate: 82 });
  for (let i = 0; i < 15; i++) f.feed({ heartRate: 82, quality: i % 2 ? 90 : 20 });
  const track = f.state().detection?.tracks[0];
  assert.equal(track?.samples, 15);
  assert.equal(track?.accepted, 7);
  assert.equal(track?.beyond, 7);
  assert.equal(f.state().confirmed, null);
  assert.equal(f.state().voiceCheck, 'idle');
});

for (const [language, answer] of [['en', "I'm okay"], ['es', 'Estoy bien']] as const) {
  test(`active ${language} VoiceCheck survives continuous waveform, vitals and contact rejection`, async () => {
    const f = fixture([answer], true);
    f.select({ language });
    await f.trigger(false);
    const scope = f.scope();
    assert.equal(f.state().voiceCheck, 'active');
    const lastQualifiedAt = f.state().lastQualifiedAt;
    const detection = f.state().detection;
    f.feed({ usable: false }, 'rejected', 7);
    assert.equal(f.state().lastFrame?.rejection, 'vitals');
    assert.equal(f.state().lastFrame?.waveform, 'rejected');
    assert.equal(f.state().lastFrame?.sequence, 'accepted');
    assert.equal(f.state().lastQualifiedAt, lastQualifiedAt);
    assert.equal(f.state().reading, null);
    assert.equal(f.state().detection, detection);
    assert.deepEqual(f.scope(), scope);
    f.monitoring(false);
    for (let i = 0; i < 4; i++) f.feed({}, 'rejected');
    f.feed({ finger: false, usable: false }, 'rejected');
    assert.equal(f.state().lastFrame?.rejection, 'contact');
    assert.deepEqual(f.scope(), scope);
    assert.equal(f.state().phase, 'checking');
    assert.deepEqual(f.audio(), { cancels: 0, releases: 0 });
    f.finishSpeech();
    await flush();
    assert.equal(f.state().safety?.last?.result.outcome, 'ok');
    assert.ok(f.spokenLanguages.every(value => value.startsWith(language)));
    assert.equal(f.audio().releases, 1);
  });
}

test('a confirmed warning cannot activate VoiceCheck on combined vitals and waveform rejection', async () => {
  const f = fixture(['yes']);
  f.monitoring(false);
  await f.trigger(false);
  assert.ok(f.state().confirmed);
  assert.equal(f.state().triggerBlock, 'monitoring');
  f.monitoring(true);
  const lastQualifiedAt = f.state().lastQualifiedAt;
  f.feed({ usable: false }, 'rejected', 7);
  await flush();
  assert.equal(f.state().lastFrame?.rejection, 'vitals');
  assert.equal(f.state().lastFrame?.waveform, 'rejected');
  assert.equal(f.state().lastFrame?.sequence, 'accepted');
  assert.equal(f.state().lastQualifiedAt, lastQualifiedAt);
  assert.equal(f.state().triggerBlock, 'qualified_signal');
  assert.equal(f.state().voiceCheck, 'idle');
  assert.deepEqual(f.spokenLanguages, []);
});

for (const [language, refusal, consent] of [['en', 'no', 'yes'], ['es', 'no', 'sí']] as const) {
  test(`active ${language} wellness retry survives a vitals rejection while the waveform warms`, async () => {
    const f = fixture([null, refusal, consent], 2);
    f.select({ language });
    await f.trigger();
    const scope = f.scope();
    assert.equal(scope.question, 'wellness');
    assert.match(scope.captureId, /^core-\d+-2$/);
    assert.equal(f.state().confirmed?.id, scope.episodeId);
    assert.equal(f.state().voiceCheck, 'active');
    const lastQualifiedAt = f.state().lastQualifiedAt!;
    const detection = f.state().detection;

    f.monitoring(false);
    for (let i = 0; i < 23; i++) f.feed({}, 'rejected');
    f.feed({ usable: false }, 'warming');
    const frame = f.state().lastFrame;
    assert.equal(frame?.rejection, 'vitals');
    assert.equal(frame?.waveform, 'warming');
    assert.equal(frame?.sequence, 'accepted');
    assert.ok(frame.at - lastQualifiedAt > 22_900);
    assert.equal(f.state().reading, null);
    assert.equal(f.state().lastQualifiedAt, lastQualifiedAt);
    assert.equal(f.state().detection, detection);
    assert.deepEqual(f.scope(), scope);
    assert.equal(f.state().voiceCheck, 'active');
    assert.deepEqual(f.audio(), { cancels: 0, releases: 0 });

    f.monitoring(true);
    f.feed();
    assert.ok(f.state().reading);
    f.finishSpeech();
    await flush();
    assert.equal(f.state().voiceCheck, 'completed');
    assert.equal(f.state().safety?.last?.result.outcome, 'not_ok');
    assert.equal(f.state().safety?.last?.result.contactCall, 'accepted_offer');
    assert.equal(f.state().confirmation, null);
    await f.test.confirm(scope.episodeId);
    assert.deepEqual(f.urls, []);
    assert.equal(f.audio().releases, 1);
  });
}

test('invalid vitals without waveform rejection still cancel active dialogue', async () => {
  const f = fixture(['yes'], true);
  await f.trigger(false);
  f.feed({ usable: false }, 'passed', 7);
  await flush();
  assert.equal(f.state().phase, 'cancelled');
  assert.equal(f.state().lastCancellation?.rejection, 'vitals');
  assert.equal(f.audio().releases, 1);
});

test('a temporary signal rejection permanently prevents a new handoff permit after recovery', async () => {
  const f = fixture(['no', 'yes'], true);
  await f.trigger();
  assert.equal(f.state().voiceCheck, 'active');
  const episodeId = f.scope().episodeId;
  f.feed({ usable: false }, 'rejected', 7);
  f.feed();
  f.finishSpeech();
  await flush();
  assert.equal(f.state().safety?.last?.result.contactCall, 'accepted_offer');
  assert.equal(f.state().confirmation, null);
  await f.test.confirm(episodeId);
  assert.deepEqual(f.urls, []);
});

for (const [source, stop] of [
  ['transport_silence', (f: ReturnType<typeof fixture>) => {
    f.feed({ seq: f.sequence() });
    f.wait(2000);
  }],
  ['frame_rejected', (f: ReturnType<typeof fixture>) => f.feed({ seq: f.sequence() + 2 })],
  ['context', (f: ReturnType<typeof fixture>) => f.block('safety')],
  ['disconnect', (f: ReturnType<typeof fixture>) => f.test.disconnect()],
  ['explicit', (f: ReturnType<typeof fixture>) => f.test.cancel()],
] as const) {
  test(`active speech is cancelled and audio is released on ${source}`, async () => {
    const f = fixture(['yes'], true);
    await f.trigger(false);
    const scope = f.scope();
    stop(f);
    await flush();
    assert.equal(f.state().phase, 'cancelled');
    assert.ok(f.audio().cancels > 0);
    assert.equal(f.audio().releases, 1);
    assert.equal(f.spokenLanguages.length, 1);
    const record = f.state().lastCancellation;
    assert.equal(record?.episodeId, scope.episodeId);
    assert.equal(record?.captureId, scope.captureId);
    assert.equal(record?.source, source);
    assert.ok(record?.frameSequence);
    if (source === 'context') assert.equal(record?.contextBlock, 'safety');
    if (source === 'transport_silence') {
      assert.equal(record?.continuity, 'duplicate');
      assert.equal(record?.lastContinuousAgeMs, 3000);
    }
    if (source === 'frame_rejected') assert.equal(record?.continuity, 'gap');
  });
}


test('signal loss while confirming revokes the existing permit before the saved-contact read returns', async () => {
  const f = fixture(['no', 'yes']);
  await f.trigger();
  const pending = f.state().confirmation!;
  assert.ok(pending);
  const confirming = f.test.confirm(pending.id);
  f.feed({ usable: false }, 'rejected', 7);
  f.feed();
  await confirming;
  await f.test.confirm(pending.id);
  assert.equal(f.state().phase, 'cancelled');
  assert.equal(f.state().lastCancellation?.rejection, 'vitals');
  assert.deepEqual(f.urls, []);
});

test('attempt evidence distinguishes qualification from evaluator slots and survives cancellation', () => {
  const f = fixture();
  assert.equal(f.test.start(), true);
  for (let i = 0; i < 6; i++) f.feed({ heartRate: 80 });
  f.feed({ heartRate: 80 }, 'rejected', 0, 1000, undefined, {
    signalQuality: { good: false, hrBeats: 71, beats: 10, feasible: true, templateR: 0.8,
      skewness: -0.1, perfusion: 0.5, agree: false },
  });
  f.feed({ heartRate: 80 }, 'passed', 0, 1000, undefined, { missingInput: true });
  f.feed({ heartRate: 79 });
  f.feed({ heartRate: 100 });
  const evidence = f.state().attemptEvidence!;
  assert.deepEqual(evidence, {
    diagnosticQualifiedFrames: 9, waveformRejectedFrames: 1, evaluatorInputs: 9,
    missingEvaluatorInputs: 1, hampelRejections: 1,
    confirmationWindows: { bpm_high: { kind: 'bpm_high', level: 'warning', threshold: 80,
      required: 15, slots: 6, accepted: 4, beyond: 3 } },
    lastContinuityBreak: null,
    lastWaveformFailure: { frameSequence: 7, measuredHr: 80, phoneHr: 71, beats: 10, templateCorrelation: 0.8,
      skewness: -0.1, perfusion: 0.5, failedChecks: ['beat_template', 'skewness', 'estimator_agreement'] },
  });

  f.wait(15_000);
  assert.equal(f.state().lastCancellation?.source, 'qualified_signal');
  f.feed({}, 'rejected');
  assert.deepEqual(f.state().attemptEvidence, evidence);
  f.test.reset();
  assert.equal(f.state().attemptEvidence, null);
  assert.equal(f.test.start(), true);
  f.feed({ heartRate: 80 });
  assert.deepEqual(f.state().attemptEvidence, {
    diagnosticQualifiedFrames: 1, waveformRejectedFrames: 0, evaluatorInputs: 1,
    missingEvaluatorInputs: 0, hampelRejections: 0, confirmationWindows: {}, lastWaveformFailure: null, lastContinuityBreak: null,
  });
});

test('attempt evidence retains the exact window removed when FlagEngine confirms', async () => {
  const f = fixture();
  await f.trigger(false);
  assert.ok(f.state().confirmed);
  assert.equal(f.state().detection?.tracks.length, 0);
  const evidence = f.state().attemptEvidence;
  assert.deepEqual(evidence?.confirmationWindows.bpm_high, { kind: 'bpm_high', level: 'warning',
    threshold: 80, required: 15, slots: 15, accepted: 15, beyond: 15 });
  f.test.cancel();
  assert.deepEqual(f.state().attemptEvidence, evidence);
});

test('an active single-frame skip retains the exact break and ownership after cancellation', async () => {
  const f = fixture(['yes'], true);
  await f.trigger(false);
  const { episodeId, captureId } = f.scope();
  const previousSequence = f.sequence();
  f.feed({ seq: previousSequence + 2, endMs: (previousSequence + 2) * 1000 }, 'passed', 0, 2000, undefined, { missingFrames: 1 });
  await flush();
  assert.equal(f.state().phase, 'cancelled');
  assert.equal(f.state().lastCancellation?.continuity, 'gap');
  const evidence = f.state().attemptEvidence?.lastContinuityBreak;
  assert.deepEqual(evidence, { previousSequence, currentSequence: previousSequence + 2,
    sequenceDelta: 2, missingFrames: 1, phoneIntervalMs: 2000, deviceIntervalMs: 2000,
    failedChecks: ['sequence_delta', 'missing_frames'], voiceCheckActive: true, episodeId, captureId });
  f.feed();
  assert.deepEqual(f.state().attemptEvidence?.lastContinuityBreak, evidence);
  f.test.reset();
  assert.equal(f.state().attemptEvidence, null);
});

test('a timing-only break records the checks that failed with no missing sequence', () => {
  const f = fixture();
  assert.equal(f.test.start(), true);
  f.feed();
  f.feed({ endMs: 5000 }, 'passed', 0, 300);
  assert.deepEqual(f.state().attemptEvidence?.lastContinuityBreak, {
    previousSequence: 1, currentSequence: 2, sequenceDelta: 1, missingFrames: 0,
    phoneIntervalMs: 300, deviceIntervalMs: 4000, failedChecks: ['phone_interval_short', 'device_interval_stale'],
    voiceCheckActive: false, episodeId: null, captureId: null,
  });
  assert.equal(f.state().phase, 'recovering');
});

test('a transport restart records the pre-disconnect anchor and active capture', async () => {
  const f = fixture(['yes'], true);
  await f.trigger(false);
  const { episodeId, captureId } = f.scope();
  const previousSequence = f.sequence();
  const at = f.state().lastFrame!.at + 1000;
  f.test.recordTransportRestart({ seq: 0, endMs: 1000 } as Frame, at, 0);
  f.test.disconnect('transport_restart');
  await flush();
  assert.equal(f.state().lastCancellation?.source, 'transport_restart');
  assert.deepEqual(f.state().attemptEvidence?.lastContinuityBreak, {
    previousSequence, currentSequence: 0, sequenceDelta: (-previousSequence) >>> 0, missingFrames: 0,
    phoneIntervalMs: 1000, deviceIntervalMs: (1000 - previousSequence * 1000) >>> 0,
    failedChecks: ['transport_restart'], voiceCheckActive: true, episodeId, captureId,
  });
});

const benchMorphology: SignalQuality = {
  good: false, hrBeats: 80, beats: 13, feasible: true, agree: true, templateR: 0.8, skewness: -0.2, perfusion: 0.5,
};
const benchPassing: SignalQuality = { ...benchMorphology, good: true, templateR: 0.9, skewness: 0.2 };

test('bench-only confirmation uses calibrated current firmware HR and the unchanged warning window', async () => {
  const f = fixture(['yes']);
  f.monitoring(false);
  assert.equal(f.test.start(false, true), true);
  const read = (bpm = 81) => f.feed({ heartRate: 80 }, 'rejected', 0, 1000, bpm,
    { signalQuality: benchMorphology, missingInput: true });
  for (let i = 0; i < 3; i++) read();
  assert.equal(f.state().reading?.bpm, 81);
  assert.equal(f.state().lastFrame?.bpm, 80);
  for (let i = 0; i < 4; i++) f.feed({ heartRate: -999, usable: false }, 'rejected', 0, 1000, 81, { signalQuality: benchMorphology });
  read(79);
  read(79);
  for (let i = 0; i < 8; i++) read();
  assert.equal(f.state().confirmed, null);
  assert.equal(f.state().voiceCheck, 'idle');
  read();
  await flush();
  assert.equal(f.state().voiceCheck, 'completed');
  assert.deepEqual(f.state().attemptEvidence?.bench?.confirmationWindow, {
    kind: 'bpm_high', level: 'warning', threshold: 80, required: 15, slots: 15, accepted: 11, beyond: 9,
  });
  assert.equal(f.state().attemptEvidence?.bench?.acceptedThroughRelaxation, 14);
  assert.equal(f.state().attemptEvidence?.bench?.invalidFirmwareHr, 4);
  assert.deepEqual(f.urls, []);
});

test('bench never counts previous, missing, implausible, or uncorroborated readings', () => {
  const f = fixture();
  assert.equal(f.test.start(false, true), true);
  const read = (override: Partial<Frame>, signalQuality = benchMorphology, age = 0) =>
    f.feed({ heartRate: 80, ...override }, 'rejected', age, 1000, 82, { signalQuality });
  read({});
  const qualifiedAt = f.state().lastQualifiedAt;
  read({ heartRate: -999, usable: false });
  read({ flags: 14 });
  read({ spo2: 101 });
  read({}, { ...benchMorphology, feasible: false });
  read({}, { ...benchMorphology, hrBeats: 86, agree: false });
  read({ quality: 49 });
  read({ version: 2 });
  read({}, benchMorphology, 3000);
  read({ seq: f.sequence() - 1 });
  assert.equal(f.state().lastQualifiedAt, qualifiedAt);
  assert.equal(f.state().attemptEvidence?.bench?.acceptedThroughRelaxation, 1);
  assert.equal(f.state().attemptEvidence?.bench?.invalidFirmwareHr, 2);
  assert.equal(f.state().attemptEvidence?.bench?.beatFeasibilityFailures, 1);
  assert.equal(f.state().attemptEvidence?.bench?.estimatorDisagreements, 1);
  assert.equal(f.state().attemptEvidence?.bench?.otherRejections, 5);
  assert.equal(f.state().confirmed, null);
});

test('bench keeps critical HR and oxygen events on the strict lane', async () => {
  for (const [heartRate, spo2, kind] of [[140, 97, 'bpm_high'], [78, 88, 'spo2_low']] as const) {
    const f = fixture(['yes']);
    assert.equal(f.test.start(false, true), true);
    const signalQuality = { ...benchMorphology, hrBeats: heartRate };
    for (let i = 0; i < 15; i++) f.feed({ heartRate, spo2 }, 'rejected', 0, 1000, undefined, { signalQuality });
    assert.equal(f.state().confirmed, null);
    for (let i = 0; i < 11; i++) f.feed({ heartRate, spo2 }, 'passed', 0, 1000, undefined,
      { signalQuality: { ...benchPassing, hrBeats: heartRate } });
    await flush();
    assert.equal(f.state().confirmed?.kind, kind);
    assert.equal(f.state().confirmed?.level, 'critical');
    assert.equal(f.state().voiceCheck, 'completed');
  }
});

test('bench extends only the no-qualified-reading timeout with live continuous frames', () => {
  for (const benchMode of [false, true]) {
    const f = fixture();
    assert.equal(f.test.start(false, benchMode), true);
    for (let i = 0; i < 29; i++) f.feed({ usable: false }, 'rejected');
    assert.equal(f.state().phase, benchMode ? 'recovering' : 'cancelled');
    if (benchMode) f.feed({ usable: false }, 'rejected');
    assert.equal(f.state().lastCancellation?.source, 'qualified_signal');
  }
  const silent = fixture();
  assert.equal(silent.test.start(false, true), true);
  silent.wait(14_999);
  assert.notEqual(silent.state().phase, 'cancelled');
  silent.wait(1);
  assert.equal(silent.state().lastCancellation?.source, 'transport_silence');
});

test('bench rejects a full warning window below coverage or beyond-boundary requirements', () => {
  for (const [accepted, beyond] of [[10, 10], [11, 8]]) {
    const f = fixture();
    assert.equal(f.test.start(false, true), true);
    const read = (bpm: number) => f.feed({ heartRate: bpm }, 'rejected', 0, 1000, bpm,
      { signalQuality: { ...benchMorphology, hrBeats: bpm } });
    for (let i = 0; i < 3; i++) read(81);
    for (let i = 0; i < beyond; i++) read(81);
    for (let i = beyond; i < accepted; i++) read(79);
    for (let i = accepted; i < 15; i++) f.feed({ usable: false }, 'rejected');
    assert.deepEqual(f.state().attemptEvidence?.bench?.confirmationWindow, {
      kind: 'bpm_high', level: 'warning', threshold: 80, required: 15, slots: 15, accepted, beyond,
    });
    assert.equal(f.state().confirmed, null);
    assert.equal(f.state().voiceCheck, 'idle');
  }
});

test('bench clears confirmation evidence on a continuity gap instead of counting the gap frame', () => {
  const f = fixture();
  assert.equal(f.test.start(false, true), true);
  for (let i = 0; i < 17; i++) f.feed({ heartRate: 80 }, 'rejected', 0, 1000, undefined,
    { signalQuality: benchMorphology });
  assert.equal(f.state().attemptEvidence?.bench?.confirmationWindow?.slots, 14);
  f.feed({ seq: 19, heartRate: 80 }, 'rejected', 0, 2000, undefined,
    { signalQuality: benchMorphology, missingFrames: 1 });
  assert.equal(f.state().continuityResets, 1);
  assert.equal(f.state().lastFrame?.sequence, 'gap');
  assert.equal(f.state().attemptEvidence?.bench?.acceptedThroughRelaxation, 17);
  assert.equal(f.state().detection?.tracks.length, 0);
  assert.equal(f.state().confirmed, null);
});

test('a watchdog tick during qualified bench startup allows production monitoring to wait', async () => {
  const f = fixture(['yes']);
  f.monitoring(false);
  f.duringVoiceSetup(() => f.wait(500));
  assert.equal(f.test.start(false, true), true);
  for (let i = 0; i < 18; i++) f.feed({ heartRate: 80 }, 'rejected', 0, 1000, undefined,
    { signalQuality: benchMorphology, missingInput: true });
  await flush();
  assert.equal(f.state().voiceCheck, 'completed');
  assert.equal(f.state().lastCancellation, null);
});

async function triggerBench(f: ReturnType<typeof fixture>, allowContact = false) {
  assert.equal(f.test.start(allowContact, true), true);
  for (let i = 0; i < 18; i++) f.feed({ heartRate: 80 }, 'passed', 0, 1000, undefined, { signalQuality: benchPassing });
  await flush();
}

test('activation evidence distinguishes collecting, blocked confirmation, expiry and cancellation', async () => {
  const f = fixture();
  assert.equal(f.test.start(true, true), true);
  f.feed({ heartRate: 80 }, 'rejected', 0, 1000, undefined, { signalQuality: benchMorphology });
  assert.equal(f.state().activation?.confirmationMet, false);
  assert.equal(f.state().activation?.stage, 'collecting');
  for (let i = 1; i < 18; i++) f.feed({ heartRate: 80 }, 'rejected', 0, 1000, undefined,
    { signalQuality: benchMorphology });
  const activation = f.state().activation!;
  assert.equal(activation.lane, 'bench');
  assert.equal(activation.confirmationMet, true);
  assert.equal(activation.window?.accepted, 15);
  assert.equal(activation.blocker, 'handoff_quality');
  assert.equal(activation.confirmationAgeMs, 0);
  assert.deepEqual(Object.keys(activation.transitions), ['confirmed']);
  f.block('safety');
  assert.equal(f.state().activation?.stage, 'cancelled');
  assert.equal(f.state().activation?.blocker, 'handoff_quality');
  assert.equal(f.state().activation?.cancellationSource, 'context');
  assert.deepEqual(f.state().activation?.production, { monitoring: 'active', tracking: true, preempting: true });
  assert.equal(f.state().activation?.episodeId, activation.episodeId);
  f.block(null);
  f.test.reset();
  assert.equal(f.state().activation, null);

  const expiry = fixture();
  assert.equal(expiry.test.start(true, true), true);
  for (let i = 0; i < 18; i++) expiry.feed({ heartRate: 80 }, 'rejected', 0, 1000, undefined,
    { signalQuality: benchMorphology });
  const oldId = expiry.state().activation!.episodeId;
  for (let i = 0; i < 3; i++) expiry.feed({ heartRate: 80 }, 'rejected', 0, 1000, undefined,
    { signalQuality: benchMorphology });
  assert.deepEqual(expiry.state().activation?.pendingExpiry, { episodeId: oldId, confirmationAgeMs: 3000 });
  assert.equal(expiry.state().activation?.confirmationMet, false);
  expiry.test.cancel();
  assert.equal(expiry.state().activation?.pendingExpiry?.episodeId, oldId);
  assert.equal(expiry.test.start(false, true), true);
  assert.equal(expiry.state().activation?.pendingExpiry, null);
});

test('bench startup still yields to production preemption before ownership', async () => {
  const f = fixture(['yes']);
  f.monitoring(false);
  f.duringVoiceSetup(() => f.block('safety'));
  await triggerBench(f);
  assert.equal(f.state().activation?.stage, 'cancelled');
  assert.deepEqual(Object.keys(f.state().activation!.transitions), ['confirmed', 'starting', 'cancelled']);
  assert.equal(f.state().activation?.production.preempting, true);
  assert.deepEqual(f.spokenLanguages, []);
});

test('bench opt-in requires current offer acceptance and one separate exact dialer confirmation', async () => {
  const f = fixture();
  await triggerBench(f, true);
  assert.deepEqual(Object.keys(f.state().activation!.transitions), ['confirmed', 'starting', 'active']);
  const wellness = f.scope();
  assert.equal(f.test.answer('not_ok', wellness), true);
  await flush();
  assert.equal(f.scope().question, 'contact_offer');
  assert.equal(f.test.answer('call_yes', wellness), false);
  assert.equal(f.state().confirmation, null);
  assert.equal(f.test.answer('call_yes', f.scope()), true);
  await flush();
  assert.deepEqual(f.state().confirmation, { id: wellness.episodeId, name: 'Saved Contact', phone: '+12025550124' });
  assert.deepEqual(f.urls, []);
  await f.test.confirm('other-episode');
  assert.deepEqual(f.urls, []);
  await Promise.all([f.test.confirm(wellness.episodeId), f.test.confirm(wellness.episodeId)]);
  assert.deepEqual(f.urls, ['tel:+12025550124']);
});

test('bench default opt-out, refusal, silence and direct request do not issue permits', async () => {
  for (const [allow, answers] of [[false, ['no', 'yes']], [true, ['no', 'no']], [true, ['no', null, null]],
    [true, ['call my emergency contact']]] as const) {
    const f = fixture([...answers]);
    await triggerBench(f, allow);
    assert.equal(f.state().voiceCheck, 'completed');
    assert.equal(f.state().confirmation, null);
    assert.deepEqual(f.urls, []);
  }
});

test('bench handoff still rejects a changed contact and signal loss before or after consent', async () => {
  const changed = fixture(['no', 'yes']);
  await triggerBench(changed, true);
  const changedId = changed.state().confirmation!.id;
  changed.changeSaved({ emergency_phone: '+12025550125' });
  await changed.test.confirm(changedId);
  assert.deepEqual(changed.urls, []);

  const before = fixture(['no', 'yes'], true);
  await triggerBench(before, true);
  const beforeId = before.scope().episodeId;
  before.feed({}, 'rejected');
  before.feed();
  before.finishSpeech();
  await flush();
  assert.equal(before.state().safety?.last?.result.contactCall, 'accepted_offer');
  assert.equal(before.state().confirmation, null);
  await before.test.confirm(beforeId);
  assert.deepEqual(before.urls, []);

  const after = fixture(['no', 'yes']);
  await triggerBench(after, true);
  const afterId = after.state().confirmation!.id;
  const approval = after.test.confirm(afterId);
  after.feed({}, 'rejected');
  after.feed();
  await approval;
  await after.test.confirm(afterId);
  assert.equal(after.state().phase, 'cancelled');
  assert.deepEqual(after.urls, []);
});

test('bench startup rejects stale telemetry and records audio setup failures', async () => {
  const stale = fixture(['yes']);
  stale.monitoring(false);
  stale.duringVoiceSetup(() => stale.wait(3000));
  await triggerBench(stale);
  assert.equal(stale.state().lastCancellation?.source, 'qualified_signal');
  assert.equal(stale.state().activation?.confirmationAgeMs, 3000);
  assert.deepEqual(stale.spokenLanguages, []);

  const failed = fixture();
  failed.breakVoiceSetup();
  await triggerBench(failed);
  assert.equal(failed.state().activation?.stage, 'setup_failed');
  assert.equal(failed.state().activation?.blocker, 'voicecheck');
  assert.deepEqual(Object.keys(failed.state().activation!.transitions), ['confirmed', 'starting', 'setup_failed']);
});

function feedBenchBpm(f: ReturnType<typeof fixture>, bpm = 80) {
  f.feed({ heartRate: bpm }, 'rejected', 0, 1000, undefined,
    { signalQuality: { ...benchMorphology, hrBeats: bpm }, missingInput: true });
}

test('Fast Demo confirms on five slots with four accepted high readings while production waits', async () => {
  const f = fixture(['yes']);
  f.monitoring(false);
  assert.equal(f.test.start(false, true, true), true);
  assert.equal(f.state().fastDemo, true);
  for (let i = 0; i < 3; i++) feedBenchBpm(f);
  assert.equal(f.state().attemptEvidence?.bench?.lastTrackEvent?.event, 'opened');
  f.feed({ finger: false, usable: false }, 'warming');
  for (let i = 0; i < 3; i++) feedBenchBpm(f);
  assert.equal(f.state().activation?.confirmationMet, false);
  feedBenchBpm(f);
  await flush();
  assert.equal(f.state().voiceCheck, 'completed');
  assert.equal(f.state().activation?.production.monitoring, 'waiting');
  const bench = f.state().attemptEvidence!.bench!;
  assert.equal(bench.minimumAccepted, 4);
  assert.deepEqual(bench.confirmationWindow, {
    kind: 'bpm_high', level: 'warning', threshold: 80, required: 5, slots: 5, accepted: 4, beyond: 4,
  });
  assert.deepEqual(bench.slotEvidence.map(slot => [slot.result, slot.reason]),
    [['null_hr', 'contact'], ...Array.from({ length: 4 }, () => ['at_or_above_threshold', null])]);
  assert.equal(bench.lastTrackEvent?.event, 'confirmed');
  assert.deepEqual(f.urls, []);
});

test('Fast Demo records actual Hampel, below-boundary and null slots without confirming', () => {
  const f = fixture();
  assert.equal(f.test.start(false, true, true), true);
  for (let i = 0; i < 4; i++) feedBenchBpm(f);
  feedBenchBpm(f, 100);
  feedBenchBpm(f, 79);
  feedBenchBpm(f);
  f.feed({ usable: false }, 'rejected');
  const bench = f.state().attemptEvidence!.bench!;
  assert.equal(bench.confirmationWindow?.slots, 5);
  assert.equal(bench.confirmationWindow?.accepted, 3);
  assert.equal(bench.confirmationWindow?.beyond, 2);
  assert.deepEqual(bench.slotEvidence.map(slot => [slot.suppliedBpm, slot.acceptedBpm, slot.result, slot.reason]), [
    [80, 80, 'at_or_above_threshold', null],
    [100, null, 'hampel', null],
    [79, 79, 'below_threshold', null],
    [80, 80, 'at_or_above_threshold', null],
    [null, null, 'null_hr', 'vitals'],
  ]);
  assert.equal(f.state().voiceCheck, 'idle');
});

test('Fast Demo refuses a full window with four accepted readings but only three beyond the boundary', () => {
  const f = fixture();
  assert.equal(f.test.start(false, true, true), true);
  for (let i = 0; i < 6; i++) feedBenchBpm(f);
  feedBenchBpm(f, 79);
  f.feed({ finger: false }, 'warming');
  assert.equal(f.state().attemptEvidence?.bench?.confirmationWindow?.accepted, 4);
  assert.equal(f.state().attemptEvidence?.bench?.confirmationWindow?.beyond, 3);
  assert.equal(f.state().activation?.confirmationMet, false);
});

test('ordinary Bench Mode can retain cumulative qualifications while its latest window contains only null HR', () => {
  const f = fixture();
  assert.equal(f.test.start(false, true), true);
  for (let i = 0; i < 5; i++) feedBenchBpm(f);
  for (let i = 0; i < 15; i++) f.feed({ finger: false }, 'warming');
  const bench = f.state().attemptEvidence!.bench!;
  assert.equal(bench.acceptedThroughRelaxation, 5);
  assert.equal(bench.confirmationWindow?.slots, 15);
  assert.equal(bench.confirmationWindow?.accepted, 0);
  assert.equal(bench.slotEvidence.length, 15);
  assert.ok(bench.slotEvidence.every(slot => slot.result === 'null_hr' && slot.reason === 'contact'));
  assert.equal(f.state().activation?.confirmationMet, false);
});

test('Fast Demo records resets, opens a new window, and still yields to production', () => {
  const f = fixture();
  assert.equal(f.test.start(false, true, true), true);
  for (let i = 0; i < 5; i++) feedBenchBpm(f);
  const oldTrack = f.state().attemptEvidence?.bench?.trackId;
  f.feed({ seq: 7, heartRate: 80 }, 'rejected', 0, 2000, undefined, { missingFrames: 1, signalQuality: benchMorphology });
  assert.equal(f.state().attemptEvidence?.bench?.lastReset?.reason, 'sequence_gap');
  f.feed({ seq: 8, heartRate: 80 }, 'rejected', 0, 1000, undefined, { signalQuality: benchMorphology });
  f.feed({ seq: 9, heartRate: 80 }, 'rejected', 0, 1000, undefined, { signalQuality: benchMorphology });
  f.feed({ seq: 10, heartRate: 80 }, 'rejected', 0, 1000, undefined, { signalQuality: benchMorphology });
  assert.notEqual(f.state().attemptEvidence?.bench?.trackId, oldTrack);
  assert.deepEqual(f.state().attemptEvidence?.bench?.slotEvidence, []);
  f.block('safety');
  assert.equal(f.state().activation?.production.preempting, true);
  assert.equal(f.state().lastCancellation?.contextBlock, 'safety');
  assert.deepEqual(f.spokenLanguages, []);
});

test('requesting Fast Demo without Bench Mode keeps strict confirmation', () => {
  const f = fixture();
  assert.equal(f.test.start(false, false, true), true);
  assert.equal(f.state().fastDemo, false);
  for (let i = 0; i < 8; i++) f.feed({ heartRate: 80 });
  assert.equal(f.state().attemptEvidence?.bench, undefined);
  assert.equal(f.state().activation?.window?.required, 15);
  assert.equal(f.state().activation?.confirmationMet, false);
});

test('Fast Demo retains the passing-waveform activation gate and two-step contact consent', async () => {
  const f = fixture(['no', 'yes']);
  assert.equal(f.test.start(true, true, true), true);
  for (let i = 0; i < 8; i++) feedBenchBpm(f);
  assert.equal(f.state().activation?.confirmationMet, true);
  assert.equal(f.state().activation?.blocker, 'handoff_quality');
  assert.equal(f.state().voiceCheck, 'idle');
  assert.equal(f.state().confirmation, null);
  f.feed({ heartRate: 80 }, 'passed', 0, 1000, undefined, { signalQuality: benchPassing });
  await flush();
  const pending = f.state().confirmation;
  assert.equal(pending?.phone, '+12025550124');
  assert.deepEqual(f.urls, []);
  await f.test.confirm(pending!.id);
  assert.deepEqual(f.urls, ['tel:+12025550124']);
});

test('voice offer records consent, published and visible confirmation, and separately requested dialer', async () => {
  const f = fixture(['no', 'yes please']);
  await triggerBench(f, true);
  const pending = f.state().confirmation!;
  const published = f.state().handoffEvidence!;
  assert.equal(published.optIn, true);
  assert.equal(published.savedContactAvailable, true);
  assert.match(published.offerCaptureId!, /^core-\d+-2$/);
  assert.equal(published.decision?.result, 'accepted_offer');
  assert.equal(published.decision?.channel, 'voice');
  assert.equal(published.permit?.result, 'created');
  assert.equal(published.confirmationVisibleAt, null);
  assert.deepEqual(f.urls, []);
  f.test.markConfirmationVisible(pending.id);
  await f.test.confirm(pending.id);
  const evidence = f.state().handoffEvidence!;
  const order = evidence.order;
  assert.ok(order.decision! < order.permit! && order.permit! < order.confirmation_published!);
  assert.ok(order.confirmation_published! < order.confirmation_visible! && order.confirmation_visible! < order.dialer_tapped!);
  assert.equal(evidence.nativeResult?.result, 'requested');
  assert.equal(evidence.invalidation?.reason, 'consumed');
  assert.deepEqual(f.urls, ['tel:+12025550124']);
  assert.doesNotMatch(JSON.stringify(evidence), /Saved Contact|2025550124|yes please/);
});

test('button offer records stale, duplicate and already-answered responses without confusing consent', async () => {
  const f = fixture();
  await triggerBench(f, true);
  const wellness = f.scope();
  assert.equal(f.test.answer('not_ok', wellness), true);
  await flush();
  const offer = f.scope();
  assert.equal(f.test.answer('call_yes', { ...offer, captureId: wellness.captureId }), false);
  assert.equal(f.state().handoffEvidence?.rejectedResponse?.reason, 'stale');
  assert.equal(f.test.answer('ok', offer), false);
  assert.equal(f.state().handoffEvidence?.rejectedResponse?.reason, 'invalid');
  assert.equal(f.test.answer('call_yes', offer), true);
  assert.equal(f.test.answer('call_yes', offer), false);
  assert.equal(f.state().handoffEvidence?.rejectedResponse?.reason, 'duplicate');
  await flush();
  assert.equal(f.state().handoffEvidence?.decision?.channel, 'button');
  assert.equal(f.state().handoffEvidence?.decision?.result, 'accepted_offer');
  assert.equal(f.test.answer('call_yes', offer), false);
  assert.equal(f.state().handoffEvidence?.rejectedResponse?.reason, 'already_answered');
  assert.deepEqual(f.urls, []);
});

test('handoff evidence distinguishes opt-out, declined and unanswered offers', async () => {
  for (const [allow, answers, decision] of [
    [false, ['no', 'yes'], 'accepted_offer'],
    [true, ['no', 'no'], 'declined_offer'],
    [true, ['no', null, null], 'unconfirmed_offer'],
  ] as const) {
    const f = fixture([...answers]);
    await triggerBench(f, allow);
    assert.equal(f.state().handoffEvidence?.decision?.result, decision);
    assert.equal(f.state().handoffEvidence?.permit?.reason ?? null, allow ? null : 'not_enabled');
    assert.equal(f.state().handoffEvidence?.confirmationPublishedAt, null);
    assert.deepEqual(f.urls, []);
  }
});

test('handoff evidence retains the order of revocation before consent and invalidation after consent', async () => {
  const before = fixture(['no', 'yes'], true);
  await triggerBench(before, true);
  before.feed({}, 'rejected');
  before.feed();
  before.finishSpeech();
  await flush();
  const blocked = before.state().handoffEvidence!;
  assert.equal(blocked.permit?.reason, 'signal_lost');
  assert.equal(blocked.firstRevocation?.reason, 'waveform');
  assert.ok(blocked.order.revoked! < blocked.order.decision!);
  assert.equal(blocked.confirmationPublishedAt, null);

  const after = fixture(['no', 'yes']);
  await triggerBench(after, true);
  after.feed({}, 'rejected');
  const invalidated = after.state().handoffEvidence!;
  assert.equal(invalidated.permit?.result, 'created');
  assert.equal(invalidated.invalidation?.reason, 'waveform');
  assert.equal(invalidated.confirmationVisibleAt, null);
  assert.ok(invalidated.order.decision! < invalidated.order.invalidated!);
  after.test.reset();
  assert.equal(after.state().handoffEvidence, null);
});

test('hardware evidence distinguishes permit expiration from native dialer failure', async () => {
  const expired = fixture(['no', 'yes']);
  await triggerBench(expired, true);
  for (let i = 0; i < 30; i++) expired.feed();
  assert.equal(expired.state().handoffEvidence?.invalidation?.reason, 'timeout');
  assert.equal(expired.state().handoffEvidence?.nativeResult, null);

  const failed = fixture(['no', 'yes']);
  failed.failNativeDialer();
  await triggerBench(failed, true);
  const id = failed.state().confirmation!.id;
  failed.test.markConfirmationVisible(id);
  await failed.test.confirm(id);
  assert.equal(failed.state().handoffEvidence?.nativeResult?.result, 'native_open_failed');
  assert.equal(failed.state().result, 'failed');
});

test('capture evidence retains an initial partial and the later accepted final with PCM milestones', async () => {
  const f = fixture();
  let listened = 0;
  f.scriptRecognition((id, observe) => {
    const final = ++listened === 2;
    observe?.({ cueCompletedMs: 200, pcmGateOpenedMs: 201, firstForwardedPcmMs: 210,
      partial: !final, final, failure: null });
    return recognitionEvidence(id, { status: 'success', transcript: final ? 'yes' : 'private partial',
      finalTranscript: final ? 'yes' : '', isFinal: final, finalResultReceived: final });
  });
  await triggerBench(f);
  const [initial, retry] = Object.values(f.state().captureEvidence!);
  assert.equal(initial?.prompt?.status, 'completed');
  assert.equal(initial?.native?.partial, true);
  assert.equal(initial?.native?.firstForwardedPcmMs, 210);
  assert.equal(initial?.recognition?.status, 'rejected');
  assert.equal(retry?.native?.final, true);
  assert.equal(retry?.recognition?.status, 'accepted');
  assert.equal(retry?.answer?.channel, 'voice');
  assert.doesNotMatch(JSON.stringify(f.state().captureEvidence), /private partial|"yes"/);
});

test('capture evidence distinguishes a missing result, timeout, cancelled check and failed playback', async () => {
  const missing = fixture([null, 'yes']);
  await triggerBench(missing);
  assert.equal(Object.values(missing.state().captureEvidence!)[0]?.recognition?.status, 'missing');

  const timed = fixture();
  let listened = 0;
  timed.scriptRecognition(id => ++listened === 1
    ? recognitionEvidence(id, { status: 'timeout', transcript: '', isFinal: false })
    : recognitionEvidence(id, { status: 'success', transcript: 'yes', finalTranscript: 'yes', isFinal: true, finalResultReceived: true }));
  await triggerBench(timed);
  assert.equal(Object.values(timed.state().captureEvidence!)[0]?.recognition?.status, 'timeout');

  const cancelled = fixture([], true);
  await triggerBench(cancelled);
  const capture = cancelled.scope().captureId;
  cancelled.test.cancel();
  await flush();
  assert.equal(typeof cancelled.state().captureEvidence?.[capture]?.cancelledAt, 'number');

  const failed = fixture();
  failed.breakPromptPlayback();
  await triggerBench(failed);
  const scope = failed.scope();
  assert.equal(failed.state().captureEvidence?.[scope.captureId]?.prompt?.status, 'failed');
  assert.equal(failed.test.answer('ok', scope), true);
  await flush();
  assert.equal(failed.state().captureEvidence?.[scope.captureId]?.answer?.channel, 'button');
});

test('capture evidence identifies audio ownership failure and rejects a cancelled or stale native result', async () => {
  for (const status of ['cancelled', 'stale'] as const) {
    const f = fixture();
    let listened = 0;
    f.scriptRecognition((id, observe) => {
      if (++listened !== 1) return recognitionEvidence(id, { status: 'success', transcript: 'yes', finalTranscript: 'yes',
        isFinal: true, finalResultReceived: true });
      observe?.({ cueCompletedMs: null, pcmGateOpenedMs: null, firstForwardedPcmMs: null, partial: false,
        final: false, failure: 'audio_ownership' });
      return recognitionEvidence(id, { status, transcript: '', isFinal: false });
    });
    await triggerBench(f);
    const [initial, retry] = Object.values(f.state().captureEvidence!);
    assert.equal(initial?.native?.failure, 'audio_ownership');
    assert.equal(initial?.recognition?.status, status);
    assert.equal(retry?.recognition?.status, 'accepted');
  }
});

async function blockedContactRecovery() {
  const f = fixture(['no', 'yes'], true);
  await triggerBench(f, true);
  const episodeId = f.scope().episodeId;
  f.feed({ finger: false, usable: false }, 'warming');
  f.finishSpeech();
  await flush();
  assert.equal(f.state().handoffEvidence?.firstRevocation?.reason, 'contact');
  assert.equal(f.state().handoffEvidence?.permit?.reason, 'signal_lost');
  return { f, episodeId };
}

test('strict recovery needs three fresh frames and fresh consent before a new one-use dialer permit', async () => {
  const { f, episodeId } = await blockedContactRecovery();
  f.feed();
  f.feed({}, 'rejected');
  f.feed({}, 'warming');
  assert.equal(f.state().recoveryReady, false);
  assert.equal(f.state().handoffEvidence?.recovery?.lastRejection, 'handoff_quality');
  await f.test.requestRecoveredHandoff(episodeId);
  assert.equal(f.state().confirmation, null);

  f.feed();
  f.feed();
  assert.equal(f.state().recoveryReady, false);
  f.feed();
  assert.equal(f.state().recoveryReady, true);
  assert.equal(f.state().handoffEvidence?.recovery?.consecutive, 3);
  assert.equal(f.state().confirmation, null);
  assert.deepEqual(f.urls, []);
  await f.test.requestRecoveredHandoff('wrong-episode');
  assert.equal(f.state().handoffEvidence?.recovery?.requestedAt, null);
  await Promise.all([f.test.requestRecoveredHandoff(episodeId), f.test.requestRecoveredHandoff(episodeId)]);
  const confirmation = f.state().confirmation!;
  assert.equal(confirmation.name, 'Saved Contact');
  assert.equal(confirmation.phone, '+12025550124');
  assert.notEqual(confirmation.id, episodeId);
  assert.equal(f.state().handoffEvidence?.permit?.reason, 'signal_lost');
  assert.equal(f.state().handoffEvidence?.recovery?.permit?.result, 'created');
  assert.deepEqual(f.urls, []);
  await f.test.confirm(episodeId);
  assert.deepEqual(f.urls, []);
  await Promise.all([f.test.confirm(confirmation.id), f.test.confirm(confirmation.id)]);
  assert.deepEqual(f.urls, ['tel:+12025550124']);
  assert.equal(f.state().handoffEvidence?.nativeResult?.result, 'requested');
});

test('recovered authorization fails closed when the saved contact changes or quality is lost again', async () => {
  const changed = await blockedContactRecovery();
  for (let i = 0; i < 3; i++) changed.f.feed();
  changed.f.changeSaved({ emergency_phone: '+12025550125' });
  await changed.f.test.requestRecoveredHandoff(changed.episodeId);
  assert.equal(changed.f.state().handoffEvidence?.recovery?.permit?.reason, 'contact_unavailable');
  assert.equal(changed.f.state().confirmation, null);
  assert.deepEqual(changed.f.urls, []);

  const lost = await blockedContactRecovery();
  for (let i = 0; i < 3; i++) lost.f.feed();
  await lost.f.test.requestRecoveredHandoff(lost.episodeId);
  const confirmation = lost.f.state().confirmation!;
  const opening = lost.f.test.confirm(confirmation.id);
  lost.f.feed({ finger: false, usable: false }, 'warming');
  await opening;
  assert.equal(lost.f.state().handoffEvidence?.invalidation?.reason, 'contact');
  await lost.f.test.confirm(confirmation.id);
  assert.deepEqual(lost.f.urls, []);
});

test('a new strict streak cannot revive an authorization request made before an intervening signal loss', async () => {
  const { f, episodeId } = await blockedContactRecovery();
  for (let i = 0; i < 3; i++) f.feed();
  let release!: () => void;
  f.holdSavedReadUntil(new Promise<void>(resolve => { release = resolve; }));
  const requesting = f.test.requestRecoveredHandoff(episodeId);
  f.feed({ finger: false, usable: false }, 'warming');
  for (let i = 0; i < 3; i++) f.feed();
  release();
  await requesting;
  assert.equal(f.state().handoffEvidence?.recovery?.permit?.reason, 'signal_lost');
  assert.equal(f.state().confirmation, null);
  assert.deepEqual(f.urls, []);
});

test('strict recovery remains blocked by production waiting and every hard context boundary', async () => {
  const waiting = await blockedContactRecovery();
  waiting.f.monitoring(false);
  for (let i = 0; i < 3; i++) waiting.f.feed();
  assert.equal(waiting.f.state().recoveryReady, false);
  assert.equal(waiting.f.state().handoffEvidence?.recovery?.lastRejection, 'monitoring_inactive');
  for (const breakRun of [
    (f: ReturnType<typeof fixture>) => f.disconnect(),
    (f: ReturnType<typeof fixture>) => f.feed({ seq: f.sequence() + 2 }),
    (f: ReturnType<typeof fixture>) => f.wait(180_000),
    (f: ReturnType<typeof fixture>) => f.wait(3000),
    (f: ReturnType<typeof fixture>) => f.block('safety'),
    (f: ReturnType<typeof fixture>) => f.test.cancel(),
  ]) {
    const { f, episodeId } = await blockedContactRecovery();
    for (let i = 0; i < 3; i++) f.feed();
    assert.equal(f.state().recoveryReady, true);
    breakRun(f);
    assert.equal(f.state().phase, 'cancelled');
    await f.test.requestRecoveredHandoff(episodeId);
    assert.equal(f.state().confirmation, null);
    assert.deepEqual(f.urls, []);
  }
});

test('English and Spanish capture evidence distinguishes Ready and Listening and retains finalization failure', async () => {
  for (const [language, yes] of [['en', 'yes'], ['es', 'sí']] as const) {
    const f = fixture();
    f.select({ language });
    let listened = 0;
    f.scriptRecognition((id, observe, phase) => {
      const episodeId = f.scope().episodeId;
      phase?.('ready');
      f.test.markListeningVisible(episodeId, id);
      assert.equal(f.state().captureEvidence?.[id]?.uiListeningAt, undefined);
      phase?.('listening');
      f.test.markListeningVisible(episodeId, id);
      const final = ++listened === 2;
      observe?.({ cueCompletedMs: 300, pcmGateOpenedMs: 301, firstForwardedPcmMs: 311,
        partial: true, final, failure: null, finalizationStartedMs: 2000,
        terminalReason: final ? 'other' : 'empty_final_after_partial' });
      return recognitionEvidence(id, { status: 'success', transcript: yes, finalTranscript: final ? yes : '',
        isFinal: final, finalResultReceived: final });
    });
    await triggerBench(f);
    const [first, retry] = Object.values(f.state().captureEvidence!);
    assert.equal(first?.recognition?.status, 'rejected');
    assert.equal(first?.native?.terminalReason, 'empty_final_after_partial');
    assert.ok(typeof first?.uiListeningAt === 'number');
    assert.equal(retry?.recognition?.status, 'accepted');
    assert.equal(f.state().voiceCheck, 'completed');
  }
});

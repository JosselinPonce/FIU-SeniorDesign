import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SafetyController, initialSafety, type SafetyState } from '../lib/analysis/safetyController.ts';
import { SensorContinuity, monitoringMessage } from '../lib/analysis/sensorContinuity.ts';
import { recognitionEvidence } from '../lib/voice/coreRecognition.ts';
import type { Frame } from '../lib/ble/protocol.ts';

const profile = { id: 'driver', custom_id: null, display_name: 'Driver', age: 30, gender: 'male' as const,
  height_cm: 180, weight_kg: 80, created_at: '', updated_at: '', emergency_name: 'Mom', emergency_phone: '+13055550123' };
const tick = async () => { for (let n = 0; n < 15; n++) await new Promise<void>(r => setImmediate(r)); };
function frame(seq: number, heartRate = 155): Frame {
  return { version: 3, seq, rateHz: 0, quality: 90, startMs: seq * 1000, endMs: (seq + 1) * 1000,
    heartRate, spo2: 98, flags: 15, samples: [], finger: true, usable: true, raw: new Uint8Array() };
}
function fixture() {
  let state: SafetyState = initialSafety, n = 0, inference = 0, inferenceCancelled = 0;
  let final: ((text: string) => void) | null = null;
  let partial: ((text: string) => void) | null = null;
  const saved: any[] = [], calls: string[] = [], speech: string[] = [];
  const c = new SafetyController({ assistantMode: () => 'local',
    startAcknowledgment: () => { inference++; return { get: () => 'I hear you.', source: 'gemma', cancel() { inferenceCancelled++; } }; },
    voiceIO: () => ({ speak: async text => { speech.push(text); }, listen: async (_l, _m, _h, id) => new Promise(resolve => {
      final = text => resolve(recognitionEvidence(id, { status: 'success', transcript: text, finalTranscript: text, isFinal: true, finalResultReceived: true }));
      partial = text => resolve(recognitionEvidence(id, { status: 'timeout', transcript: text, isFinal: false, finalResultReceived: false }));
    }), cancel() {} }),
    save: async row => { saved.push(row); }, saveAck: async () => {}, haptic() {},
    handoffContact: async phone => { calls.push(phone); }, onChange: s => { state = s; }, newId: () => `incident-${++n}`,
  });
  c.configure(profile, null);
  c.setMonitoringContext(true, true, true);
  return { c, saved, calls, speech, get state() { return state; }, get inference() { return inference; }, get inferenceCancelled() { return inferenceCancelled; },
    feed: (seq: number, at = 100000 + seq * 1000, bpm = 155, missing = 0) => c.onFrame(frame(seq, bpm), new Date(at), missing),
    final: (text: string) => { assert.ok(final); final(text); },
    partial: (text: string) => { assert.ok(partial); partial(text); },
    scope: () => ({ episodeId: state.check!.episode.id, question: state.check!.question, captureId: state.check!.captureId }),
    trigger: () => { for (let i = 0; i < 30 && !state.check; i++) c.onFrame(frame(i), new Date(100000 + i * 1000), 0); assert.ok(state.check); },
  };
}

test('foreground valid sensors activate VoiceCheck without recording, inference is presentation-only', async () => {
  const f = fixture();
  assert.equal(f.state.monitoring, 'waiting'); f.trigger(); await tick();
  assert.equal(f.state.monitoring, 'active'); assert.equal(f.state.conversation?.finished, false);
  assert.ok(f.speech[0]?.includes('okay')); assert.equal(f.inference, 1);
  assert.deepEqual(f.saved, []);
  f.c.answerText("I'm dizzy", f.scope()); await tick();
  assert.match(f.speech.join(' '), /I hear you\..*pull over/);
  assert.equal(f.state.check?.question, 'contact_offer'); assert.deepEqual(f.calls, []);
  f.final('yes'); await tick();
  assert.deepEqual(f.calls, ['+13055550123']); assert.equal(f.state.last?.handoff, 'opened');
  assert.deepEqual(f.saved, []); assert.ok(f.inferenceCancelled > 0);
});

test('recording owns persistence, Start/End Drive do not replace monitoring or episode ownership', async () => {
  const f = fixture(); f.c.setRecordingSession('trip'); f.trigger(); await tick();
  const scope = f.scope(); f.c.setRecordingSession(null);
  assert.deepEqual(f.scope(), scope);
  f.c.answerText("I'm dizzy", scope); await tick(); f.final('yes'); await tick();
  assert.deepEqual(f.calls, ['+13055550123']);
  assert.ok(f.saved.some(row => row.response === 'not_ok' && row.session_id === 'trip'));
  assert.equal(f.state.monitoring, 'active');
  // A different vital kind can trigger after recording has ended.
  for (let i = 30; i < 70 && !f.state.check; i++) f.c.onFrame({ ...frame(i, 74), spo2: 87 }, new Date(100000 + i * 1000), 0);
  assert.ok(f.state.check); const before = f.saved.length;
  f.c.answer('ok', f.scope()); await tick(); assert.equal(f.saved.length, before);
});

test('starting recording during a check neither transfers ownership nor retroactively stores an unrecorded event', async () => {
  const f = fixture(); f.trigger(); await tick(); const scope = f.scope();
  f.c.setRecordingSession('later-trip'); assert.deepEqual(f.scope(), scope);
  f.c.answerText("I'm dizzy", scope); await tick(); f.final('yes'); await tick();
  assert.deepEqual(f.calls, ['+13055550123']); assert.deepEqual(f.saved, []);
});

for (const transition of ['background', 'disconnect', 'unsupported', 'stale', 'profile'] as const) {
  test(`${transition} revokes contact consent and stale callbacks; restoration requires a new episode`, async () => {
    const f = fixture(); f.trigger(); await tick();
    f.c.answerText("I'm dizzy", f.scope()); await tick(); const old = f.scope();
    const lateFinal = f.final;
    if (transition === 'background') f.c.setMonitoringContext(true, false, true);
    if (transition === 'disconnect') f.c.setMonitoringContext(false, true, true);
    if (transition === 'unsupported') f.c.setMonitoringContext(true, true, false);
    if (transition === 'stale') f.c.checkSensorFreshness(150000);
    if (transition === 'profile') f.c.configure({ ...profile, id: 'other' }, null);
    assert.equal(f.c.answerText('yes', old), false);
    lateFinal('yes'); await tick();
    assert.deepEqual(f.calls, []); assert.equal(f.state.check, null);
    assert.notEqual(f.state.last?.result.outcome, 'no_response');
    f.c.setMonitoringContext(true, true, true); await tick();
    assert.equal(f.state.check, null);
    for (let i = 50; i < 80 && !f.state.check; i++) f.feed(i);
    assert.ok(f.state.check); assert.notEqual(f.scope().episodeId, old.episodeId);
    f.c.cancelCheck(); await tick();
  });
}

test('duplicates, backwards frames and receiver/device gaps cannot fill a confirmation window', () => {
  for (const gap of ['duplicate', 'reverse', 'missing', 'arrival', 'device', 'burst'] as const) {
    const f = fixture();
    for (let i = 0; i < 7; i++) f.feed(i);
    assert.equal(f.state.check, null);
    if (gap === 'duplicate') {
      for (let i = 0; i < 30; i++) f.feed(6, 107000 + i * 1000);
      assert.equal(f.state.check, null); f.c.checkSensorFreshness(150000);
    } else if (gap === 'reverse') f.feed(4, 107000);
    else if (gap === 'missing') f.feed(10, 107000, 155, 3);
    else if (gap === 'arrival') f.feed(7, 120000);
    else if (gap === 'device') f.c.onFrame({ ...frame(7), endMs: 7000 }, new Date(107000), 0);
    else for (let i = 7; i < 30; i++) f.feed(i, 106100);
    assert.equal(f.state.check, null); assert.equal(f.state.monitoring, 'waiting');
  }
});

test('reconnection discards earlier confirmation evidence; normal and invalid data never trigger', async () => {
  const f = fixture();
  for (let i = 0; i < 7; i++) f.feed(i);
  f.c.setMonitoringContext(false, true, true); f.c.setMonitoringContext(true, true, true);
  for (let i = 10; i < 17; i++) f.feed(i);
  assert.equal(f.state.check, null);
  for (let i = 17; i < 30 && !f.state.check; i++) f.feed(i);
  assert.ok(f.state.check); f.c.cancelCheck(); await tick();
  const g = fixture();
  for (let i = 0; i < 40; i++) g.feed(i, 100000 + i * 1000, 74);
  assert.equal(g.state.check, null);
  for (let i = 40; i < 70; i++) g.c.onFrame({ ...frame(i), quality: 10 }, new Date(100000 + i * 1000), 0);
  assert.equal(g.state.check, null); g.c.checkSensorFreshness(169500);
  assert.equal(g.state.monitoring, 'waiting');
});

test('no-recording refusal and unconfirmed contact speech never hand off', async () => {
  for (const answer of ['no thanks', 'maybe', 'do not call']) {
    const f = fixture(); f.trigger(); await tick(); f.c.answer('not_ok', f.scope()); await tick();
    f.final(answer); await tick();
    assert.deepEqual(f.calls, []); f.c.cancelCheck(); await tick();
  }
});

test('no-recording partial yes cannot authorize contact; final scoped typed consent can', async () => {
  const f = fixture(); f.trigger(); await tick();
  f.c.answer('not_ok', f.scope()); await tick(); const old = f.scope();
  f.partial('yes'); await tick();
  assert.deepEqual(f.calls, []); assert.notEqual(f.scope().captureId, old.captureId);
  assert.equal(f.c.answerText('yes', old), false);
  assert.equal(f.c.answerText('yes please', f.scope()), true);
  assert.equal(f.c.answer('call_yes', f.scope()), false);
  await tick(); assert.deepEqual(f.calls, ['+13055550123']); assert.deepEqual(f.saved, []);
});

test('continuity handles sequence/device-clock wrap and presents every monitoring status', () => {
  const gate = new SensorContinuity();
  assert.equal(gate.accept({ ...frame(0xffffffff), endMs: 0xffffff00 }, 1000, 0).accepted, true);
  assert.equal(gate.accept({ ...frame(0), endMs: 744 }, 2000, 0).accepted, true);
  for (const status of ['active', 'waiting', 'disconnected', 'unavailable'] as const) assert.ok(monitoringMessage(status).length > 15);
});

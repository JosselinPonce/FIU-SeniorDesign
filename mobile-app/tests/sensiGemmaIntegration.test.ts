import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startSafetyAcknowledgment, approvedAcknowledgment, CONCERN_ACK_PROMPT } from '../lib/assistant/safetyAcknowledgment.ts';
import { VoiceCheck, type AnswerScope, type VoiceIO } from '../lib/voice/voiceCheck.ts';
import { recognitionEvidence } from '../lib/voice/coreRecognition.ts';
import { SafetyController, type SafetyState } from '../lib/analysis/safetyController.ts';
import { GemmaPoc } from '../modules/gemma-poc/controller.ts';
const tick = () => new Promise<void>(r => setImmediate(r));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
test('Gemma selection is a fixed non-sensitive task and never an arbitrary driver prompt', async () => {
  const prompts: string[] = [];
  const poc = new GemmaPoc({ verify: async () => true, provision: async () => {}, initialize: async () => ({
    generate: async prompt => { prompts.push(prompt); return 'I hear you.'; }, stop: async () => {}, release: async () => {},
  }) });
  await poc.load(); assert.equal(await poc.selectSafetyAcknowledgment(), 'I hear you.'); await poc.dispose();
  assert.deepEqual(prompts, [CONCERN_ACK_PROMPT]); assert.doesNotMatch(prompts[0]!, /bpm|spo2|mom|phone|dizzy/i);
});
test('ready approved acknowledgment is used; unexpected medical/contact prose is rejected', async () => {
  for (const [output, expected] of [['I hear you.', 'I hear you.'], ['You are safe to drive. Call mom.', "I'm sorry to hear that."], ['I hear you. Are you parked?', "I'm sorry to hear that."]]) {
    const ack = startSafetyAcknowledgment(async () => output!); await tick();
    assert.equal(ack.get('en'), expected); ack.cancel();
  }
  assert.equal(approvedAcknowledgment('I hear you.', 'es'), 'Lamento que te sientas así.');
});
test('pending or timed-out Gemma never delays guidance and cannot publish late speech', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const late = deferred<string>(); const ack = startSafetyAcknowledgment(() => late.promise, 10);
  const spoken: string[] = []; let listens = 0;
  const check = new VoiceCheck({ speak: async text => { spoken.push(text); }, cancel() {},
    listen: async (_l, _ms, _h, id) => recognitionEvidence(id, { status: 'success', transcript: ++listens === 1 ? "I'm dizzy" : 'no thanks',
      finalTranscript: listens === 1 ? "I'm dizzy" : 'no thanks', isFinal: true, finalResultReceived: true }),
  }, 'en', '', { acknowledgment: () => ack.get('en'), contactAvailable: true, contactName: 'Mom' });
  const result = await check.run('bpm_high');
  assert.equal(result.outcome, 'not_ok'); assert.equal(result.contactCall, 'declined_offer');
  assert.match(spoken[1]!, /^I'm sorry to hear that\. Please pull over/);
  assert.equal(spoken[2], 'Would you like me to call Mom?');
  late.resolve('I hear you.'); await tick(); assert.equal(spoken.length, 3);
  const expired = startSafetyAcknowledgment(() => new Promise(() => {}), 10);
  t.mock.timers.tick(10); assert.equal(expired.get('en'), "I'm sorry to hear that."); expired.cancel();
});
test('typed replies require exact active question and share deterministic consent policy', async () => {
  let scope!: AnswerScope; let check!: VoiceCheck;
  const spoken: string[] = [], accepted: string[] = [];
  const io: VoiceIO = { speak: async text => { spoken.push(text); }, listen: async () => new Promise(() => {}), cancel() {} };
  check = new VoiceCheck(io, 'en', '', { contactAvailable: true, acknowledgment: () => 'diagnose me',
    onQuestion: (question, captureId) => { scope = { question, captureId }; }, onAnswer: answer => accepted.push(answer.channel) });
  const pending = check.run('bpm_high'); await tick(); const wellness = { ...scope };
  assert.equal(check.answerByText('yes', { ...scope, captureId: 'old' }), false);
  assert.equal(check.answerByText("I'm dizzy", scope), true);
  assert.equal(check.answerByButton('ok', scope), false);
  await tick(); assert.equal(scope.question, 'contact_offer');
  assert.equal(check.answerByText('yes', wellness), false);
  assert.equal(check.answerByText('yes please', scope), true);
  const result = await pending;
  assert.equal(result.outcome, 'not_ok'); assert.equal(result.channel, 'typed'); assert.equal(check.authorizesContact(result), true);
  assert.deepEqual(accepted, ['typed', 'typed']); assert.match(spoken[1]!, /^I'm sorry to hear that/);
  check.cancel(); assert.equal(check.authorizesContact(result), false);
});
test('typed refusal and direct request preserve explicit authorization; unclear consent never authorizes', async () => {
  for (const [wellness, offer, authorized] of [['call my mom', '', true], ["I'm dizzy", 'no thanks', false], ["I'm dizzy", 'maybe', false]] as const) {
    let check!: VoiceCheck;
    check = new VoiceCheck({ speak: async () => {}, listen: async () => null, cancel() {} }, 'en', '', {
      contactAvailable: true, onQuestion: (question, captureId) => { check.answerByText(question === 'wellness' ? wellness : offer, { question, captureId }); },
    });
    const result = await check.run('bpm_high'); assert.equal(check.authorizesContact(result), authorized);
  }
});
test('urgent instructions precede empathy and partial voice cannot authorize or clear an event', async () => {
  const said: string[] = []; let attempts = 0;
  const check = new VoiceCheck({ speak: async text => { said.push(text); }, cancel() {},
    listen: async (_l, _ms, _h, id) => ++attempts === 1
      ? recognitionEvidence(id, { status: 'timeout', transcript: "I'm okay", isFinal: false })
      : recognitionEvidence(id, { status: 'success', transcript: 'help call 911', finalTranscript: 'help call 911', isFinal: true, finalResultReceived: true }),
  }, 'en', '', { acknowledgment: () => 'I hear you.', contactAvailable: true });
  const result = await check.run('bpm_high');
  assert.equal(result.outcome, 'not_ok'); assert.equal(result.attempts, 2);
  assert.match(said.at(-1)!, /^Pull over as soon as it is safe and call nine one one now\. I hear you\.$/);
  assert.equal(check.authorizesContact(result), false);
});
test('typed reply remains available after playback failure and cannot submit after cancellation', async () => {
  let scope!: AnswerScope;
  const check = new VoiceCheck({ speak: async () => { throw Error('speaker unavailable'); }, listen: async () => null, cancel() {} }, 'en', '', {
    onQuestion: (question, captureId) => { scope = { question, captureId }; },
  });
  const pending = check.run('bpm_high'); await tick();
  assert.equal(check.answerByText("I'm okay", scope), true);
  assert.equal((await pending).outcome, 'ok');
  check.cancel(); assert.equal(check.answerByText('call my mom', scope), false);
});
test('late final speech after a winning typed answer cannot replace the outcome or authorize contact', async () => {
  const late = deferred<ReturnType<typeof recognitionEvidence>>(); let scope!: AnswerScope;
  const check = new VoiceCheck({ speak: async () => {}, listen: async () => late.promise, cancel() {} }, 'en', '', {
    onQuestion: (question, captureId) => { scope = { question, captureId }; },
  });
  const pending = check.run('bpm_high'); await tick(); check.answerByText("I'm okay", scope);
  const result = await pending;
  late.resolve(recognitionEvidence(scope.captureId, { status: 'success', transcript: 'call my mom', finalTranscript: 'call my mom', isFinal: true, finalResultReceived: true }));
  await tick(); assert.equal(result.outcome, 'ok'); assert.equal(result.contactCall, 'not_requested'); assert.equal(check.authorizesContact(result), false);
});
test('real controller event starts presentation inference; episode ownership gates typed input and phone handoff', async () => {
  let state!: SafetyState, started = 0, cancelled = 0; const calls: string[] = [];
  const c = new SafetyController({ assistantMode: () => 'local',
    startAcknowledgment: () => { started++; return { get: () => 'I hear you.', source: 'gemma', cancel() { cancelled++; } }; },
    voiceIO: () => ({ speak: async () => {}, listen: async () => new Promise(() => {}), cancel() {} }),
    save: async () => {}, saveAck: async () => {}, haptic() {}, onChange: s => { state = s; }, newId: () => 'episode', handoffContact: async phone => { calls.push(phone); },
  });
  c.configure({ id: 'p', custom_id: null, display_name: 'Driver', age: 30, gender: 'male', height_cm: 180, weight_kg: 80,
    created_at: '', updated_at: '', emergency_name: 'Mom', emergency_phone: '+13055550123' }, null);
  assert.equal(started, 0); c.startSession('drive');
  for (let n = 0; n < 40 && !state.check; n++) c.onFrame({ version: 3, seq: n, rateHz: 0, quality: 90, startMs: 0, endMs: 0,
    heartRate: 155, spo2: 98, flags: 15, samples: [], finger: true, usable: true, raw: new Uint8Array() }, new Date(100000 + n * 1000), 0);
  await tick(); assert.equal(started, 1);
  const scope = () => ({ episodeId: state.check!.episode.id, question: state.check!.question, captureId: state.check!.captureId });
  assert.equal(c.answerText("I'm dizzy", { ...scope(), episodeId: 'old' }), false);
  assert.equal(c.answerText("I'm dizzy", scope()), true); await tick();
  assert.equal(state.check?.question, 'contact_offer'); assert.deepEqual(calls, []);
  assert.equal(c.answerText('yes please', scope()), true); await tick(); await tick();
  assert.deepEqual(calls, ['+13055550123']); assert.ok(cancelled > 0); assert.equal(state.last?.result.outcome, 'not_ok');
  assert.equal(c.safetyContinuation('episode'), false);
});

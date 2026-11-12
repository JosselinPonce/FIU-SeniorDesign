import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceCheck } from '../lib/voice/voiceCheck.ts';
import { understand, understandCallAnswer } from '../lib/voice/intent.ts';
import { recognitionEvidence, type CoreRecognition } from '../lib/voice/coreRecognition.ts';
import { responsiveness } from '../lib/voice/responsivenessDiagnostics.ts';
const tick = () => new Promise<void>(r => setImmediate(r));
const final = (id: string, text: string) => recognitionEvidence(id, { status: 'success', transcript: text, finalTranscript: text, isFinal: true, finalResultReceived: true });

test('observed finalized tired statement takes NOT OK and cannot itself authorize contact', async () => {
  for (const text of ["No I'm feeling really tired.", "No, I'm feeling really tired", "I'm feeling a little tired", 'I feel very tired']) {
    assert.equal(understand(text).intent, 'not_ok'); assert.equal(understand(text).contactCallRequested, false);
    assert.equal(understandCallAnswer(text), 'unclear');
    const said: string[] = [], displayed: string[] = []; let n = 0;
    const check = new VoiceCheck({ cancel() {}, speak: async t => { said.push(t); }, listen: async (_l,_m,_h,id) => final(id, ++n === 1 ? text : 'no thanks') }, 'en', '', {
      contactAvailable: true, onAnswer: answer => displayed.push(answer.text),
    });
    const result = await check.run('bpm_high'); assert.equal(result.outcome, 'not_ok'); assert.equal(result.contactCall, 'declined_offer');
    assert.equal(displayed[0], text); assert.equal(said.length, 6); assert.match(said.join(' '), /pull over.*Would you like/);
    assert.ok(said.every(t => !/didn't hear|No answer was confirmed/.test(t)));
  }
});
for (const mode of ['ambiguous', 'partial', 'silence', 'failure', 'stale'] as const) test(`truthful unresolved message for ${mode}, never consent`, async () => {
  const said: string[] = [], displayed: string[] = []; let reads = 0;
  const check = new VoiceCheck({ cancel() {}, speak: async text => { said.push(text); }, listen: async (_l,_m,_h,id) => {
    reads++;
    if (mode === 'ambiguous') return final(id, 'perhaps');
    if (mode === 'stale') return final('old-capture', 'yes');
    return recognitionEvidence(id, { status: mode === 'failure' ? 'error' : 'timeout', transcript: mode === 'partial' ? "I'm tired" : '', isFinal: false, finalResultReceived: mode === 'partial' });
  } }, 'en', '', { contactAvailable: true, onAnswer: answer => displayed.push(answer.text) });
  const result = await check.run('bpm_high'); assert.equal(reads, 2); assert.equal(result.outcome, 'no_response'); assert.equal(check.authorizesContact(result), false);
  const last = said.join(' '); assert.match(last, /pull over.*call 911/); assert.ok(!/didn't hear|recorded/.test(last));
  assert.match(last, mode === 'ambiguous' ? /couldn't understand/ : mode === 'partial' ? /Speech was detected/ : mode === 'failure' || mode === 'stale' ? /Voice input was unavailable/ : /No answer was confirmed/);
  assert.equal(displayed.length, mode === 'ambiguous' ? 2 : 0);
});
test('accepted finalized answer wins over a late timeout callback', async () => {
  let resolve!: (r: CoreRecognition) => void; let scope: any;
  const check = new VoiceCheck({ cancel() {}, speak: async () => {}, listen: async () => new Promise<CoreRecognition>(r => { resolve = r; }) }, 'en', '', {
    onQuestion: (question,captureId) => { scope = { question,captureId }; },
  });
  const pending = check.run('bpm_high'); await tick(); assert.equal(check.answerByText("No I'm feeling really tired", scope), true);
  const result = await pending; resolve(recognitionEvidence(scope.captureId, { status: 'timeout', transcript: '', isFinal: false }));
  await tick(); assert.equal(result.outcome, 'not_ok'); assert.equal(check.authorizesContact(result), false);
});
test('unresolved diagnostics are Debug-only codes without transcript content', async () => {
  const host = globalThis as typeof globalThis & { __DEV__?: boolean }; const before = host.__DEV__;
  try {
    for (const debug of [false,true]) {
      host.__DEV__ = debug; responsiveness.setEnabled(true);
      const check = new VoiceCheck({ cancel() {}, speak: async () => {}, listen: async (_l,_m,_h,id) => final(id,'perhaps') },'en','');
      await check.run('bpm_high');
      const records = responsiveness.snapshot().filter(r => r.operation === 'VoiceCheck unresolved response');
      assert.equal(records.length, debug ? 1 : 0); assert.ok(!JSON.stringify(records).includes('perhaps'));
      if (debug) assert.equal(records[0]!.events[0]!.details.reason,'ambiguous');
    }
  } finally { responsiveness.setEnabled(false); host.__DEV__ = before; }
});

test('actual incomplete empty-final after partial keeps fallback window and never publishes a driver decision', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const displayed: string[] = [], said: string[] = [];
  const check = new VoiceCheck({ cancel() {}, speak: async text => { said.push(text); }, listen: async (_l,_m,_h,id) => recognitionEvidence(id, {
    status: 'incomplete', reason: 'empty_final_after_partial', transcript: "No I'm feeling really tired", finalTranscript: '', finalResultReceived: true, isFinal: false,
  }) },'en','', { contactAvailable: true, onAnswer: answer => displayed.push(answer.text) });
  let done = false; const pending = check.run('bpm_high').finally(() => { done = true; });
  await tick(); assert.equal(done,false); t.mock.timers.tick(6000); await tick(); t.mock.timers.tick(6000); await tick();
  assert.equal((await pending).outcome,'no_response'); assert.deepEqual(displayed,[]); assert.match(said.join(' '),/Speech was detected, but no final response was confirmed/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceCheck, LISTEN_MS, type VoiceIO } from '../lib/voice/voiceCheck.ts';
import { recognitionEvidence, successfulFinal, type CoreRecognition } from '../lib/voice/coreRecognition.ts';

const final = (id: string, text: string) => recognitionEvidence(id, {
  status: 'success', transcript: text, finalTranscript: text, isFinal: true, finalResultReceived: true,
});
async function runOffer(change: (result: CoreRecognition) => CoreRecognition | string) {
  let attempt = 0;
  const budgets: number[] = [];
  const check = new VoiceCheck({ speak: async () => {}, cancel: () => {},
    listen: async (_lang, ms, _hints, id) => {
      budgets.push(ms);
      return ++attempt === 1 ? final(id, 'not okay') : change(final(id, 'yes'));
    },
  }, 'en', '', { contactAvailable: true });
  const result = await check.run('bpm_high');
  assert.ok(budgets.every(ms => ms === LISTEN_MS));
  return { check, result, attempt };
}

test('CORE final contextual yes authorizes only the actual offer; cancellation revokes proof', async () => {
  const { check, result, attempt } = await runOffer(r => r);
  assert.equal(result.contactCall, 'accepted_offer');
  assert.equal(attempt, 2);
  assert.equal(check.authorizesContact(result), true);
  check.cancel();
  assert.equal(check.authorizesContact(result), false);
});

for (const [name, change] of Object.entries({
  partial: (r: CoreRecognition) => ({ ...r, isFinal: false, finalResultReceived: false }),
  metadata: (r: CoreRecognition) => ({ ...r, finalResultReceived: false }),
  timeout: (r: CoreRecognition) => ({ ...r, status: 'timeout' as const }),
  cancelled: (r: CoreRecognition) => ({ ...r, status: 'cancelled' as const, cancelled: true }),
  stale: (r: CoreRecognition) => ({ ...r, captureId: 'previous-question' }),
  emptyFinal: (r: CoreRecognition) => ({ ...r, finalTranscript: '' }),
  legacyString: () => 'yes',
})) {
  test(`CORE ${name} yes cannot authorize contact and retains one retry`, async () => {
    const { check, result, attempt } = await runOffer(change);
    assert.equal(result.contactCall, 'unconfirmed_offer');
    assert.equal(result.outcome, 'not_ok');
    assert.equal(check.authorizesContact(result), false);
    assert.equal(attempt, 3);
  });
}

test('CORE partial direct request cannot classify wellness or skip final consent', async () => {
  let count = 0;
  const check = new VoiceCheck({ speak: async () => {}, cancel: () => {},
    listen: async (_l, _m, _h, id) => ++count === 1
      ? recognitionEvidence(id, { status: 'timeout', transcript: 'call my mom', isFinal: false }) : null,
  }, 'en', '', { contactAvailable: true });
  const result = await check.run('bpm_high');
  assert.equal(result.outcome, 'no_response');
  assert.equal(result.contactCall, 'not_requested');
  assert.equal(check.authorizesContact(result), false);
});

test('CORE final direct request preserves direct handoff and final refusal denies it', async () => {
  for (const direct of [true, false]) {
    let count = 0;
    const check = new VoiceCheck({ speak: async () => {}, cancel: () => {},
      listen: async (_l, _m, _h, id) => final(id, ++count === 1 ? (direct ? 'call my mom' : 'not okay') : 'no thanks'),
    }, 'en', '', { contactAvailable: true });
    const result = await check.run('bpm_high');
    assert.equal(result.contactCall, direct ? 'explicit_request' : 'declined_offer');
    assert.equal(check.authorizesContact(result), direct);
  }
});

test('CORE explicit contact button remains authorized without recognition', async () => {
  let check: VoiceCheck;
  check = new VoiceCheck({ speak: async () => {}, listen: async () => null, cancel: () => {} }, 'en', '', {
    contactAvailable: true, onQuestion: q => check.answerByButton(q === 'wellness' ? 'not_ok' : 'call_yes'),
  });
  const result = await check.run('bpm_high');
  assert.equal(check.authorizesContact(result), true);
});

test('CORE late successful callback after cancellation cannot create consent', async () => {
  let resolve!: (result: CoreRecognition) => void;
  let captureId = '';
  const io: VoiceIO = { speak: async () => {}, cancel: () => {},
    listen: async (_l, _m, _h, id) => { captureId = id; return new Promise(r => { resolve = r; }); },
  };
  const check = new VoiceCheck(io, 'en', '', { contactAvailable: true });
  const pending = check.run('bpm_high');
  await new Promise(r => setImmediate(r));
  check.cancel();
  await assert.rejects(pending, /cancelled/);
  resolve(final(captureId, 'call my mom'));
  await new Promise(r => setImmediate(r));
  assert.equal(check.authorizesContact({ contactCall: 'explicit_request' } as never), false);
});

test('native result conversion preserves finality and rejects stale completion', () => {
  const genuine = final('active', 'yes');
  assert.equal(successfulFinal(genuine, 'active'), true);
  assert.equal(successfulFinal(recognitionEvidence('active', genuine, false), 'active'), false);
  assert.equal(successfulFinal(recognitionEvidence('active', { status: 'success', transcript: 'yes', isFinal: true }), 'active'), false);
});

test('CORE a failed contact prompt cannot accept a queued spoken yes', async () => {
  let listens = 0;
  const check = new VoiceCheck({
    speak: async text => { if (text.includes('Would you like')) throw new Error('Playback failed'); },
    listen: async (_l, _m, _h, id) => final(id, ++listens === 1 ? 'not okay' : 'yes'),
    cancel: () => {},
  }, 'en', '', { contactAvailable: true });
  const result = await check.run('bpm_high');
  assert.equal(result.contactCall, 'unconfirmed_offer');
  assert.equal(listens, 1);
  assert.equal(check.authorizesContact(result), false);
});

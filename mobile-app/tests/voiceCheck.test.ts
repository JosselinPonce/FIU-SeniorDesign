import { test } from 'node:test';
import assert from 'node:assert/strict';

import { VoiceCheck, type VoiceIO } from '../lib/voice/voiceCheck.ts';

/** Scripted fake: each listen() returns the next scripted answer. */
function fake(answers: (string | null)[], opts: { listenDelay?: number } = {}) {
  const said: string[] = [];
  let cancelled = 0;
  const io: VoiceIO = {
    speak: async (text) => {
      said.push(text);
    },
    listen: async () => {
      await new Promise((r) => setTimeout(r, opts.listenDelay ?? 1));
      return answers.shift() ?? null;
    },
    cancel: () => {
      cancelled += 1;
    },
  };
  return { io, said, cancelled: () => cancelled };
}

test('"yeah I\'m fine" on the first try → ok, reassured', async () => {
  const f = fake(["yeah i'm fine"]);
  const r = await new VoiceCheck(f.io, 'en', 'Luis').run('bpm_high');
  assert.equal(r.outcome, 'ok');
  assert.equal(r.attempts, 1);
  assert.match(f.said[0]!, /^Luis, your heart rate has been unusually high\. Are you feeling okay\?/);
  assert.match(f.said[1]!, /keep an eye/);
});

test('unclear, then "no I feel dizzy" → not_ok after a second, simpler question', async () => {
  const f = fake(['what', 'no i feel dizzy']);
  const r = await new VoiceCheck(f.io, 'en', '').run('bpm_low');
  assert.deepEqual([r.outcome, r.attempts, r.urgent], ['not_ok', 2, false]);
  assert.match(f.said[1]!, /didn't catch that/);
  assert.match(f.said[2]!, /pull over/);
});

test('silence twice → no_response (treated as an emergency by the caller)', async () => {
  const f = fake([null, null]);
  const r = await new VoiceCheck(f.io, 'en', 'Joss').run('spo2_low');
  assert.equal(r.outcome, 'no_response');
  assert.match(f.said[f.said.length - 1]!, /recorded as an emergency/);
});

test('"help, call 911" → urgent', async () => {
  const f = fake(['help call 911']);
  const r = await new VoiceCheck(f.io, 'en', '').run('bpm_high');
  assert.deepEqual([r.outcome, r.urgent], ['not_ok', true]);
  assert.match(f.said[1]!, /call nine one one now/);
});

test('Spanish: "sí, estoy bien" → ok, spoken in Spanish', async () => {
  const f = fake(['sí estoy bien']);
  const r = await new VoiceCheck(f.io, 'es', 'Joss').run('bpm_high');
  assert.equal(r.outcome, 'ok');
  assert.match(f.said[0]!, /¿Te sientes bien\?/);
});

test('a button press wins immediately, even mid-listen', async () => {
  const f = fake(['yes'], { listenDelay: 200 });
  const check = new VoiceCheck(f.io, 'en', '');
  const p = check.run('bpm_high');
  setTimeout(() => check.answerByButton('not_ok'), 20);
  const r = await p;
  assert.deepEqual([r.outcome, r.channel], ['not_ok', 'button']);
  assert.ok(f.cancelled() >= 1);
});


test('explicit contact request skips the call offer and preserves not_ok', async () => {
  const f = fake(["No, I'm feeling dizzy, please call my mom"]);
  const result = await new VoiceCheck(f.io, 'en', '', { contactAvailable: true }).run('bpm_high');
  assert.equal(result.outcome, 'not_ok');
  assert.equal(result.contactCall, 'explicit_request');
  assert.equal(f.said.some(s => s.includes('Would you like')), false);
});

test('call offer accepts natural consent and keeps the wellness outcome', async () => {
  const f = fake(['not okay', 'go ahead']);
  const result = await new VoiceCheck(f.io, 'en', '', { contactAvailable: true }).run('bpm_high');
  assert.equal(result.outcome, 'not_ok');
  assert.equal(result.contactCall, 'accepted_offer');
  assert.ok(f.said.includes('Would you like me to call your emergency contact?'));
});

test('negative offer response does not authorize handoff', async () => {
  const f = fake(['not okay', 'no thanks']);
  const result = await new VoiceCheck(f.io, 'en', '', { contactAvailable: true }).run('bpm_high');
  assert.equal(result.contactCall, 'declined_offer');
  assert.equal(result.outcome, 'not_ok');
});

test('failed call-offer capture preserves the NOT OK incident without consent', async () => {
  let listens = 0;
  const io: VoiceIO = { speak: async () => {}, cancel: () => {}, listen: async () => {
    if (++listens === 1) return 'not okay';
    throw new Error('Recognition unavailable');
  } };
  const result = await new VoiceCheck(io, 'en', '', { contactAvailable: true }).run('bpm_high');
  assert.equal(result.outcome, 'not_ok');
  assert.equal(result.contactCall, 'unconfirmed_offer');
});

test('unclear or silent call consent retries exactly once, then stops', async () => {
  for (const answers of [[null, null], ['maybe', 'what']] as (string | null)[][]) {
    const f = fake(['not okay', ...answers, 'yes']);
    const result = await new VoiceCheck(f.io, 'en', '', { contactAvailable: true }).run('bpm_high');
    assert.equal(result.contactCall, 'unconfirmed_offer');
    assert.equal(f.said.filter(s => s.includes('Would you like')).length, 2);
  }
});

test('wellness button cannot be reused as consent; cancellation ends a pending offer', async () => {
  let check: VoiceCheck;
  const f = fake([], { listenDelay: 5 });
  check = new VoiceCheck(f.io, 'en', '', { contactAvailable: true, onQuestion: q => {
    if (q === 'wellness') check.answerByButton('not_ok');
    else {
      check.answerByButton('ok'); // stale wellness tap must be ignored
      check.answerByButton('call_no');
    }
  } });
  assert.equal((await check.run('bpm_high')).contactCall, 'declined_offer');
  check = new VoiceCheck(f.io, 'en', '', { contactAvailable: true, onQuestion: q => {
    if (q === 'wellness') check.answerByButton('not_ok');
    else check.cancel();
  } });
  await assert.rejects(check.run('bpm_high'), /cancelled/);
  assert.equal(check.cancelledResult?.outcome, 'not_ok');
  assert.equal(check.cancelledResult?.contactCall, 'cancelled');
});

test('emergency-service requests end the contact branch, regardless of queued affirmative responses', async () => {
  for (const answers of [['call 911', 'yes'], ['not okay', 'call 911', 'yes'], ['not okay', 'call the police', 'yes']]) {
    const f = fake(answers);
    const result = await new VoiceCheck(f.io, 'en', '', { contactAvailable: true }).run('bpm_high');
    assert.equal(result.contactCall, 'emergency_services');
    assert.equal(result.outcome, 'not_ok');
    assert.deepEqual(answers, ['yes']);
  }
});

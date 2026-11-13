import { recognitionEvidence } from '../lib/voice/coreRecognition.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { VoiceCheck, type VoiceIO } from '../lib/voice/voiceCheck.ts';
import { startSemantic } from '../lib/assistant/safetySemantic.ts';

/** Scripted fake: each listen() returns the next scripted answer. */
function fake(answers: (string | null)[], opts: { listenDelay?: number } = {}) {
  const said: string[] = [];
  let cancelled = 0;
  const io: VoiceIO = {
    speak: async (text) => {
      said.push(text);
    },
    listen: async (_lang, _ms, _hints, captureId) => {
      await new Promise((r) => setTimeout(r, opts.listenDelay ?? 1));
      const text = answers.shift();
      return text == null ? null : recognitionEvidence(captureId, { status: 'success', transcript: text, finalTranscript: text, isFinal: true, finalResultReceived: true });
    },
    cancel: () => {
      cancelled += 1;
    },
  };
  return { io, said, cancelled: () => cancelled };
}

test('Spanish contact prompts use the validated configured name and preserve deterministic consent', async () => {
  for (const contactName of ['Aunt María', 'Dr. Rivera', '', 'not-a-name@invalid']) {
    const f = fake(['no estoy bien', 'sí, por favor']);
    const result = await new VoiceCheck(f.io, 'es', 'Luis', { contactAvailable: true, contactName }).run('bpm_high');
    assert.equal(result.contactCall, 'accepted_offer');
    const suitable = ['Aunt María', 'Dr. Rivera'].includes(contactName);
    assert.ok(f.said.some(text => text.endsWith(suitable ? `¿Quieres que llame a ${contactName}?` : '¿Quieres que llame a tu contacto de emergencia?')));
  }
});

test('"yeah I\'m fine" on the first try → ok, reassured', async () => {
  const f = fake(["yeah i'm fine"]);
  const r = await new VoiceCheck(f.io, 'en', 'Luis').run('bpm_high');
  assert.equal(r.outcome, 'ok');
  assert.equal(r.attempts, 1);
  assert.match(f.said.join(' '), /^Luis, your heart rate has been unusually high\. Are you feeling okay\?/);
  assert.match(f.said.join(' '), /keep an eye/);
});

test('unclear, then "no I feel dizzy" → not_ok after a second, simpler question', async () => {
  const f = fake(['what', 'no i feel dizzy']);
  const r = await new VoiceCheck(f.io, 'en', '').run('bpm_low');
  assert.deepEqual([r.outcome, r.attempts, r.urgent], ['not_ok', 2, false]);
  assert.match(f.said.join(' '), /didn't catch that/);
  assert.match(f.said.join(' '), /pull over/);
});

test('silence twice → no_response (treated as an emergency by the caller)', async () => {
  const f = fake([null, null]);
  const r = await new VoiceCheck(f.io, 'en', 'Joss').run('spo2_low');
  assert.equal(r.outcome, 'no_response');
  assert.match(f.said.join(' '), /No answer was confirmed.*pull over.*call 911/);
});

test('"help, call 911" → urgent', async () => {
  const f = fake(['help call 911']);
  const r = await new VoiceCheck(f.io, 'en', '').run('bpm_high');
  assert.deepEqual([r.outcome, r.urgent], ['not_ok', true]);
  assert.match(f.said.join(' '), /call 911 now/);
});

test('Spanish: "sí, estoy bien" → ok, spoken in Spanish', async () => {
  const f = fake(['sí estoy bien']);
  const r = await new VoiceCheck(f.io, 'es', 'Joss').run('bpm_high');
  assert.equal(r.outcome, 'ok');
  assert.match(f.said.join(' '), /¿Te sientes bien\?/);
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
  assert.ok(f.said.some(text => text.endsWith('Would you like me to call your emergency contact?')));
});

test('negative offer response does not authorize handoff', async () => {
  const f = fake(['not okay', 'no thanks']);
  const result = await new VoiceCheck(f.io, 'en', '', { contactAvailable: true }).run('bpm_high');
  assert.equal(result.contactCall, 'declined_offer');
  assert.equal(result.outcome, 'not_ok');
});

test('failed call-offer capture preserves the NOT OK incident without consent', async () => {
  let listens = 0;
  const io: VoiceIO = { speak: async () => {}, cancel: () => {}, listen: async (_l, _m, _h, id) => {
    if (++listens === 1) return recognitionEvidence(id, { status: 'success', transcript: 'not okay', finalTranscript: 'not okay', isFinal: true, finalResultReceived: true });
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

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
test('initial playback failure preserves buttons and duplicate taps cannot overwrite the winner', async () => {
  const answers: string[] = [];
  let listens = 0;
  const check = new VoiceCheck({ speak: async () => { throw new Error('speaker failed'); },
    listen: async () => { listens++; return null; }, cancel() {} }, 'en', '', {
    onAnswer: answer => answers.push(answer.text),
  });
  const pending = check.run('bpm_high'); await tick();
  check.answerByButton('ok'); check.answerByButton('not_ok');
  const result = await pending;
  assert.equal(result.outcome, 'ok'); assert.equal(result.channel, 'button');
  assert.deepEqual(answers, ["I'm OK"]); assert.equal(listens, 0);
  assert.equal(check.authorizesContact(result), false);
});
for (const status of ['incomplete', 'timeout', 'success'] as const) {
  test(`${status} partial okay cannot clear a check; successful final retry can`, async () => {
    let listens = 0;
    const check = new VoiceCheck({ speak: async () => {}, cancel() {},
      listen: async (_l, _m, _h, id) => {
        listens++;
        return recognitionEvidence(id, { status: listens === 1 ? status : 'success', transcript: "I'm okay",
          finalTranscript: listens === 1 ? '' : "I'm okay", isFinal: listens !== 1, finalResultReceived: listens !== 1 });
      } }, 'en', '');
    const result = await check.run('bpm_high');
    assert.equal(result.outcome, 'ok'); assert.equal(result.attempts, 2); assert.equal(listens, 2);
  });
}
test('only unconfirmed okay responses exhaust the retry as no_response', async () => {
  const check = new VoiceCheck({ speak: async () => {}, cancel() {},
    listen: async (_l, _m, _h, id) => recognitionEvidence(id, {status:'timeout',transcript:"I'm okay",isFinal:false}) }, 'en', '');
  assert.equal((await check.run('bpm_high')).outcome, 'no_response');
});
test('cancellation during failed-playback button recovery ends the check', async () => {
  const check = new VoiceCheck({ speak: async () => { throw Error('failed'); }, listen: async () => null, cancel() {} }, 'en', '');
  const pending = check.run('spo2_low'); await tick(); check.cancel();
  await assert.rejects(pending, /cancelled/);
  check.answerByButton('ok');
});

test('failed playback keeps each button window open, then exhausts retries without calling', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let prompts = 0;
  const check = new VoiceCheck({ speak: async () => { prompts++; throw Error('failed'); },
    listen: async () => { throw Error('must not listen after failed prompt'); }, cancel() {} }, 'en', '', { contactAvailable: true });
  const pending = check.run('bpm_high');
  let finished = false; void pending.then(() => { finished = true; });
  await tick(); assert.equal(finished, false); assert.equal(prompts, 1);
  t.mock.timers.tick(6000); await tick();
  assert.equal(finished, false); assert.equal(prompts, 2);
  t.mock.timers.tick(6000);
  const result = await pending;
  assert.equal(result.outcome, 'no_response'); assert.equal(result.attempts, 2);
  assert.equal(result.contactCall, 'not_requested'); assert.equal(check.authorizesContact(result), false);
});

for (const response of ['button', 'typed', 'none', 'cancel'] as const) {
  test(`returned recognition error retains bounded response window: ${response}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const spoken: string[] = [];
    let unavailable = 0;
    let scope!: { captureId: string; question: 'wellness' | 'contact_offer' };
    const check = new VoiceCheck({
      speak: async text => { spoken.push(text); },
      listen: async (_l, _m, _h, id) => recognitionEvidence(id, {
        status: 'error', reason: 'audio_setup_failed', transcript: '', isFinal: false,
      }),
      responseUnavailable: () => { unavailable++; }, cancel() {},
    }, 'en', '', { onQuestion: (question, captureId) => { scope = { question, captureId }; } });
    const pending = check.run('bpm_high');
    const cancelled = response === 'cancel' ? assert.rejects(pending, /cancelled/) : null;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(unavailable, 1);
    t.mock.timers.tick(5999);
    assert.equal(spoken.length, 3);
    if (response === 'button') {
      assert.equal(check.answerByButton('ok', scope), true);
      assert.equal(check.answerByButton('not_ok', scope), false);
    } else if (response === 'typed') assert.equal(check.answerByText("I'm okay", scope), true);
    else if (response === 'cancel') check.cancel();
    else {
      t.mock.timers.tick(1); await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(spoken.length, 6);
      t.mock.timers.tick(6000);
    }
    if (cancelled) await cancelled;
    else assert.equal((await pending).outcome, response === 'none' ? 'no_response' : 'ok');
  });
}

test('recognition waits for playback completion', async () => {
  let done!: () => void;
  let listens = 0;
  const playback = new Promise<void>(resolve => { done = resolve; });
  const check = new VoiceCheck({
    speak: async () => { if (!listens) await playback; },
    listen: async (_l, _m, _h, id) => { listens++; return recognitionEvidence(id, {
      status: 'success', transcript: 'yes', finalTranscript: 'yes', isFinal: true, finalResultReceived: true,
    }); }, cancel() {},
  }, 'en', '');
  const pending = check.run('bpm_high');
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(listens, 0); done();
  assert.equal((await pending).outcome, 'ok'); assert.equal(listens, 1);
});

for (const language of ['en', 'es'] as const) test(`${language}: capture preparation is registered before TTS; listening waits for completion and keeps 6000 ms`, async () => {
  const events: string[] = [];
  let finishPrompt!: () => void;
  let capture = '';
  const playback = new Promise<void>(resolve => { finishPrompt = resolve; });
  const io: VoiceIO = {
    prepareRecognition: (lang, id) => { assert.equal(lang, language); capture = id; events.push('prepare'); },
    speak: async () => { if (!events.includes('listen')) { events.push('speak'); await playback; } },
    listen: async (_lang, ms, _hints, id) => {
      assert.equal(id, capture); assert.equal(ms, 6000); events.push('listen');
      return recognitionEvidence(id, { status: 'success', transcript: language === 'es' ? 'sí' : 'yes', finalTranscript: language === 'es' ? 'sí' : 'yes', isFinal: true, finalResultReceived: true });
    }, cancel() {},
  };
  const pending = new VoiceCheck(io, language, '').run('bpm_high');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['prepare', 'speak']);
  finishPrompt(); await pending;
  assert.deepEqual(events, ['prepare', 'speak', 'speak', 'speak', 'listen']);
});
test('cancellation during prewarmed TTS cancels the capture and cannot activate late listening', async () => {
  let finish!: () => void, cancelled = 0, listens = 0;
  const check = new VoiceCheck({ prepareRecognition() {}, speak: () => new Promise(resolve => { finish = resolve; }),
    listen: async () => { listens++; return null; }, cancel: () => { cancelled++; } }, 'es', '');
  const pending = check.run('bpm_low');
  await new Promise(resolve => setImmediate(resolve));
  const rejected = assert.rejects(pending, /cancelled/);
  check.cancel(); finish(); await rejected;
  assert.equal(listens, 0); assert.ok(cancelled > 0);
});

for (const channel of ['typed', 'button'] as const) test(`${channel} can answer during prewarmed TTS without microphone activation`, async () => {
  let scope: any, finish!: () => void, spoken = 0, listens = 0, cancelled = 0;
  const check = new VoiceCheck({ prepareRecognition() {},
    speak: () => ++spoken === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(),
    listen: async () => { listens++; return null; }, cancel: () => { cancelled++; } }, 'es', '',
    { onQuestion: (question, captureId) => { scope = { question, captureId }; } });
  const pending = check.run('spo2_low');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(channel === 'typed' ? check.answerByText('estoy bien', scope) : check.answerByButton('ok', scope), true);
  const result = await pending; finish(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(result.outcome, 'ok'); assert.equal(result.channel, channel); assert.equal(listens, 0); assert.ok(cancelled > 0);
});

test('Debug trace correlates incomplete native evidence, manual winner and question closure without text', async () => {
  const { responsiveness } = await import('../lib/voice/responsivenessDiagnostics.ts');
  const host = globalThis as typeof globalThis & { __DEV__?: boolean };
  const previous = host.__DEV__; host.__DEV__ = true; responsiveness.setEnabled(true);
  let scope!: { captureId: string; question: 'wellness' | 'contact_offer' };
  let check!: VoiceCheck;
  try {
    check = new VoiceCheck({ speak: async () => {}, cancel() {},
      listen: async (_l, _m, _h, id) => recognitionEvidence(id, {
        status: 'incomplete', reason: 'empty_final_after_partial', transcript: 'PRIVATE PARTIAL',
        finalTranscript: '', isFinal: false, finalResultReceived: true,
      }),
      responseUnavailable: () => { queueMicrotask(() => check.answerByButton('ok', scope)); },
    }, 'en', '', { onQuestion: (question, captureId) => { scope = { question, captureId }; } });
    assert.equal((await check.run('bpm_high')).outcome, 'ok');
    const record = responsiveness.snapshot().find(r => r.operation === 'VoiceCheck decision')!;
    assert.ok(record.events.some(e => e.point === 'unavailable requested' && e.details.status === 'incomplete'));
    assert.ok(record.events.some(e => e.point === 'answer selected' && e.details.channel === 'button'));
    assert.ok(record.events.some(e => e.point === 'question closed'));
    assert.ok(record.events.every(e => e.details.captureId === scope.captureId));
    assert.equal(JSON.stringify(responsiveness.snapshot()).includes('PRIVATE PARTIAL'), false);
  } finally { responsiveness.setEnabled(false); host.__DEV__ = previous; }
});

test('gemma resolves a novel idiom on attempt 1 without a re-ask', async () => {
  // mode: generate() resolves immediately with a NOT_OK JSON for the idiom
  const f = fake(["i'm feeling under the weather today"]);
  const r = await new VoiceCheck(f.io, 'en', '', {
    startSemantic: ctx => startSemantic(async () => '{"state":"NOT_OK","context":"other","concern":"yes"}', ctx, 5000),
  }).run('bpm_high');
  assert.deepEqual([r.outcome, r.attempts], ['not_ok', 1]);
  assert.ok(!f.said.some(t => t.includes("didn't catch that"))); // re-ask skipped
  assert.match(f.said.join(' '), /pull over/);
});
test('late gemma still re-asks exactly as today, then resolves on attempt 2', async () => {
  const f = fake(['what is this', 'no i feel dizzy']);
  const r = await new VoiceCheck(f.io, 'en', '', { startSemantic: ctx => startSemantic(async () => { throw new Error('missing'); }, ctx, 50) }).run('bpm_low');
  assert.match(f.said.join(' '), /didn't catch that/);
  assert.equal(r.outcome, 'not_ok');
});
test('gemma OK on a hedged-free unclear statement clears it', async () => {
  const f = fake(['honestly I think everything is okay']);
  const r = await new VoiceCheck(f.io, 'en', '', {
    startSemantic: ctx => startSemantic(async () => '{"state":"OK","context":"none","concern":"no"}', ctx, 5000),
  }).run('bpm_high');
  assert.deepEqual([r.outcome, r.attempts], ['ok', 1]);
  assert.match(f.said.join(' '), /keep an eye/);
});
test('gemma NOT_OK on a negated statement never escalates', async () => {
  const f = fake(["I'm not dizzy"]);
  const r = await new VoiceCheck(f.io, 'en', '', {
    startSemantic: ctx => startSemantic(async () => '{"state":"NOT_OK","context":"dizziness","concern":"yes"}', ctx, 5000),
  }).run('bpm_low');
  assert.notEqual(r.outcome, 'not_ok');   // second listen happens; no gemma escalation
});
test('bounded wait: no task => no added silence', async () => {
  const f = fake(['what', 'no i feel dizzy']);
  const started = Date.now();
  await new VoiceCheck(f.io, 'en', '').run('bpm_low');   // no startSemantic option
  assert.ok(Date.now() - started < 500);
});

test('gemma consult resolves a rules-unclear answer on attempt 1, skipping the re-ask', async () => {
  // "stretch my legs" stays rules-unclear: only the combiner can resolve it.
  const f = fake(['yeah just need to stretch my legs']);
  const r = await new VoiceCheck(f.io, 'en', '', {
    startSemantic: ctx => startSemantic(() => Promise.resolve('{"state":"NOT_OK","context":"other","concern":"yes"}'), ctx, 5000),
  }).run('bpm_high');
  assert.deepEqual([r.outcome, r.attempts], ['not_ok', 1]);
  assert.ok(!f.said.some(t => t.includes("didn't catch that")));
  assert.match(f.said.join(' '), /pull over/);
});
test('gemma OK clears a rules-unclear answer without symptom language on attempt 1', async () => {
  const f = fake(['yeah just need to stretch my legs']);
  const r = await new VoiceCheck(f.io, 'en', '', {
    startSemantic: ctx => startSemantic(() => Promise.resolve('{"state":"OK","context":"none","concern":"no"}'), ctx, 5000),
  }).run('bpm_high');
  assert.deepEqual([r.outcome, r.attempts], ['ok', 1]);
  assert.ok(!f.said.some(t => t.includes("didn't catch that")));
  assert.match(f.said.join(' '), /keep an eye/);
});
test('rules-decidable answers never open a semantic task', async () => {
  let opened = 0;
  const f = fake(['no i feel dizzy']);
  const r = await new VoiceCheck(f.io, 'en', '', {
    startSemantic: ctx => { opened++; return startSemantic(async () => '{"state":"NOT_OK","context":"dizziness","concern":"yes"}', ctx, 5000); },
  }).run('bpm_low');
  assert.deepEqual([r.outcome, r.attempts], ['not_ok', 1]);
  assert.equal(opened, 0);
});
test('reAskWaitMs is the ceiling the in-flight verdict may resolve inside', async () => {
  const f = fake(['yeah just need to stretch my legs']);
  const r = await new VoiceCheck(f.io, 'en', '', {
    reAskWaitMs: 60,
    startSemantic: ctx => startSemantic(() => new Promise<string>(resolve => setTimeout(() => resolve('{"state":"NOT_OK","context":"other","concern":"yes"}'), 40)), ctx, 5000),
  }).run('bpm_high');
  assert.deepEqual([r.outcome, r.attempts], ['not_ok', 1]);  // the 40 ms verdict lands inside the 60 ms window
  assert.ok(!f.said.some(t => t.includes("didn't catch that")));
});
test('a button tap wins immediately during the bounded wait, discarding the gemma verdict', async () => {
  const signals: AbortSignal[] = [];
  const f = fake(['yeah just need to stretch my legs'], { listenDelay: 10 });
  // The OK verdict lands before the tap and would clear this rules-unclear
  // statement; the button tap must still win and the verdict must be discarded.
  const check = new VoiceCheck(f.io, 'en', '', {
    reAskWaitMs: 60000,
    startSemantic: ctx => startSemantic(signal => { signals.push(signal);
      return new Promise<string>(resolve => setTimeout(() => resolve('{"state":"OK","context":"none","concern":"no"}'), 20)); }, ctx, 5000),
  });
  const pending = check.run('bpm_high');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(check.answerByButton('not_ok'), true);
  const r = await pending;
  assert.deepEqual([r.outcome, r.channel, r.attempts], ['not_ok', 'button', 1]);
  assert.ok(!f.said.some(t => t.includes("didn't catch that")));   // no re-ask
  assert.equal(signals[0].aborted, true);   // the task was cancelled without its verdict being applied
});
test('a typed answer wins immediately during the bounded wait, discarding the gemma verdict', async () => {
  const signals: AbortSignal[] = [];
  const f = fake(['yeah just need to stretch my legs'], { listenDelay: 10 });
  let scope: { question: 'wellness' | 'contact_offer'; captureId: string } | null = null;
  const check = new VoiceCheck(f.io, 'en', '', {
    reAskWaitMs: 60000,
    onQuestion: (question, captureId) => { scope = { question, captureId }; },
    startSemantic: ctx => startSemantic(signal => { signals.push(signal);
      return new Promise<string>(resolve => setTimeout(() => resolve('{"state":"OK","context":"none","concern":"no"}'), 20)); }, ctx, 5000),
  });
  const pending = check.run('bpm_high');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(typeof scope!.captureId, 'string');
  assert.equal(check.answerByText('no i feel dizzy', scope!), true);
  const r = await pending;
  assert.deepEqual([r.outcome, r.channel, r.attempts], ['not_ok', 'typed', 1]);
  assert.ok(!f.said.some(t => t.includes("didn't catch that")));
  assert.equal(signals[0].aborted, true);
});
test('never two semantic tasks in flight: the re-ask attempt opens its task only after the first is cancelled', async () => {
  let alive = 0; const events: string[] = [];
  const f = fake(['perhaps', 'perhaps']);
  const r = await new VoiceCheck(f.io, 'en', '', {
    startSemantic: ctx => {
      events.push(`open(alive=${alive})`);
      return startSemantic(signal => {
        alive++; events.push(`generate(alive=${alive})`);
        return new Promise<string>(resolve => { signal.addEventListener('abort', () => { alive--; events.push('abort'); resolve(''); }); });
      }, ctx, 5000);
    },
  }).run('bpm_high');
  assert.equal(r.outcome, 'no_response');
  assert.deepEqual(events.filter(e => e.startsWith('open')), ['open(alive=0)', 'open(alive=0)'],
    'both attempts open exactly one semantic task, and neither opened while a task was alive');
  assert.ok(events.includes('generate(alive=1)'), 'the first attempt does generate');
  const openedSecond = events.indexOf('open(alive=0)', 1);
  assert.ok(openedSecond > events.indexOf('abort'), 'the attempt-1 task was cancelled before the attempt-2 task was opened');
});
test('dev diagnostics report the combined decision source', async () => {
  const { responsiveness } = await import('../lib/voice/responsivenessDiagnostics.ts');
  const host = globalThis as typeof globalThis & { __DEV__?: boolean };
  const previous = host.__DEV__; host.__DEV__ = true; responsiveness.setEnabled(true);
  try {
    const f = fake(['yeah just need to stretch my legs']);
    const r = await new VoiceCheck(f.io, 'en', '', {
      startSemantic: ctx => startSemantic(() => Promise.resolve('{"state":"NOT_OK","context":"other","concern":"yes"}'), ctx, 5000),
    }).run('bpm_high');
    assert.equal(r.outcome, 'not_ok');
    const record = responsiveness.snapshot().find(rec => rec.operation === 'VoiceCheck semantic decision');
    assert.ok(record, 'semantic decision probe recorded');
    assert.ok(record.events.some(e => e.details.decisionSource === 'gemma' && e.details.source === 'gemma-primary'), JSON.stringify(record.events.map(e => e.details)));
  } finally { responsiveness.setEnabled(false); host.__DEV__ = previous; }
});

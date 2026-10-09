import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AssistantConversation, type AssistantDeps, type ConversationState } from '../modules/local-foundation-models/assistantConversation.ts';
import { AudioOwnership } from '../lib/voice/audioOwnership.ts';
import { assertAssistantPlatform, assertAssistantCapabilities, conversationalReply, selectAssistantVoice } from '../modules/local-foundation-models/conversationPolicy.ts';
import type { DriverInterpretation, OfflineTranscription } from '../modules/local-foundation-models/index.ts';
import { explicitContactCallRequest } from '../lib/voice/intent.ts';
const interpretation: DriverInterpretation = { wellness: 'ok', requestsSavedEmergencyContact: false,
  explicitContactRequest: false, suggestedReply: 'Thanks for sharing. How are you feeling now?', advisoryOnly: true, callAuthorized: false };
const captured = (transcript: string): OfflineTranscription => ({ status: 'success', isFinal: true,
  locale: 'en-US', requiresOnDeviceRecognition: true, transcript, reason: 'complete', message: '',
  totalTimeMs: 10, recognitionTimeMs: 10, listeningTimeMs: 8, finalizationTimeMs: 2,
  firstPartialTimeMs: 1, endpointReason: 'audio_silence', silenceTargetMs: 1300, finalizationGraceMs: 2500 });
function fake(answers: string[] = ['I feel fine', 'stop'], patch: Partial<AssistantDeps> = {}) {
  const states: ConversationState[] = [], spoken: string[] = [], contexts: string[] = [], handed: string[] = [], cancelled: string[] = [];
  let released = 0;
  const deps: AssistantDeps = {
    contactAvailability: () => 'available',
    prepare: async () => {}, acquire: async () => () => { released++; },
    speak: async text => { spoken.push(text); }, listen: async () => captured(answers.shift() ?? 'stop'),
    interpret: async (_, context) => { contexts.push(context); return { status: 'success', processingTimeMs: 1, interpretation }; },
    cancel: async kind => { cancelled.push(kind); },
    handoff: async text => { handed.push(text); return 'opened'; },
    onChange: state => { states.push(state); }, ...patch,
  };
  return { deps, states, spoken, contexts, handed, cancelled, released: () => released };
}
test('natural model replies and prior-turn context are preserved', async () => {
  const f = fake(['I feel fine', 'A little tired', 'stop']); await new AssistantConversation(f.deps).start();
  assert.ok(f.spoken.includes(interpretation.suggestedReply)); assert.equal(f.contexts.length, 2);
  assert.match(f.contexts[1]!, /I feel fine/); assert.equal(f.states.at(-1)?.phase, 'complete'); assert.equal(f.released(), 1);
});
test('direct Mom request hands off once without redundant confirmation or AI', async () => {
  const text = "No, I'm a little dizzy, can you call my mom?"; assert.equal(explicitContactCallRequest(text), true);
  const f = fake([text]); await new AssistantConversation(f.deps).start();
  assert.deepEqual(f.handed, [text]); assert.equal(f.contexts.length, 0); assert.equal(f.spoken.length, text.toLowerCase().includes('dizzy') ? 2 : 1);
  assert.match(f.states.at(-1)?.message ?? '', /number is open/);
});
test('model contact flags only offer; ambiguous or declined consent never hands off', async () => {
  for (const answer of ['maybe', 'no thanks', 'silence']) {
    const f = fake(['I want help', answer], { interpret: async () => ({ status: 'success', processingTimeMs: 1,
      interpretation: { ...interpretation, requestsSavedEmergencyContact: true } }) });
    await new AssistantConversation(f.deps).start(); assert.equal(f.handed.length, 0); assert.match(f.spoken[1]!, /Would you like/);
  }
});
test('bare yes only authorizes in the contact-offer context', async () => {
  const f = fake(['yes', 'stop']); await new AssistantConversation(f.deps).start(); assert.equal(f.handed.length, 0);
  const g = fake(['support', 'yes please'], { interpret: async () => ({ status: 'success', processingTimeMs: 1,
    interpretation: { ...interpretation, requestsSavedEmergencyContact: true } }) });
  await new AssistantConversation(g.deps).start(); assert.deepEqual(g.handed, ['yes please']);
});
test('emergency-services mentions never become saved-contact consent', async () => {
  for (const text of ['call 911', 'do not call an ambulance']) {
    const f = fake([text]); await new AssistantConversation(f.deps).start(); assert.equal(f.handed.length, 0); assert.equal(f.contexts.length, 0);
  }
});
test('incomplete recognition cannot enter inference or consent', async () => {
  const f = fake([], { listen: async () => ({ ...captured('call Mom'), status: 'incomplete', isFinal: false }) });
  await new AssistantConversation(f.deps).start(); assert.equal(f.contexts.length, 0); assert.equal(f.handed.length, 0);
  assert.equal(f.states.at(-1)?.phase, 'error');
});
test('unsupported preparation touches neither audio nor handoff', async () => {
  const f = fake([], { prepare: async () => { throw new Error('unsupported_platform'); } });
  await new AssistantConversation(f.deps).start(); assert.equal(f.spoken.length, 0); assert.equal(f.handed.length, 0);
  assert.equal(f.released(), 0); assert.equal(f.states.at(-1)?.phase, 'error');
});
test('cancellation at each resource stage ignores late results', async () => {
  for (const kind of ['speech', 'listening', 'inference'] as const) {
    let resolve!: (value: any) => void, entered!: () => void;
    const ready = new Promise<void>(r => { entered = r; }); const pending = new Promise<any>(r => { resolve = r; });
    const f = fake(['fine'], {
      ...(kind === 'speech' ? { speak: async () => { entered(); await pending; } } : {}),
      ...(kind === 'listening' ? { listen: async () => { entered(); return pending; } } : {}),
      ...(kind === 'inference' ? { interpret: async () => { entered(); return pending; } } : {}),
      cancel: async () => { if (kind !== 'inference') resolve(captured('call Mom')); },
    });
    const c = new AssistantConversation(f.deps); const run = c.start(); await ready; await c.stop(); await run;
    resolve({ status: 'success', processingTimeMs: 1, interpretation }); await Promise.resolve();
    assert.equal(f.handed.length, 0); assert.equal(f.states.at(-1)?.phase, 'cancelled'); assert.equal(f.released(), 1);
  }
});
test('inference deadline cancels generation and releases ownership', async () => {
  const f = fake(['fine'], { interpret: () => new Promise(() => {}) }); await new AssistantConversation(f.deps, 15).start();
  assert.deepEqual(f.cancelled, ['inference']); assert.equal(f.states.at(-1)?.phase, 'error'); assert.equal(f.released(), 1);
});
test('overlap is refused and turn limit finishes', async () => {
  let resolve!: () => void; const f = fake(['fine', 'fine']); f.deps.prepare = () => new Promise<void>(r => { resolve = r; });
  const c = new AssistantConversation(f.deps, 1000, 2); const run = c.start(); await assert.rejects(c.start(), /already active/);
  await Promise.resolve(); resolve(); await run; assert.equal(f.contexts.length, 2); assert.equal(f.states.at(-1)?.phase, 'complete');
});
test('selected Zoe wins; missing preferences are never replaced silently', () => {
  const voices = [{ id: 'other-premium' }, { id: 'zoe-premium' }];
  assert.equal(selectAssistantVoice(voices, 'zoe-premium').id, 'zoe-premium');
  assert.throws(() => selectAssistantVoice(voices, 'missing'), /has not been replaced/); assert.throws(() => selectAssistantVoice([], null), /No installed/);
});
test('reply validation permits variation and rejects unsafe/out-of-domain statements', () => {
  assert.equal(conversationalReply(interpretation).usedFallback, false);
  for (const suggestedReply of ['You are having a heart attack.', 'Help is on the way.', 'Keep driving.', 'You are fine.',
    'I called Mom.', 'Take aspirin.', 'Try investing in stocks.', 'Do not pull over.']) {
    assert.equal(conversationalReply({ ...interpretation, suggestedReply }).usedFallback, true, suggestedReply);
  }
  assert.equal(conversationalReply({ ...interpretation, wellness: 'not_ok', suggestedReply: 'I hear you. Please pull over safely.' }).usedFallback, false);
});
test('safety waits for cleanup and excludes new optional work during handover', async () => {
  const arbiter = new AudioOwnership(); let stopStarted!: () => void, cleaned!: () => void;
  const stopping = new Promise<void>(r => { stopStarted = r; }); const cleanup = new Promise<void>(r => { cleaned = r; });
  const release = await arbiter.acquire('optional', async () => { stopStarted(); await cleanup; release(); });
  const safety = arbiter.acquire('safety', async () => {}); await stopping;
  await assert.rejects(arbiter.acquire('optional', async () => {}), /Safety/); cleaned(); const releaseSafety = await safety;
  await assert.rejects(arbiter.acquire('optional', async () => {}), /active/); releaseSafety();
  const end = await arbiter.acquire('optional', async () => {}); end();
});

test('actual platform and capability gates reject Android, unsupported models and missing offline support', () => {
  for (const platform of ['android', 'web', 'windows']) assert.throws(() => assertAssistantPlatform(platform, 'en'), /unavailable/);
  assert.throws(() => assertAssistantPlatform('ios', 'es'), /English/);
  assert.doesNotThrow(() => assertAssistantPlatform('ios', 'en'));
  const speech = { supportsOnDeviceRecognition: true, recognizerAvailable: true, message: 'offline unavailable' };
  for (const message of ['unsupported_os', 'device_not_eligible', 'native_module_missing', 'model_not_ready', 'apple_intelligence_not_enabled']) {
    assert.throws(() => assertAssistantCapabilities({ available: false, message }, speech), new RegExp(message));
  }
  for (const patch of [{ supportsOnDeviceRecognition: false }, { recognizerAvailable: false }]) {
    assert.throws(() => assertAssistantCapabilities({ available: true, message: '' }, { ...speech, ...patch }), /offline unavailable/);
  }
});

test('Stop retains ownership until native audio completion confirms cleanup', async () => {
  let entered!: () => void, finished!: () => void;
  const ready = new Promise<void>(r => { entered = r; });
  const playback = new Promise<void>(r => { finished = r; });
  const f = fake([], { speak: async () => { entered(); await playback; }, cancel: async () => {} });
  const c = new AssistantConversation(f.deps); const run = c.start(); await ready;
  const stop = c.stop(); await new Promise<void>(r => setImmediate(r));
  assert.equal(f.released(), 0, 'a cancellation request alone must not release live audio');
  finished(); await stop; await run; assert.equal(f.released(), 1); assert.equal(f.states.at(-1)?.phase, 'cancelled');
});

test('an advisory contact flag cannot override a deterministic contact refusal', async () => {
  const f = fake(['Do not call Mom', 'stop'], { interpret: async () => ({ status: 'success', processingTimeMs: 1,
    interpretation: { ...interpretation, requestsSavedEmergencyContact: true, explicitContactRequest: true } }) });
  await new AssistantConversation(f.deps).start();
  assert.equal(f.handed.length, 0);
  assert.ok(f.spoken.some(text => /won’t/.test(text)));
  assert.ok(f.spoken.every(text => !/Would you like/.test(text)));
});

const emptyFinalAfterPartial = (text: string): OfflineTranscription => ({ ...captured(text), status: 'incomplete',
  isFinal: false, partialTranscript: text, finalTranscript: '', finalResultReceived: true, hasFinalTranscript: false,
  reason: 'empty_final_after_partial', message: 'Response not confirmed.' });

test('partial-to-empty-final diagnostics survive failure and only one fresh capture is attempted', async () => {
  const ids: string[] = [];
  const f = fake([], { listen: async id => { ids.push(id); return emptyFinalAfterPartial('call Mom'); } });
  await new AssistantConversation(f.deps).start();
  assert.equal(ids.length, 2); assert.notEqual(ids[0], ids[1]);
  assert.equal(f.handed.length, 0); assert.equal(f.contexts.length, 0);
  assert.equal(f.states.at(-1)?.recognitionAttempts?.length, 2);
  assert.equal(f.states.at(-1)?.recognitionAttempts?.[0]?.result.partialTranscript, 'call Mom');
  assert.equal(f.states.at(-1)?.timings['listening-0-0'], 8);
  assert.ok(f.spoken.some(text => /wasn't confirmed/.test(text)));
  assert.match(f.states.at(-1)?.message ?? '', /not confirmed after the retry/);
});

test('only the fresh successful final direct request can authorize handoff after incomplete capture', async () => {
  let attempt = 0;
  const final = "No, I'm a little dizzy, can you call my mom?";
  const f = fake([], { listen: async () => ++attempt === 1 ? emptyFinalAfterPartial('call Mom') : captured(final) });
  await new AssistantConversation(f.deps).start();
  assert.deepEqual(f.handed, [final]); assert.equal(f.contexts.length, 0);
});

test('fresh final Yes please after a retry authorizes only an active spoken offer', async () => {
  for (const contactOffer of [false, true]) {
    let attempt = 0;
    const f = fake([], {
      listen: async () => {
        attempt++;
        if (contactOffer && attempt === 1) return captured('I want support');
        if (attempt === (contactOffer ? 2 : 1)) return emptyFinalAfterPartial('Yes please');
        if (attempt === (contactOffer ? 3 : 2)) return captured('Yes please');
        return captured('stop');
      },
      interpret: async () => ({ status: 'success', processingTimeMs: 1,
        interpretation: { ...interpretation, requestsSavedEmergencyContact: contactOffer } }),
    });
    await new AssistantConversation(f.deps).start();
    assert.deepEqual(f.handed, contactOffer ? ['Yes please'] : []);
  }
});

test('cancelling retry speech prevents another capture and any handoff', async () => {
  let entered!: () => void, finish!: () => void;
  const ready = new Promise<void>(r => { entered = r; });
  const speech = new Promise<void>(r => { finish = r; });
  let listens = 0;
  const f = fake([], {
    listen: async () => { listens++; return emptyFinalAfterPartial('Yes please'); },
    speak: async text => { if (/wasn't confirmed/.test(text)) { entered(); await speech; } },
    cancel: async () => { finish(); },
  });
  const c = new AssistantConversation(f.deps); const run = c.start(); await ready; await c.stop(); await run;
  assert.equal(listens, 1); assert.equal(f.handed.length, 0); assert.equal(f.states.at(-1)?.phase, 'cancelled');
});

test('a partial-only timeout gets one fresh attempt without treating partial words as consent', async () => {
  let listens = 0;
  const f = fake([], { listen: async () => {
    listens++;
    return { ...emptyFinalAfterPartial('Yes please'), status: 'timeout', reason: 'overall_timeout', finalResultReceived: false };
  } });
  await new AssistantConversation(f.deps).start();
  assert.equal(listens, 2); assert.equal(f.handed.length, 0); assert.equal(f.contexts.length, 0);
  assert.equal(f.states.at(-1)?.recognitionAttempts?.[0]?.result.status, 'timeout');
});

test('profile editor can await active conversation audio cleanup before proceeding', async () => {
  const audio = new AudioOwnership();
  let stopped = false;
  let release = () => {};
  release = await audio.acquire('optional', async () => { stopped = true; release(); });
  await audio.stopActive();
  assert.equal(stopped, true); assert.equal(audio.available, true);
});

test('new direct variants bypass AI and offers while handoff copy uses the saved name', async () => {
  for (const text of ["I'm a little dizzy, can you call my mom?", 'Can you call my mum?',
    "I'm a little dizzy, can you call my mom for me please?"]) {
    const f = fake([text], { contactName: () => 'Jamie', diagnostics: true });
    await new AssistantConversation(f.deps).start();
    assert.deepEqual(f.handed, [text]); assert.equal(f.contexts.length, 0); assert.equal(f.spoken.length, text.toLowerCase().includes('dizzy') ? 2 : 1);
    assert.ok(f.states.at(-1)?.message?.endsWith("Jamie's number is open. Tap Call to connect."));
    assert.deepEqual(f.states.at(-1)?.decisions?.[0], { acceptedFinalTranscript: text, normalizedText: text.toLowerCase().replace(/[^a-z' ]/g, '').replace(/\s+/g, ' '),
      direct: true, reason: 'explicit_request', callAnswer: 'yes', activeOffer: false, servicesExcluded: false, handoffOutcome: 'opened' });
  }
});

test('advisory offers use the saved name and do not report unused generated fallbacks', async () => {
  const f = fake(['I might want help', 'yes please'], { contactName: () => 'Jamie', diagnostics: true,
    interpret: async () => ({ status: 'success', processingTimeMs: 1,
      interpretation: { ...interpretation, wellness: 'not_ok', requestsSavedEmergencyContact: true, suggestedReply: 'I heard your request.' } }) });
  await new AssistantConversation(f.deps).start();
  assert.equal(f.spoken[1], "Please pull over when it's safe. Would you like to call Jamie?");
  assert.equal(f.states.at(-1)?.turns[0]?.fallback, undefined);
  assert.equal(f.states.at(-1)?.decisions?.[0]?.direct, false);
  assert.equal(f.states.at(-1)?.decisions?.[1]?.activeOffer, true);
  assert.equal(f.states.at(-1)?.decisions?.[1]?.handoffOutcome, 'opened');
  assert.deepEqual(f.handed, ['yes please']);
});

test('diagnostics default off and describe only accepted final words, never partial consent', async () => {
  const release = fake(['Call my mum']);
  await new AssistantConversation(release.deps).start();
  assert.equal(release.states.at(-1)?.decisions, undefined);
  let count = 0;
  const f = fake([], { diagnostics: true, listen: async () => ++count === 1 ? emptyFinalAfterPartial('call my mum') : captured('stop') });
  await new AssistantConversation(f.deps).start();
  assert.deepEqual(f.states.at(-1)?.decisions, []); assert.equal(f.handed.length, 0);
});

test('repeated model questions select a different safe follow-up, then a natural ending stops capture', async () => {
  const f = fake(['fine', 'still fine', 'stop']);
  await new AssistantConversation(f.deps).start();
  assert.notEqual(f.spoken[1], f.spoken[2]);
  assert.equal(f.states.at(-1)?.turns[1]?.fallbackReason, 'repeated_reply_or_question');
  let listens = 0;
  const ended = fake([], { listen: async () => { listens++; return captured('I feel comfortable'); },
    interpret: async () => ({ status: 'success', processingTimeMs: 1,
      interpretation: { ...interpretation, suggestedReply: 'Thanks for checking in.' } }) });
  await new AssistantConversation(ended.deps).start();
  assert.equal(listens, 1); assert.equal(ended.spoken.at(-1), 'Thanks for checking in.');
  assert.equal(ended.states.at(-1)?.phase, 'complete');
});

test('empathetic replies require safe guidance and continue to reject medical, action and driving promises', () => {
  const unwell = { ...interpretation, wellness: 'not_ok' as const };
  for (const suggestedReply of ["I'm sorry you're feeling dizzy. Please pull over when it's safe. Are you safely parked?",
    'That sounds uncomfortable. Please pull over safely. Is the discomfort getting better or worse?'])
    assert.equal(conversationalReply({ ...unwell, suggestedReply }).usedFallback, false, suggestedReply);
  for (const suggestedReply of ['I heard your request.', 'Please pull over.', "You're safe to drive. Please pull over safely.",
    'Your dizziness is a disease. Please pull over safely.', 'I called your contact. Please pull over safely.',
    'Please pull over safely. Take medication.', "You shouldn't stop. Please pull over safely."])
    assert.equal(conversationalReply({ ...unwell, suggestedReply }).usedFallback, true, suggestedReply);
});

test('curly apostrophes cannot conceal negated safe stopping advice', () => {
  for (const suggestedReply of ['Don’t pull over. Please pull over safely.', 'You shouldn’t stop. Please pull over safely.',
    'You should not stop. Please pull over safely.', 'You do not need to stop. Please pull over safely.',
    'Pull over when it is not safe.'])
    assert.equal(conversationalReply({ ...interpretation, wellness: 'not_ok', suggestedReply }).usedFallback, true, suggestedReply);
});

test('handoff outcomes remain truthful and errors offer an actionable next step', async () => {
  const { contactHandoffMessage, contactLabel, conversationStatus, conversationMessage } = await import('../modules/local-foundation-models/conversationPolicy.ts');
  assert.equal(contactLabel(null), 'your contact'); assert.equal(contactLabel('Mom 3055550123'), 'your contact');
  assert.equal(contactHandoffMessage('opened'), "Your contact's number is open. Tap Call to connect.");
  assert.match(contactHandoffMessage('missing_contact'), /Settings/);
  assert.match(contactHandoffMessage('invalid_phone'), /Settings/);
  assert.match(contactHandoffMessage('open_failed'), /Phone app/);
  assert.equal(conversationStatus('interpreting'), 'Thinking…');
  assert.equal(conversationStatus('phone interface'), 'Opening the number…');
  assert.match(conversationMessage('error', 'No successful final offline en-US transcript: no_speech')!, /confirm what you said/);
  assert.match(conversationMessage('error', 'generation_failed: internal native detail')!, /try again/i);
  for (const outcome of ['opened', 'missing_contact', 'invalid_phone', 'open_failed', 'cancelled', 'not_authorized']) {
    const f = fake(['call my mum'], { handoff: async () => outcome });
    await new AssistantConversation(f.deps).start();
    assert.equal(f.states.at(-1)?.phase, outcome === 'opened' ? 'complete' : 'error');
    assert.equal(f.states.at(-1)?.message, contactHandoffMessage(outcome));
    assert.ok(!/phone interface|saved emergency contact|call completed/i.test(f.states.at(-1)?.message ?? ''));
  }
});

test('dizziness alone receives deterministic safe guidance and a validated contact offer before contextual consent', async () => {
  const f = fake(["I'm a little dizzy", 'yes please'], { contactName: () => 'Jamie' });
  await new AssistantConversation(f.deps).start();
  assert.equal(f.contexts.length, 0);
  assert.equal(f.spoken[1], "Please pull over when it's safe. Would you like to call Jamie?");
  assert.deepEqual(f.handed, ['yes please']);
  assert.equal(f.spoken.filter(t => /pull over/.test(t)).length, 1);
});

test('dizziness with direct consent speaks guidance before handoff and never asks again', async () => {
  const events: string[] = [];
  const f = fake(["I'm a little dizzy, can you call my mum?"], {
    speak: async text => { events.push(text); }, handoff: async () => { events.push('handoff'); return 'opened'; },
  });
  await new AssistantConversation(f.deps).start();
  assert.deepEqual(events, ['How are you feeling?', "Please pull over when it's safe.", 'handoff']);
  assert.equal(f.contexts.length, 0);
});

test('symptoms and ambiguous requests offer a choice but never authorize without final contextual consent', async () => {
  for (const answer of ['maybe', 'no thanks', 'I am unsure']) {
    const f = fake(["I'm dizzy, maybe call my mom", answer]);
    await new AssistantConversation(f.deps).start();
    assert.ok(f.spoken[1]?.includes('pull over')); assert.ok(f.spoken[1]?.includes('Would you like to call'));
    assert.deepEqual(f.handed, []); assert.equal(f.contexts.length, 0);
  }
});

test('missing or invalid contacts never generate an offer; direct requests still use validated handoff', async () => {
  for (const unavailable of ['missing_contact', 'invalid_phone'] as const) {
    const symptomOnly = fake(["I'm feeling faint"], { contactAvailability: () => unavailable });
    await new AssistantConversation(symptomOnly.deps).start();
    assert.ok(symptomOnly.spoken.some(t => /pull over/.test(t) && /Settings/.test(t)));
    assert.ok(symptomOnly.spoken.every(t => !/Would you like to call/.test(t))); assert.deepEqual(symptomOnly.handed, []);
    const direct = fake(["I'm a little dizzy, call my mom"], { contactAvailability: () => unavailable,
      handoff: async () => unavailable });
    await new AssistantConversation(direct.deps).start();
    assert.equal(direct.spoken[1], "Please pull over when it's safe.");
    assert.match(direct.spoken[2]!, /Settings/); assert.equal(direct.states.at(-1)?.phase, 'error');
    const model = fake(['I want help'], { contactAvailability: () => unavailable,
      interpret: async () => ({ status: 'success', processingTimeMs: 1,
        interpretation: { ...interpretation, wellness: 'not_ok', requestsSavedEmergencyContact: true } }) });
    await new AssistantConversation(model.deps).start();
    assert.ok(model.spoken.some(t => /pull over/.test(t)));
    assert.ok(model.spoken.every(t => !/Would you like to call/.test(t))); assert.deepEqual(model.handed, []);
  }
});

test('guidance is not repeated for stable symptoms or recognition retries, but worsening receives renewed guidance', async () => {
  const stable = fake(["I'm dizzy, don't call Mom", "I'm still dizzy, don't call Mom", 'stop']);
  await new AssistantConversation(stable.deps).start();
  assert.equal(stable.spoken.filter(t => /pull over/.test(t)).length, 1);
  const worse = fake(["I'm dizzy, don't call Mom", "I'm getting worse", 'no thanks']);
  await new AssistantConversation(worse.deps).start();
  assert.equal(worse.spoken.filter(t => /pull over/.test(t)).length, 2);
  const answers = [captured("I'm dizzy"), emptyFinalAfterPartial('yes please'), captured('yes please')];
  const retry = fake([], { listen: async () => answers.shift()! });
  await new AssistantConversation(retry.deps).start();
  assert.equal(retry.spoken.filter(t => /pull over/.test(t)).length, 1);
  assert.deepEqual(retry.handed, ['yes please']);
});

test('cancelling during direct-request safety playback prevents handoff and waits for cleanup', async () => {
  let started!: () => void;
  const playing = new Promise<void>(resolve => { started = resolve; });
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const f = fake(["I'm dizzy, call my mom"], { speak: async text => {
    if (/pull over/.test(text)) { started(); await pending; }
  }, cancel: async () => { finish(); } });
  const conversation = new AssistantConversation(f.deps);
  const run = conversation.start(); await playing; await conversation.stop(); await run;
  assert.deepEqual(f.handed, []); assert.equal(f.states.at(-1)?.phase, 'cancelled'); assert.equal(f.released(), 1);
});

test('context-aware generated replies omit repeated guidance without accepting unsafe original wording', () => {
  const unwell = { ...interpretation, wellness: 'not_ok' as const };
  const response = conversationalReply({ ...unwell, suggestedReply: "That sounds uncomfortable. Please pull over when it's safe. Is the discomfort getting better or worse?" }, [], true);
  assert.equal(response.usedFallback, false); assert.ok(!response.text.includes('pull over'));
  assert.match(response.text, /discomfort getting better or worse/);
  assert.equal(conversationalReply({ ...unwell, suggestedReply: 'You should not pull over safely. How are you feeling?' }, [], true).usedFallback, true);
});

test('a refused contact offer is not repeated for stable symptoms, but a new explicit request remains valid', async () => {
  const f = fake(["I'm dizzy, don't call Mom", "I'm still dizzy", 'stop']);
  await new AssistantConversation(f.deps).start();
  assert.ok(f.spoken.every(t => !/Would you like to call/.test(t))); assert.deepEqual(f.handed, []);
  assert.notEqual(f.spoken[1], f.spoken[2]);
  const later = fake(["I'm dizzy, don't call Mom", 'Call my mum']);
  await new AssistantConversation(later.deps).start();
  assert.deepEqual(later.handed, ['Call my mum']);
  assert.equal(later.spoken.filter(t => /pull over/.test(t)).length, 1);
});

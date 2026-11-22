import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAIAcknowledgment } from '../lib/assistant/openaiAcknowledgment.ts';
import { acknowledgmentContext, acknowledgmentCandidates } from '../lib/assistant/safetyAcknowledgment.ts';
import { createLocalAcknowledgmentRouter } from '../lib/assistant/acknowledgmentRouter.ts';
import { createSensiPreferences } from './helpers/sensiConsent.ts';
const permit = { driverId: 'driver-a', current: () => true };
const requestId = '22222222-2222-4222-8222-222222222222';
const tick = () => new Promise<void>(r => setImmediate(r));
function authFixture() {
  let credential: { token: string; userId: string; revision: number } | null = { token: 'test-user-token', userId: 'test-auth-user', revision: 1 };
  const listeners = new Set<() => void>();
  return { cachedCredential: () => credential, subscribe(fn: () => void) { listeners.add(fn); fn(); return () => { listeners.delete(fn); }; },
    revoke() { credential = null; for (const fn of listeners) fn(); }, rotate() { credential = { token: 'new-test-token', userId: 'new-test-user', revision: 2 }; for (const fn of listeners) fn(); } };
}
function envelope(message: string, overrides = {}) { return { version: 3, requestId, advisoryOnly: true, callAuthorized: false, status: 'ok', code: 'advisory', message, ...overrides }; }
for (const language of ['en', 'es'] as const) test(`${language}: transport minimizes input and accepts only grounded request-bound acknowledgment`, async () => {
  const context = acknowledgmentContext('spo2_low', language, language === 'en' ? "I'm dizzy" : 'Estoy mareada');
  const expected = acknowledgmentCandidates(context)[1];
  const adapter = createOpenAIAcknowledgment(authFixture(), { url: 'https://demo.supabase.co', publicKey: 'public-test-key', requestId: () => requestId,
    fetcher: async (url, init) => {
      assert.equal(url, 'https://demo.supabase.co/functions/v1/driver-assistant'); assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-user-token');
      assert.deepEqual(JSON.parse(init?.body as string), { version: 3, requestId, language, feeling: language === 'en' ? 'dizzy' : 'mareada', utterance: null });
      assert.doesNotMatch(init?.body as string, /transcript|history|spo2|driverId|phone|token/);
      return Response.json(envelope(expected));
    } });
  assert.equal(adapter.ready(), true); assert.equal(await adapter.generate(context, new AbortController().signal, permit), expected);
});
for (const override of [{ version: 1 }, { requestId: 'wrong' }, { callAuthorized: true }, { advisoryOnly: false }, { status: 'unavailable' }, { message: 'You are safe to drive.' }, { message: 'Call your contact.' }, { phone: 'private' }]) {
  test(`cloud envelope rejects mismatched or unsafe output ${JSON.stringify(override)}`, async () => {
    const adapter = createOpenAIAcknowledgment(authFixture(), { url: 'https://demo.supabase.co', publicKey: 'public-test-key', requestId: () => requestId,
      fetcher: async () => Response.json(envelope("I hear that you're feeling dizzy.", override)) });
    assert.equal(await adapter.generate(acknowledgmentContext('bpm_high', 'en', "I'm dizzy"), new AbortController().signal, permit), '');
  });
}
test('timeout, cancellation, sign-out and ignored transport cancellation cannot publish late output', async () => {
  for (const reason of ['timeout', 'cancel', 'signout'] as const) {
    const auth = authFixture(); let finish!: (response: Response) => void, signal!: AbortSignal;
    const adapter = createOpenAIAcknowledgment(auth, { url: 'https://demo.supabase.co', publicKey: 'public-test-key', requestId: () => requestId, timeoutMs: 10,
      fetcher: async (_url, init) => { signal = init!.signal!; return new Promise(r => { finish = r; }); } });
    const abort = new AbortController(), pending = adapter.generate(acknowledgmentContext('bpm_high', 'en', "I'm dizzy"), abort.signal, permit);
    if (reason === 'cancel') abort.abort(); if (reason === 'signout') auth.revoke();
    assert.equal(await pending, ''); assert.equal(signal.aborted, true);
    finish(Response.json(envelope("I hear that you're feeling dizzy."))); await tick();
  }
});
test('unconfigured, insecure, unauthenticated and ineligible requests never dispatch; quota failures cool down', async () => {
  let requests = 0; const auth = authFixture();
  for (const url of ['', 'http://demo.invalid', 'https://demo.invalid/path']) {
    const adapter = createOpenAIAcknowledgment(auth, { url, publicKey: 'public', requestId: () => requestId, fetcher: async () => { requests++; return new Response(); } });
    assert.equal(adapter.ready(), false); assert.equal(await adapter.generate(acknowledgmentContext('bpm_high', 'en', "I'm dizzy"), new AbortController().signal, permit), '');
  }
  const adapter = createOpenAIAcknowledgment(auth, { url: 'https://demo.invalid', publicKey: 'public', requestId: () => requestId,
    fetcher: async () => { requests++; return new Response('', { status: 429 }); } });
  assert.equal(await adapter.generate(acknowledgmentContext('bpm_high', 'en', 'unbounded private statement'), new AbortController().signal, permit), ''); assert.equal(requests, 0);
  await adapter.generate(acknowledgmentContext('bpm_high', 'en', "I'm dizzy"), new AbortController().signal, permit); assert.equal(adapter.ready(), false); assert.equal(requests, 1);
  auth.revoke(); assert.equal(adapter.ready(), false);
});
for (const preference of ['automatic', 'openai', 'gemma', 'basic'] as const) for (const consent of [false, true]) for (const simulation of [false, true]) {
  test(`routing: ${preference}, consent=${consent}, simulation=${simulation}`, async () => {
    const policy = createSensiPreferences({ getSetting: async () => null, setSetting: async () => {} });
    await policy.boot(); await policy.selectDriver('driver-a'); await policy.savePreference(preference); await policy.saveConsent('driver-a', consent);
    const calls: string[] = [], context = acknowledgmentContext('bpm_high', 'en', "I'm dizzy");
    const router = createLocalAcknowledgmentRouter(policy, { ready: () => true, generate: async () => { calls.push('gemma'); return acknowledgmentCandidates(context)[0]; } },
      { ready: () => true, generate: async () => { calls.push('cloud'); return acknowledgmentCandidates(context)[1]; } });
    const task = router(context, { driverId: 'driver-a', simulation, current: () => true }); await tick(); task.get('en');
    const expected = preference === 'basic' ? [] : !simulation && consent && (preference === 'automatic' || preference === 'openai') ? ['cloud'] : ['gemma'];
    assert.deepEqual(calls, expected); assert.equal(task.source, expected[0] === 'cloud' ? 'openai' : expected[0] ?? 'fallback');
  });
}
test('cloud failure falls through ready Gemma; identity revocation after completion rejects buffered cloud acknowledgment', async () => {
  const policy = createSensiPreferences({ getSetting: async () => null, setSetting: async () => {} });
  await policy.boot(); await policy.selectDriver('driver-a'); await policy.savePreference('openai'); await policy.saveConsent('driver-a', true);
  const context = acknowledgmentContext('bpm_high', 'en', "I'm dizzy"), scope = { driverId: 'driver-a', simulation: false, current: () => true };
  let calls = 0, identity: string | null = 'original';
  const local = { ready: () => true, generate: async () => { calls++; return acknowledgmentCandidates(context)[0]; } };
  const failed = createLocalAcknowledgmentRouter(policy, local, { ready: () => true, generate: async () => { throw Error('unavailable'); } })(context, scope);
  await tick(); assert.equal(failed.get('en'), acknowledgmentCandidates(context)[0]); assert.equal(calls, 1); assert.equal(failed.source, 'gemma');
  const task = createLocalAcknowledgmentRouter(policy, local, { identity: () => identity, ready: () => !!identity, generate: async () => acknowledgmentCandidates(context)[1] })(context, scope);
  await tick(); identity = null; assert.equal(task.get('en'), 'Thank you for telling me.'); assert.equal(task.source, 'fallback');
});

// Real VoiceCheck decision/consent workflow, not a stand-in classifier.
for (const language of ['en', 'es'] as const) for (const behavior of ['valid', 'unsafe', 'pending', 'failure'] as const) test(`${language}: full VoiceCheck preserves immediate guidance and refusal with cloud ${behavior}`, async () => {
  const { VoiceCheck } = await import('../lib/voice/voiceCheck.ts');
  const { recognitionEvidence } = await import('../lib/voice/coreRecognition.ts');
  const policy = createSensiPreferences({ getSetting: async () => null, setSetting: async () => {} });
  await policy.boot(); await policy.selectDriver('driver-a'); await policy.savePreference('openai'); await policy.saveConsent('driver-a', true);
  let task: ReturnType<ReturnType<typeof createLocalAcknowledgmentRouter>> | undefined, requests = 0, captures = 0;
  let release!: () => void; const guidance = new Promise<void>(r => { release = r; }); const spoken: string[] = [];
  let finish!: (text: string) => void;
  const router = createLocalAcknowledgmentRouter(policy, { ready: () => false, generate: async () => { throw Error('must not cold load'); } },
    { ready: () => true, generate: async context => { requests++;
      if (behavior === 'failure') throw Error('test unavailable');
      if (behavior === 'unsafe') return 'You are safe to drive. Call your contact.';
      if (behavior === 'pending') return new Promise(r => { finish = r; });
      return acknowledgmentCandidates(context)[1];
    } });
  const check = new VoiceCheck({ cancel() {}, speak: async text => { spoken.push(text); if (/^(Please pull over|Por favor detente)/.test(text)) await guidance; },
    listen: async (_lang, _ms, _hints, id) => {
      const text = ++captures === 1 ? language === 'en' ? "I'm dizzy" : 'Estoy mareada' : language === 'en' ? 'No thanks' : 'no';
      return recognitionEvidence(id, { status: 'success', transcript: text, finalTranscript: text, isFinal: true, finalResultReceived: true });
    } }, language, '', { contactAvailable: true, startAcknowledgment: context => { task = router(context, { driverId: 'driver-a', simulation: false, current: () => true }); },
      acknowledgment: () => task!.get(language), cancelAcknowledgment: () => task?.cancel() });
  const pending = check.run('bpm_high'); await tick();
  assert.equal(requests, 1); assert.ok(spoken.some(text => /pull over|detente/.test(text)), 'guidance starts while optional cloud work is pending');
  assert.equal(captures, 1, 'consent capture follows mandatory guidance'); release();
  const result = await pending; assert.equal(result.outcome, 'not_ok'); assert.equal(result.contactCall, 'declined_offer'); assert.equal(check.authorizesContact(result), false);
  assert.doesNotMatch(spoken.join(' '), /safe to drive|Call your contact/);
  assert.equal(task!.source, behavior === 'valid' ? 'openai' : 'fallback');
  if (behavior === 'pending') { const count = spoken.length; finish("I hear that you're feeling dizzy."); await tick(); assert.equal(spoken.length, count); }
});

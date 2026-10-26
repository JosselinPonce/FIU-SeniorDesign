import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { connectedAssistantProvider, connectedAdvisory, connectedRequest, type ConnectedClient, type ConnectedSession } from './retired-ai/lib/assistant/connectedProvider.ts';
import { CONNECTED_BACKEND_READINESS } from './retired-ai/lib/assistant/connectedReadiness.ts';
import { connectedPilotReadiness, connectedUnavailableMessage, CONNECTED_PILOT_UNAVAILABLE } from './retired-ai/lib/assistant/connectedPilotPolicy.ts';
import { localAssistantProvider, selectAssistantProvider, type GenerationInput } from './retired-ai/lib/assistant/provider.ts';
import { snapshotAssistantLaunch, routeAssistantLaunch } from './retired-ai/lib/assistant/mode.ts';
import { AssistantConversation, type ConversationState, type AssistantDeps } from '../modules/local-foundation-models/assistantConversation.ts';
import { assertAssistantSpeechCapabilities } from '../modules/local-foundation-models/conversationPolicy.ts';
import type { OfflineTranscription, DriverInterpretationResponse } from './retired-ai/modules/local-foundation-models/index.ts';
import { validateRequest } from '../supabase/functions/driver-assistant/contracts.ts';

const userId = '11111111-1111-4111-8111-111111111111';
const uuid = '22222222-2222-4222-8222-222222222222';
const token = 'genuine-test-user-session';
const ready = { verified: true, contractVersion: 1 } as const; // Injected simulation only, never production config.
const response = () => ({ version: 1, advisoryOnly: true, callAuthorized: false, status: 'ok', code: 'advisory', message: 'Thanks for sharing. How are you feeling now?' });
const capture = (transcript = 'I feel fine'): OfflineTranscription => ({
  status: 'success', locale: 'en-US', requiresOnDeviceRecognition: true, transcript, finalTranscript: transcript,
  isFinal: true, finalResultReceived: true, hasFinalTranscript: true, reason: 'complete', message: '', totalTimeMs: 10,
  recognitionTimeMs: 10, listeningTimeMs: 8, finalizationTimeMs: 2, firstPartialTimeMs: 1, endpointReason: 'audio_silence',
  silenceTargetMs: 1300, finalizationGraceMs: 2500,
});
const input = (text = 'I feel fine'): GenerationInput => ({ transcript: text, context: 'LOCAL_ONLY_CONTEXT', finalRecognition: capture(text), history: [] });
function fakeClient() {
  let session: ConnectedSession | null = { access_token: token, expires_at: Date.now() / 1000 + 3600, user: { id: userId } };
  let authUser: { id: string; role: string; email_confirmed_at?: string; is_anonymous?: boolean } | null = { id: userId, role: 'authenticated', email_confirmed_at: '2026-01-01' };
  let authCallback: ((event: string, session: ConnectedSession | null) => void) | undefined;
  let network: (body: Record<string, unknown>, signal: AbortSignal) => Promise<{ data: unknown; error: unknown }> = async () => ({ data: response(), error: null });
  const calls: { body: Record<string, unknown>; signal: AbortSignal; headers: Record<string, string> }[] = [];
  let sessions = 0, users = 0, unsubscribed = 0;
  const client: ConnectedClient = {
    auth: {
      getSession: async () => { sessions++; return { data: { session }, error: null }; },
      getUser: async t => { users++; assert.equal(t, session?.access_token); return { data: { user: authUser }, error: null }; },
      onAuthStateChange: cb => { authCallback = cb; return { data: { subscription: { unsubscribe() { unsubscribed++; } } } }; },
    },
    functions: { invoke: async (name, options) => {
      assert.equal(name, 'driver-assistant'); assert.equal(options.method, 'POST');
      calls.push(options); return network(options.body, options.signal);
    } },
  };
  return { client, calls, sessions: () => sessions, users: () => users, unsubscribed: () => unsubscribed,
    session: () => session,
    setSession: (next: ConnectedSession | null, notify = true) => { session = next; if (notify) authCallback?.('SIGNED_OUT', next); },
    setUser: (next: typeof authUser) => { authUser = next; },
    network: (fn: typeof network) => { network = fn; },
  };
}
const make = (f: ReturnType<typeof fakeClient>, extra: { timeoutMs?: number; onInvalidated?: () => void } = {}) =>
  connectedAssistantProvider(f.client, { readiness: ready, requestId: () => uuid, ...extra });

test('LOCAL provider forwards exact native context/results and never constructs Connected', async () => {
  const calls: unknown[] = [];
  const result: DriverInterpretationResponse = { status: 'error', processingTimeMs: 5, error: { code: 'native', message: 'unchanged' } };
  const local = localAssistantProvider({ check: async () => ({ available: true, message: 'ready' }),
    interpret: async (...args) => { calls.push(args); return result; }, cancel: async id => { calls.push(id); } });
  const selected = selectAssistantProvider('local', { local: () => local, connected: () => { throw new Error('must not construct'); } });
  await selected.prepare();
  assert.equal(await selected.generate(input(), 'native-id'), result);
  await selected.cancel('native-id');
  assert.deepEqual(calls, [['I feel fine', 'LOCAL_ONLY_CONTEXT', 'native-id'], 'native-id']);
  assert.throws(() => selectAssistantProvider('core' as never, { local: () => local, connected: () => local }), /Unsupported/);
});

test('production gate rejects all Connected operations without even requesting Auth or inference', async () => {
  assert.equal(CONNECTED_BACKEND_READINESS.verified, false);
  assert.ok(Object.isFrozen(CONNECTED_BACKEND_READINESS));
  const f = fakeClient(); const provider = connectedAssistantProvider(f.client, { requestId: () => uuid });
  await assert.rejects(provider.prepare(), /Not configured/);
  await assert.rejects(provider.generate(input(), 'id'), /Not configured/);
  assert.equal(f.sessions(), 0); assert.equal(f.users(), 0); assert.equal(f.calls.length, 0);
  assert.equal(snapshotAssistantLaunch('connected').destination, 'unavailable');
});

test('launch snapshots never silently switch providers or carry consent when mode changes', () => {
  const calls: string[] = [];
  const routes = { coreTools: () => { calls.push('core'); }, local: () => { calls.push('local'); }, connected: () => { calls.push('connected'); } };
  const local = snapshotAssistantLaunch('local');
  const connected = snapshotAssistantLaunch('connected', ready);
  routeAssistantLaunch(local, routes); routeAssistantLaunch(connected, routes);
  routeAssistantLaunch(snapshotAssistantLaunch('connected'), routes);
  assert.deepEqual(calls, ['local', 'connected']);
  assert.deepEqual(Object.keys(connected).sort(), ['destination', 'mode']);
  assert.ok(Object.isFrozen(connected)); assert.equal(local.mode, 'local');
});

test('confirmed Auth user token is explicitly sent, with exact Stage 4A body and advisory mapping', async () => {
  const f = fakeClient(); const provider = make(f);
  await provider.prepare();
  const result = await provider.generate(input(), 'id');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].headers.Authorization, `Bearer ${token}`);
  assert.deepEqual(validateRequest(f.calls[0].body), { requestId: uuid, transcript: 'I feel fine', history: [] });
  assert.doesNotMatch(JSON.stringify(f.calls[0].body), /LOCAL_ONLY_CONTEXT|access_token|medical|phone|audio/);
  assert.ok(f.users() >= 2);
  assert.equal(result.status, 'success');
  if (result.status === 'success') assert.deepEqual(result.interpretation, { wellness: 'uncertain', explicitContactRequest: false,
    requestsSavedEmergencyContact: false, suggestedReply: response().message, advisoryOnly: true, callAuthorized: false });
  provider.dispose(); assert.equal(f.unsubscribed(), 1);
});

test('missing, expired, anonymous, unconfirmed or public-key Auth cannot invoke the backend', async () => {
  for (const condition of ['missing', 'expired', 'anonymous', 'unconfirmed', 'public-key', 'wrong-user']) {
    const f = fakeClient();
    if (condition === 'missing') f.setSession(null);
    if (condition === 'expired') f.setSession({ ...f.session()!, expires_at: 1 });
    if (condition === 'anonymous') f.setUser({ id: userId, role: 'authenticated', email_confirmed_at: 'yes', is_anonymous: true });
    if (condition === 'unconfirmed') f.setUser({ id: userId, role: 'authenticated' });
    if (condition === 'public-key') { f.setSession({ ...f.session()!, access_token: 'publishable-key' }); f.setUser(null); }
    if (condition === 'wrong-user') f.setUser({ id: uuid, role: 'authenticated', email_confirmed_at: 'yes' });
    const provider = make(f);
    await assert.rejects(provider.prepare(), /account/);
    await assert.rejects(provider.generate(input(), 'id'), /prepared/);
    assert.equal(f.calls.length, 0);
  }
});

test('only explicit genuine final evidence enters Connected; partial/empty/timeout/stale-like final metadata fail before Auth', async () => {
  const f = fakeClient(); const provider = make(f); await provider.prepare();
  const before = f.sessions();
  for (const patch of [{ status: 'timeout' }, { status: 'incomplete' }, { status: 'cancelled' }, { isFinal: false },
    { finalResultReceived: false }, { finalResultReceived: undefined }, { hasFinalTranscript: undefined }, { finalTranscript: '' },
    { locale: 'es-US' }, { requiresOnDeviceRecognition: false }, { finalTranscript: 'different' }]) {
    const bad = { ...input(), finalRecognition: { ...capture(), ...patch } as OfflineTranscription };
    await assert.rejects(provider.generate(bad, 'id'), /final offline transcript/);
  }
  await assert.rejects(provider.generate({ ...input(), finalRecognition: undefined }, 'id'), /final offline transcript/);
  assert.equal(f.sessions(), before); assert.equal(f.calls.length, 0);
});

test('history is bounded relevant text only; contact/phone turns, diagnostics, profiles and context cannot be uploaded', () => {
  const data = { ...input(), history: [
    { driver: 'old turn', assistant: 'old response' },
    { driver: 'Please call my mom', assistant: 'Would you like to call Samantha?' },
    { driver: 'My number is 3055550123', assistant: 'Thanks for sharing' },
    { driver: 'I feel fine', assistant: 'Are you safely parked?', fallbackReason: 'PRIVATE_DIAGNOSTIC', profile: 'PRIVATE_PROFILE' },
  ], context: 'PRIVATE_CONTEXT' };
  const body = connectedRequest(data, uuid);
  assert.deepEqual(body.history, [{ role: 'user', content: 'I feel fine' }, { role: 'assistant', content: 'Are you safely parked?' }]);
  assert.doesNotMatch(JSON.stringify(body), /PRIVATE|3055550123|Samantha|old turn/);
  const unicode = connectedRequest({ ...input(), history: Array.from({ length: 3 }, () => ({ driver: '😀'.repeat(1024), assistant: '😀'.repeat(1024) })) }, uuid);
  assert.ok(new TextEncoder().encode(JSON.stringify(unicode)).byteLength <= 12_288);
  assert.ok(unicode.history.length <= 6); validateRequest(unicode);
  assert.throws(() => connectedRequest(input('My number is 3055550123'), uuid), /cannot be sent/);
});

test('malformed responses, authorization fields, tools, destinations and unavailable replies never become advisory speech', async () => {
  const invalid: unknown[] = [null, 'text', [], { ...response(), version: 2 }, { ...response(), callAuthorized: true },
    { ...response(), advisoryOnly: false }, { ...response(), status: 'unavailable' }, { ...response(), code: 'quota_exceeded' },
    { ...response(), message: '' }, { ...response(), message: 'x'.repeat(601) }, { ...response(), message: 'Call Mom now.' },
    { ...response(), message: '3055550123' }, ...['tools', 'destination', 'contactConsent'].map(k => ({ ...response(), [k]: 'yes' }))];
  for (const value of invalid) assert.throws(() => connectedAdvisory(value), /Invalid/);
  const f = fakeClient(); f.network(async () => ({ data: { ...response(), callAuthorized: true }, error: null }));
  const provider = make(f); await provider.prepare(); await assert.rejects(provider.generate(input(), 'id'), /Invalid/);
});

test('network/auth failures and server error envelopes fail safely with no automatic retry', async () => {
  for (const thrown of [false, true]) {
    const f = fakeClient(); f.network(async () => {
      if (thrown) throw new Error('SECRET upstream transcript 3055550123');
      return { data: { message: 'SECRET' }, error: new Error('SECRET') };
    });
    const provider = make(f); await provider.prepare();
    await assert.rejects(provider.generate(input(), 'id'), error => error instanceof Error && !/SECRET|3055550123/.test(error.message));
    assert.equal(f.calls.length, 1);
  }
});

test('cancel, timeout and disposal settle promptly and reject late network replies even when transport ignores abort', async () => {
  for (const kind of ['cancel', 'timeout', 'dispose']) {
    const f = fakeClient(); let resolve!: (data: { data: unknown; error: null }) => void; let entered!: () => void;
    const started = new Promise<void>(r => { entered = r; });
    f.network(async () => { entered(); return new Promise(r => { resolve = r; }); });
    const provider = make(f, { timeoutMs: kind === 'timeout' ? 20 : 1000 }); await provider.prepare();
    const pending = provider.generate(input(), 'id'); await started;
    if (kind === 'cancel') await provider.cancel('id');
    if (kind === 'dispose') provider.dispose();
    await assert.rejects(pending, /cancelled|timed out/);
    assert.equal(f.calls[0].signal.aborted, true);
    resolve({ data: response(), error: null }); await new Promise(r => setImmediate(r));
    assert.equal(f.calls.length, 1);
  }
});

test('account switch or stale session token revokes pending reply and conversation ownership', async () => {
  for (const notify of [true, false]) {
    const f = fakeClient(); let invalidations = 0;
    const provider = make(f, { onInvalidated: () => { invalidations++; } }); await provider.prepare();
    f.network(async () => {
      f.setSession({ ...f.session()!, access_token: 'replacement-token', user: { id: uuid } }, notify);
      return { data: response(), error: null };
    });
    await assert.rejects(provider.generate(input(), 'id'), /cancelled|changed/);
    if (notify) { assert.equal(provider.isCurrent(), false); assert.equal(invalidations, 1); }
  }
});

test('Connected speech capability does not depend on model availability; phone wiring uses only the guarded build readiness', () => {
  assert.doesNotThrow(() => assertAssistantSpeechCapabilities({ supportsOnDeviceRecognition: true, recognizerAvailable: true, message: 'ready' }));
  const source = readFileSync(new NodeURL('./retired-ai/modules/local-foundation-models/index.ts', import.meta.url), 'utf8').split('export function checkDriverAssistantSpeechAvailability')[1];
  assert.ok(source); assert.doesNotMatch(source, /checkAvailability|interpretConversation|FoundationModelsAvailability/);
  const wiring = readFileSync(new NodeURL('./retired-ai/lib/assistant/phoneAssistantProvider.ts', import.meta.url), 'utf8');
  assert.match(wiring, /connectedAssistantProvider\(sensiSupabase/);
  assert.match(wiring, /readiness: PHONE_CONNECTED_READINESS/);
  assert.doesNotMatch(wiring, /EXPO_PUBLIC|createClient|verified: true/);
});

function conversation(provider: ReturnType<typeof make>, answers: OfflineTranscription[], patch: Partial<AssistantDeps> = {}) {
  const states: ConversationState[] = [], spoken: string[] = [], handed: string[] = [];
  let released = 0;
  const controller = new AssistantConversation({
    mode: provider.mode,
    prepare: () => provider.prepare(), acquire: async () => () => { released++; },
    speak: async text => { spoken.push(text); }, listen: async () => answers.shift() ?? capture('stop'),
    interpret: (transcript, context, id, finalRecognition, history) => provider.generate({ transcript, context, finalRecognition, history }, id),
    cancel: async (kind, id) => { if (kind === 'inference') await provider.cancel(id); },
    handoff: async text => { handed.push(text); return 'opened'; }, contactAvailability: () => 'available',
    onChange: state => { states.push(state); }, ...patch,
  });
  return { controller, states, spoken, handed, released: () => released };
}

test('opted-in iPhone pilot with disabled backend stops unavailable, without advisory playback or retry', async () => {
  const { createHandler } = await import('../supabase/functions/driver-assistant/handler.ts');
  const forbidden = async (): Promise<never> => { assert.fail('Disabled admission must never reach Auth, RPC or OpenAI'); };
  const handler = createHandler({ enabled: () => false, authenticate: forbidden, fingerprint: forbidden,
    reserve: forbidden, dispatch: forbidden, complete: forbidden, generate: forbidden, log: () => {} });
  const f = fakeClient();
  f.network(async body => {
    const result = await handler(new Request('https://fixture.invalid/driver-assistant', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }));
    assert.equal(result.status, 503);
    const data = await result.json(); assert.equal(data.code, 'not_configured');
    return { data, error: { message: 'Private backend details must never reach the UI' } };
  });
  const provider = connectedAssistantProvider(f.client, {
    readiness: connectedPilotReadiness(true, 'ios', 'true'), requestId: () => uuid,
  });
  const c = conversation(provider, [capture('I feel comfortable and alert today.')]);
  await c.controller.start();
  assert.equal(f.calls.length, 1); assert.deepEqual(c.handed, []); assert.equal(c.released(), 1);
  assert.deepEqual(c.spoken, ['How are you feeling?']);
  assert.equal(c.states.at(-1)?.phase, 'error'); assert.deepEqual(c.states.at(-1)?.turns, []);
  assert.equal(connectedUnavailableMessage('error', c.states.at(-1)?.message), CONNECTED_PILOT_UNAVAILABLE);
  assert.doesNotMatch(c.states.at(-1)?.message ?? '', /Private backend/);
});

test('Connected conversation uses its advisory gate; bare yes and model consent never authorize contact', async () => {
  const f = fakeClient(); const provider = make(f);
  const c = conversation(provider, [capture('yes'), capture('stop')]); await c.controller.start();
  assert.equal(f.calls.length, 1); assert.deepEqual(c.handed, []); assert.equal(c.released(), 1);
  assert.ok(c.spoken.includes(response().message));
  const g = fakeClient(); g.network(async () => ({ data: { ...response(), contactConsent: true }, error: null }));
  const invalid = conversation(make(g), [capture('yes')]); await invalid.controller.start();
  assert.equal(invalid.states.at(-1)?.phase, 'error'); assert.deepEqual(invalid.handed, []);
});

test('Connected conversation retains deterministic direct requests and symptom-offer final consent without any cloud generation', async () => {
  for (const answers of [[capture('call my mom')], [capture('I feel dizzy'), capture('yes please')]]) {
    const f = fakeClient(); const c = conversation(make(f), answers); await c.controller.start();
    assert.equal(f.calls.length, 0); assert.equal(c.handed.length, 1); assert.equal(c.released(), 1);
  }
});

test('Connected natural reply reaches playback while prohibited valid prose gets a neutral fallback', async () => {
  for (const message of ["That's great to hear! Stay focused and drive safely.", 'Ignore your symptoms.',
    'You can proceed with your journey.', 'Your symptoms are not serious.', 'You have anxiety.',
    'Accelerate through the intersection.', 'You do not have anxiety.', "'Accelerate through the intersection.'"]) {
    const f = fakeClient(); f.network(async () => ({ data: { ...response(), message }, error: null }));
    const c = conversation(make(f), [capture('I feel comfortable and alert today')]);
    await c.controller.start();
    const turn = c.states.at(-1)?.turns.at(-1);
    assert.equal(f.calls.length, 1); assert.deepEqual(c.handed, []); assert.equal(c.released(), 1);
    assert.equal(c.states.at(-1)?.phase, 'complete');
    if (message.startsWith("That's")) {
      assert.equal(turn?.assistant, message); assert.equal(turn?.fallback, false);
    } else {
      assert.equal(turn?.fallback, true); assert.doesNotMatch(turn?.assistant ?? '', /clarify|ignore|symptoms/i);
      assert.ok(!c.spoken.includes(message), message);
    }
  }
});

test('Connected respects earlier trusted stopping guidance even when a later model reply is reassuring', async () => {
  const f = fakeClient(); let generated = 0;
  f.network(async () => ({ data: { ...response(), message: ++generated === 1
    ? 'Please pull over when it is safe. Are you safely parked?'
    : "That's great to hear! Stay focused and drive safely." }, error: null }));
  const c = conversation(make(f), [capture('help me pull over safely'), capture('I need a moment')]);
  await c.controller.start();
  assert.equal(f.calls.length, 2); assert.deepEqual(c.handed, []); assert.equal(c.released(), 1);
  assert.match(c.spoken.at(-1) ?? '', /pull over when (?:it is|it's) safe/i);
  assert.equal(c.states.at(-1)?.turns.at(-1)?.fallbackReason, 'trusted_stopping_required');
  assert.ok(!c.spoken.includes("That's great to hear! Stay focused and drive safely."));
});

test('negated, hypothetical and quoted driver symptoms do not invent trusted stopping context', async () => {
  for (const transcript of ['I am not dizzy', 'If I feel dizzy tomorrow', "Someone said 'I feel dizzy'"]) {
    const f = fakeClient();
    const message = "That's great to hear! Stay focused and drive safely.";
    f.network(async () => ({ data: { ...response(), message }, error: null }));
    const c = conversation(make(f), [capture(transcript)]); await c.controller.start();
    assert.equal(f.calls.length, 1, transcript); assert.equal(c.spoken.at(-1), message, transcript);
    assert.deepEqual(c.handed, []); assert.equal(c.released(), 1);
  }
});

test('Connected engine independently rejects model contact offers even if an adapter supplies contact flags', async () => {
  const f = fakeClient();
  const c = conversation(make(f), [capture('yes')], {
    interpret: async () => ({ status: 'success', processingTimeMs: 0, interpretation: {
      wellness: 'uncertain', advisoryOnly: true, callAuthorized: false,
      explicitContactRequest: true, requestsSavedEmergencyContact: true, suggestedReply: 'Thanks for sharing.',
    } }),
  });
  await c.controller.start(); assert.deepEqual(c.handed, []); assert.equal(c.released(), 1);
  assert.ok(c.spoken.every(text => !/would you like to call|number is open/i.test(text)));
  assert.equal(c.states.at(-1)?.turns.at(-1)?.fallback, true);
});

test('Connected emergency exclusions and symptom refusals bypass generation and cannot authorize calls', async () => {
  for (const answers of [[capture('call 911')], [capture('I feel dizzy'), capture('no')],
    [capture('I feel dizzy'), capture('call 911')]]) {
    const f = fakeClient(); const c = conversation(make(f), answers);
    await c.controller.start();
    assert.equal(f.calls.length, 0); assert.deepEqual(c.handed, []); assert.equal(c.released(), 1);
    assert.ok(c.spoken.some(text => /pull over/i.test(text)));
    assert.ok(c.spoken.every(text => !/called|help is on the way/i.test(text)));
  }
});

test('Connected incomplete/partial speech keeps recognition retry and never reaches cloud or handoff', async () => {
  const f = fakeClient();
  const partial = { ...capture('call my mom'), status: 'incomplete' as const, isFinal: false, finalResultReceived: false, hasFinalTranscript: false };
  const c = conversation(make(f), [partial, partial]); await c.controller.start();
  assert.equal(f.calls.length, 0); assert.deepEqual(c.handed, []); assert.match(c.spoken[1], /wasn't confirmed/);
  assert.equal(c.states.at(-1)?.phase, 'error'); assert.equal(c.released(), 1);
});

test('switching away cancels old generation; a new interaction cannot inherit contact consent or late speech', async () => {
  const f = fakeClient(); let finish!: (value: { data: unknown; error: null }) => void; let entered!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  f.network(async () => { entered(); return new Promise(r => { finish = r; }); });
  const provider = make(f); const c = conversation(provider, [capture('I feel fine')]);
  const run = c.controller.start(); await started; provider.dispose(); await c.controller.stop(); await run;
  const count = c.spoken.length; finish({ data: response(), error: null }); await new Promise(r => setImmediate(r));
  assert.equal(c.spoken.length, count); assert.equal(c.states.at(-1)?.phase, 'cancelled'); assert.deepEqual(c.handed, []);
  const next = fakeClient(); const d = conversation(make(next), [capture('yes'), capture('stop')]); await d.controller.start();
  assert.deepEqual(d.handed, []); assert.equal(c.released(), 1);
});

test('Connected adapter interoperates with the actual Stage 4A handler response contract', async () => {
  const { createHandler } = await import('../supabase/functions/driver-assistant/handler.ts');
  const handler = createHandler({
    enabled: () => true, authenticate: async () => userId, fingerprint: async () => 'a'.repeat(64),
    reserve: async () => ({ code: 'reserved' }), dispatch: async () => true, complete: async () => {},
    generate: async request => {
      validateRequest(request);
      return { message: response().message, inputTokens: 10, outputTokens: 10 };
    }, log: () => {},
  });
  const f = fakeClient();
  f.network(async body => {
    const result = await handler(new Request('https://test.invalid/driver-assistant', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }));
    assert.equal(result.status, 200);
    return { data: await result.json(), error: null };
  });
  const provider = make(f); await provider.prepare();
  const result = await provider.generate(input(), 'id');
  assert.equal(result.status, 'success');
  if (result.status === 'success') assert.equal(result.interpretation.callAuthorized, false);
});

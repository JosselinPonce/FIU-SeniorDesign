import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { createSensiPreferences } from './helpers/sensiConsent.ts';
import { SENSI_PREFERENCE_KEY, type SensiPreference } from '../lib/assistant/sensiPreferences.ts';
import { createLocalAcknowledgmentRouter } from '../lib/assistant/acknowledgmentRouter.ts';
import { acknowledgmentCandidates, acknowledgmentContext } from '../lib/assistant/safetyAcknowledgment.ts';
import { createOpenAIAcknowledgment } from '../lib/assistant/openaiAcknowledgment.ts';
import { SafetyController, type SafetyState } from '../lib/analysis/safetyController.ts';
import { VoiceCheck } from '../lib/voice/voiceCheck.ts';
import { recognitionEvidence } from '../lib/voice/coreRecognition.ts';
import type { ConversationMessage } from '../modules/local-foundation-models/assistantConversation.ts';
import { light } from '../lib/theme/tokens.ts';

const require = createRequire(import.meta.url);
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const code = ts.transpileModule(readFileSync(new NodeURL('../components/LiveSensiProvider.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const flatten = (node: any): any[] => Array.isArray(node) ? node.flatMap(flatten)
  : node && typeof node === 'object' ? [node, ...flatten(node.props.children)] : [];

async function fixture(initial: SensiPreference) {
  const store = new Map([[SENSI_PREFERENCE_KEY, initial as string]]);
  const policy = createSensiPreferences({
    getSetting: async key => store.get(key) ?? null,
    setSetting: async (key, value) => { store.set(key, value); },
  });
  await policy.boot();
  await policy.selectDriver('fixture-driver');
  const status = { auth: 'signed_out', terms: true, gemmaReady: false, preparing: false, cloudReady: false, file: 'present',
    runtime: { busy: false, installed: false, phase: 'Idle', error: '', cleanupRequired: false } };
  const state: any[] = [];
  let index = 0;
  const deps: Record<string, unknown> = {
    react: {
      useMemo: (read: () => unknown) => read(),
      useState(value: any) {
        const slot = index++;
        state[slot] ??= value;
        return [state[slot], (next: any) => { state[slot] = typeof next === 'function' ? next(state[slot]) : next; }];
      },
      useRef(value: any) { return state[index++] ??= { current: value }; },
      useSyncExternalStore(_subscribe: unknown, get: () => unknown) { return get(); },
    },
    'react/jsx-runtime': require('react/jsx-runtime'),
    'react-native': { View: 'View', ScrollView: 'ScrollView' },
    '../lib/i18n/native': { LocalizedPressable: 'Pressable', LocalizedText: 'Text' },
    'expo/node_modules/@expo/vector-icons/Feather': { default: 'Feather' },
    '../lib/assistant/phoneSensiRouting': { sensiPreferences: policy,
      isOpenAIAcknowledgmentReady: () => status.cloudReady,
      isGemmaPreparing: () => status.preparing, subscribeGemmaPreparation: () => () => {},
      isPhoneGemmaAcknowledgmentReady: () => status.gemmaReady },
    '../lib/assistant/phoneCloudAuth': { sensiCloudAuth: { get state() { return { status: status.auth }; } } },
    '../lib/onboarding/phone': { sensiSetup: { get state() { return { terms: status.terms }; } } },
    '../modules/gemma-poc/phone': { gemmaPoc: { get state() { return status.runtime; } }, inspectGemmaModelFile: () => status.file, subscribeGemmaReadiness: () => () => {} },
    '../lib/theme/ThemeProvider': { useTheme: () => ({ tokens: light }) },
  };
  const exports: any = {};
  new Function('require', 'exports', code)((key: string) => { assert.ok(key in deps, key); return deps[key]; }, exports);
  function render(messages: readonly ConversationMessage[] = [], compact = false, cloudRestricted = false) {
    index = 0;
    return flatten(exports.LiveSensiProvider({ messages, compact, driverId: 'fixture-driver', cloudRestricted }));
  }
  function pick(label: string) {
    render().find(node => node.props.accessibilityRole === 'button').props.onPress();
    render().find(node => node.props.accessibilityRole === 'radio'
      && node.props.children.props.children === label).props.onPress();
  }
  return { policy, store, render, pick, status };
}

const actual = (nodes: any[]) => nodes.find(node => node.props.children?.[0] === 'Last acknowledgment: ')
  ?.props.children[1].props.children;
const message = (source?: ConversationMessage['acknowledgmentSource'], playback: ConversationMessage['playback'] = 'completed',
  id = 'ack'): ConversationMessage => ({ id, role: 'assistant', text: 'Fixture text', playback, acknowledgmentSource: source });

test('selector reads the persisted mode and writes only via the preference store', async () => {
  const f = await fixture('basic');
  assert.ok(f.render().some(node => node.props.children === 'Basic Offline'));
  assert.equal(actual(f.render()), 'None yet');
  f.pick('OpenAI');
  await tick();
  assert.equal(f.store.get(SENSI_PREFERENCE_KEY), 'openai');
  assert.equal(f.policy.state.consent, false);
  assert.equal(f.store.size, 1);
  assert.equal(actual(f.render()), 'None yet');
});

test('only completed acknowledgment provenance is reported, with no carry-over to a new episode', async () => {
  const f = await fixture('openai');
  assert.equal(actual(f.render([message(undefined), message('openai', 'playing', 'active')])), 'None yet');
  assert.equal(actual(f.render([message('gemma'), message('openai', 'failed', 'failed'), message(undefined, 'completed', 'guidance')])), 'Gemma');
  assert.equal(actual(f.render([message('openai'), message('unknown', 'completed', 'unknown')])), 'Unknown');
  assert.equal(actual(f.render([])), 'None yet');
});

test('compact expanded options stay bounded while provider provenance remains visible', async () => {
  const f = await fixture('openai');
  const messages = [message('fallback')];
  f.render(messages, true).find(node => node.props.accessibilityRole === 'button').props.onPress();
  const expanded = f.render(messages, true);
  const menu = expanded.find(node => node.type === 'ScrollView');
  assert.equal(menu.props.style.maxHeight, 64);
  assert.equal(flatten(menu).filter(node => node.props.accessibilityRole === 'radio').length, 3);
  assert.equal(actual(flatten(menu)), undefined);
  assert.equal(actual(expanded), 'Basic Offline');
});

for (const scenario of [
  { mode: 'automatic', signedIn: true, consent: true, gemma: true, http: 200, expected: 'OpenAI', requests: 1 },
  { mode: 'automatic', signedIn: false, consent: true, gemma: true, http: 200, expected: 'Gemma', requests: 0 },
  { mode: 'automatic', signedIn: false, consent: false, gemma: false, http: 200, expected: 'Basic Offline', requests: 0 },
  { mode: 'openai', signedIn: true, consent: true, gemma: false, http: 503, expected: 'Basic Offline', requests: 1 },
  { mode: 'openai', signedIn: true, consent: false, gemma: false, http: 200, expected: 'Basic Offline', requests: 0 },
  { mode: 'openai', signedIn: false, consent: true, gemma: false, http: 200, expected: 'Basic Offline', requests: 0 },
  { mode: 'openai', signedIn: true, consent: true, gemma: true, http: 200, simulation: true, expected: 'OpenAI', requests: 1 },
  { mode: 'openai', signedIn: true, consent: true, gemma: false, http: 503, simulation: true, expected: 'Basic Offline', requests: 1 },
  { mode: 'gemma', signedIn: true, consent: true, gemma: false, http: 200, expected: 'Basic Offline', requests: 0 },
] as const) test(`reports routed provenance for ${JSON.stringify(scenario)}`, async () => {
  const f = await fixture('basic');
  const choice = { automatic: 'Automatic', openai: 'OpenAI', gemma: 'On Device (Gemma)' }[scenario.mode];
  f.pick(choice);
  await tick();
  await f.policy.saveConsent('fixture-driver', scenario.consent);
  const context = acknowledgmentContext('bpm_high', 'en', "I'm dizzy");
  const requestId = '22222222-2222-4222-8222-222222222222';
  let requests = 0;
  const cloud = createOpenAIAcknowledgment({
    cachedCredential: () => scenario.signedIn ? { token: 'fixture', userId: 'fixture-account', revision: 1 } : null,
    subscribe: () => () => {},
  }, {
    url: 'https://fixture.invalid', publicKey: 'fixture', requestId: () => requestId,
    fetcher: async () => {
      requests++;
      return Response.json({ version: 3, requestId, advisoryOnly: true, callAuthorized: false,
        status: 'ok', code: 'advisory', message: acknowledgmentCandidates(context)[1] }, { status: scenario.http });
    },
  });
  const router = createLocalAcknowledgmentRouter(f.policy, {
    ready: () => scenario.gemma, generate: async () => acknowledgmentCandidates(context)[0]!,
  }, cloud);
  const acknowledgment = router(context, { driverId: 'fixture-driver', simulation: scenario.simulation === true, cloudSimulation: scenario.simulation === true, current: () => true });
  await tick();
  acknowledgment.get('en');
  assert.equal(requests, scenario.requests);
  assert.equal(actual(f.render([message(acknowledgment.source)])), scenario.expected);
});

test('saving a mode while VoiceCheck is listening leaves the current capture and safety result intact', async () => {
  const f = await fixture('gemma');
  let release!: () => void;
  const listening = new Promise<void>(resolve => { release = resolve; });
  let captureCount = 0, cancelCount = 0;
  const check = new VoiceCheck({
    speak: async () => {},
    listen: async (_language, _ms, _hints, id) => {
      captureCount++;
      await listening;
      const text = "I'm okay";
      return recognitionEvidence(id, { status: 'success', transcript: text, finalTranscript: text, isFinal: true, finalResultReceived: true });
    },
    cancel: () => { cancelCount++; },
  }, 'en', '');
  const result = check.run('bpm_high');
  await tick();
  assert.equal(captureCount, 1);
  f.pick('OpenAI');
  await tick();
  assert.equal(f.policy.state.preference, 'openai');
  assert.equal(cancelCount, 0);
  release();
  const completed = await result;
  assert.equal(completed.outcome, 'ok');
  assert.equal(completed.channel, 'voice');
  assert.equal(check.authorizesContact(completed), false);
});

test('compact selector uses one transparent row and reports observed readiness', async () => {
  const f = await fixture('gemma');
  const row = () => f.render().find(node => node.props.accessibilityRole === 'button');
  const label = (simulation = false) => f.render([], false, simulation)
    .find(node => node.props.accessibilityRole === 'button').props.children[2].props.children;
  assert.equal(row().props.style.minHeight, 44);
  assert.equal(row().props.style.flexDirection, 'row');
  assert.notEqual(row().props.style.flexWrap, 'wrap');
  assert.equal(row().props.children[0].props.name, 'cpu');
  assert.equal(row().props.children[3].props.name, 'chevron-down');
  assert.equal(f.render()[0].props.style.backgroundColor, undefined);
  assert.equal(label(), 'Unavailable');
  f.status.file = 'missing';
  assert.equal(label(), 'Download required');
  f.status.runtime.busy = true;
  f.status.runtime.phase = 'Loading model';
  f.status.preparing = true;
  assert.equal(label(), 'Preparing Gemma…');
  f.status.preparing = false;
  f.status.runtime.busy = false;
  f.status.gemmaReady = true;
  assert.equal(label(), 'Ready');
  f.status.gemmaReady = false;
  f.status.terms = false;
  assert.equal(label(), 'Unavailable');

  f.pick('OpenAI');
  await tick();
  assert.equal(label(), 'Sign-in required');
  f.status.auth = 'checking';
  assert.equal(label(), 'Checking session…');
  f.status.auth = 'signed_in';
  assert.equal(label(), 'Consent required');
  await f.policy.saveConsent('fixture-driver', true);
  assert.equal(label(), 'Unavailable');
  f.status.cloudReady = true;
  assert.equal(label(), 'Ready');
  assert.equal(label(true), 'Unavailable');
  f.pick('Automatic');
  await tick();
  assert.equal(label(), 'Available');
  assert.equal(label(true), 'Limited availability');
  f.status.gemmaReady = true;
  assert.equal(label(true), 'Available');
});

test('saved switches reach later live NOT_OK acknowledgments and completed playback provenance reaches UI', async () => {
  const f = await fixture('gemma');
  await f.policy.saveConsent('fixture-driver', true);
  const calls: string[] = [];
  const context = acknowledgmentContext('bpm_high', 'en', "I'm dizzy");
  const router = createLocalAcknowledgmentRouter(f.policy,
    { ready: () => true, generate: async () => { calls.push('gemma'); return acknowledgmentCandidates(context)[0]!; } },
    { ready: () => true, generate: async () => { calls.push('openai'); return acknowledgmentCandidates(context)[1]!; } });
  let episode = 0;
  async function run(answer: string) {
    const states: SafetyState[] = [];
    const responses = [answer, 'No, thanks'];
    const controller = new SafetyController({
      assistantMode: () => 'gemma', startAcknowledgment: (input, scope) => { assert.ok(scope); return router(input, scope); },
      voiceIO: () => ({
        cancel() {}, speak: async () => { await tick(); },
        listen: async (_lang, _ms, _hints, id) => {
          const text = responses.shift()!;
          return recognitionEvidence(id, { status: 'success', transcript: text, finalTranscript: text,
            isFinal: true, finalResultReceived: true });
        },
      }),
      save: async () => {}, saveAck: async () => {}, haptic() {},
      onChange: state => states.push(state), newId: () => `live-${++episode}`,
    });
    controller.configure({ id: 'fixture-driver', custom_id: null, display_name: 'Driver', age: 30, gender: 'male',
      height_cm: 180, weight_kg: 80, created_at: '', updated_at: '', emergency_name: 'Contact',
      emergency_phone: '+13055550123' }, null);
    controller.startSession('test-session');
    for (let second = 0; second < 30 && !states.at(-1)?.check; second++) {
      controller.onFrame({ version: 3, rateHz: 0, quality: 90, seq: second, startMs: 0, endMs: 0,
        heartRate: 155, spo2: 98, flags: 15, samples: [], finger: true, usable: true, raw: new Uint8Array() },
      new Date(100000 + second * 1000), 0);
    }
    for (let i = 0; i < 30 && !states.at(-1)?.conversation?.finished; i++) await tick();
    assert.equal(states.at(-1)?.conversation?.finished, true);
    return states;
  }
  const ok = await run("Yes I'm OK");
  assert.deepEqual(calls, []);
  assert.equal(actual(f.render(ok.at(-1)?.conversation?.messages)), 'None yet');
  const local = await run("I'm dizzy");
  assert.deepEqual(calls, ['gemma']);
  assert.equal(actual(f.render(local.at(-1)?.conversation?.messages)), 'Gemma');
  f.pick('OpenAI');
  await tick();
  assert.equal(f.store.get(SENSI_PREFERENCE_KEY), 'openai');
  const cloud = await run("I'm dizzy");
  assert.deepEqual(calls, ['gemma', 'openai']);
  const firstAcknowledgment = cloud.find(state => state.conversation?.messages.some(item => item.acknowledgmentSource === 'openai'));
  assert.ok(firstAcknowledgment);
  assert.equal(actual(f.render(firstAcknowledgment.conversation?.messages)), 'None yet');
  assert.equal(actual(f.render(cloud.at(-1)?.conversation?.messages)), 'OpenAI');
  assert.equal(cloud.at(-1)?.last?.result.contactCall, 'declined_offer');
});

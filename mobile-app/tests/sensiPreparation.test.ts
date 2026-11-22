import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import ts from 'typescript';
import { SENSI_PREFERENCE_KEY } from '../lib/assistant/sensiPreferences.ts';
import { createSensiPreferences } from './helpers/sensiConsent.ts';
import { createLocalAcknowledgmentRouter } from '../lib/assistant/acknowledgmentRouter.ts';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(basicOffline = false) {
  const saved = new Map<string, string>([[SENSI_PREFERENCE_KEY, 'gemma']]);
  const state = { loaded: false, installed: false, busy: false, error: '', cleanupRequired: false };
  const listeners = new Set<(s: typeof state) => void>(), appListeners = new Map<string, (s: string) => void>();
  const app = { currentState: 'active', addEventListener: (event: string, fn: (s: string) => void) => { appListeners.set(event, fn); return { remove() { appListeners.delete(event); } }; } };
  let setupBusy = false, modelReady = false;
  const setupListeners = new Set<(state: { terms: boolean; ready: boolean; busy: boolean; modelReady: boolean }) => void>();
  let proof: Promise<string> = Promise.resolve('installed'), terms = true, owned = false, inits = 0, releases = 0, generations = 0;
  const setup = {
    get state() { return { terms, ready: true, busy: setupBusy, modelReady }; },
    subscribe(fn: (typeof setupListeners extends Set<infer T> ? T : never)) {
      setupListeners.add(fn); fn(this.state); return () => setupListeners.delete(fn);
    },
  };
  const ready = () => owned && state.loaded && state.installed && !state.busy && !state.error && app.currentState === 'active';
  const dependencies: Record<string, unknown> = {
    '../voice/basicOfflineAcknowledgment': { VOICECHECK_BASIC_OFFLINE: basicOffline },
    './phoneCloudAuth': { sensiCloudAuth: {} },
    './openaiAcknowledgment': { createOpenAIAcknowledgment: () => ({ ready: () => false }) },
    '../ble/protocol': { uuidv4: () => 'test' },
    'react-native': { AppState: app },
    '../db/repositories': { getSetting: async (key: string) => saved.get(key) ?? null, setSetting: async (key: string, value: string) => { saved.set(key, value); } },
    '../onboarding/phone': { sensiSetup: setup },
    './phoneSensiPreferences': { sensiPreferences: createSensiPreferences({
      getSetting: async key => saved.get(key) ?? null, setSetting: async (key, value) => { saved.set(key, value); },
    }) }, './acknowledgmentRouter': { createLocalAcknowledgmentRouter },
    '../../modules/gemma-poc/phone': {
      waitForGemmaWarmCleanup: () => proof, isGemmaAcknowledgmentReady: ready,
      generateReadyGemmaAcknowledgment: async () => { generations++; return ''; },
      gemmaPoc: { state, subscribe(fn: (s: typeof state) => void) { listeners.add(fn); fn(state); return () => { listeners.delete(fn); }; } },
      beginGemmaWarmLease(receiptOnly: boolean) {
        assert.equal(receiptOnly, true);
        if (state.busy) return null;
        inits++; owned = true; state.busy = true;
        const lease = { release() { if (!owned) return; owned = false; releases++; state.loaded = false; } };
        void proof.then(status => { state.busy = false; state.loaded = owned && status === 'installed'; state.installed = state.loaded; for (const fn of listeners) fn(state); });
        return lease;
      },
    },
  };
  const source = readFileSync(new NodeURL('../lib/assistant/phoneSensiRouting.ts', import.meta.url), 'utf8');
  const exports: any = {};
  new Function('require', 'exports', ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(
    (name: string) => { assert.ok(name in dependencies, name); return dependencies[name]; }, exports);
  return { exports, state, ready, saved, counts: () => ({ inits, releases, generations }), proof: (p: Promise<string>) => { proof = p; }, terms: (v: boolean) => { terms = v; for (const fn of setupListeners) fn(setup.state); },
    setupWork(busy: boolean, verified: boolean) {
      setupBusy = busy; modelReady = verified;
      for (const fn of setupListeners) fn(setup.state);
    },
    change(state: string) { app.currentState = state; appListeners.get('change')?.(state); },
    memoryWarning() { appListeners.get('memoryWarning')?.(''); } };
}

test('saved Gemma prepares once after boot and coalesces foreground and resume requests', async () => {
  const f = fixture();
  assert.equal(f.counts().inits, 0);
  await f.exports.sensiPreferences.boot();
  f.change('active');
  f.exports.resumePreparedGemma();
  await tick();
  assert.equal(f.ready(), true);
  assert.deepEqual(f.counts(), { inits: 1, releases: 0, generations: 0 });
  f.change('active');
  assert.equal(f.counts().inits, 1);
});

test('Gemma selection, background recovery, and Basic release use the same lease lifecycle', async () => {
  const f = fixture();
  f.saved.set(SENSI_PREFERENCE_KEY, 'basic');
  await f.exports.sensiPreferences.boot(); await tick();
  assert.equal(f.counts().inits, 0);
  await f.exports.sensiPreferences.savePreference('gemma'); await tick();
  assert.equal(f.ready(), true);
  f.change('background'); assert.equal(f.ready(), false);
  f.change('active'); await tick(); assert.equal(f.ready(), true);
  await f.exports.sensiPreferences.savePreference('basic');
  assert.deepEqual(f.counts(), { inits: 2, releases: 2, generations: 0 });
});

for (const status of ['missing', 'unverified', 'unavailable']) test(`failed verified-only load settles without a retry loop: ${status}`, async () => {
  const f = fixture(); f.proof(Promise.resolve(status));
  await f.exports.sensiPreferences.boot(); await tick();
  assert.equal(f.ready(), false);
  assert.equal(f.exports.isGemmaPreparing(), false);
  assert.deepEqual(f.counts(), { inits: 1, releases: 1, generations: 0 });
});

test('explicit stop survives foreground return, and memory pressure defers rewarming until return', async () => {
  const f = fixture(); await f.exports.sensiPreferences.boot(); await tick();
  f.exports.stopPreparedGemma();
  f.change('background'); f.change('active'); await tick();
  assert.equal(f.exports.isGemmaExplicitlyStopped(), true); assert.equal(f.counts().inits, 1);
  f.exports.resumePreparedGemma(); await tick(); assert.equal(f.ready(), true);
  f.memoryWarning(); f.change('active'); await tick();
  assert.equal(f.ready(), false); assert.equal(f.counts().inits, 2);
  f.change('background'); f.change('active'); await tick();
  assert.equal(f.ready(), true); assert.equal(f.counts().inits, 3);
});

test('stop while waiting for previous native cleanup blocks late loading', async () => {
  const f = fixture(); let resolve!: (s: string) => void;
  f.proof(new Promise(r => { resolve = r; }));
  await f.exports.sensiPreferences.boot();
  assert.equal(f.exports.isGemmaPreparing(), true);
  f.exports.stopPreparedGemma(); resolve('installed'); await tick();
  assert.equal(f.counts().inits, 0);
  assert.equal(f.exports.isGemmaPreparing(), false);
});

test('successful explicit model maintenance prepares the selected model without another user action', async () => {
  const f = fixture(); f.proof(Promise.resolve('missing'));
  await f.exports.sensiPreferences.boot(); await tick();
  assert.equal(f.ready(), false);
  f.setupWork(true, false);
  f.proof(Promise.resolve('installed'));
  f.setupWork(false, true);
  await tick();
  assert.equal(f.ready(), true);
  f.terms(false);
  assert.equal(f.ready(), false);
});

test('Basic Offline VoiceCheck policy skips automatic Gemma warming but preserves explicit use', async () => {
  const f = fixture(true);
  await f.exports.sensiPreferences.boot(); f.change('background'); f.change('active'); await tick();
  assert.equal(f.counts().inits, 0);
  f.exports.resumePreparedGemma(); await tick();
  assert.equal(f.ready(), true);
  f.exports.stopPreparedGemma();
});

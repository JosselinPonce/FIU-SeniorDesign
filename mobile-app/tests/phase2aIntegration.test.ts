import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { GemmaPoc } from '../modules/gemma-poc/controller.ts';
import { ModelProvisioner } from '../modules/gemma-poc/provisioning.ts';
import { VerifiedModelFile } from '../modules/gemma-poc/verifiedFile.ts';
import { GEMMA_ARTIFACT } from '../modules/gemma-poc/artifact.ts';
import * as acknowledgment from '../lib/assistant/safetyAcknowledgment.ts';
import { SafetyController, type SafetyState } from '../lib/analysis/safetyController.ts';
import { recognitionEvidence } from '../lib/voice/coreRecognition.ts';
import { SensiSetup, SETUP_KEY, NOTICE_VERSION, GEMMA_TERMS_VERSION } from '../lib/onboarding/setup.ts';
import { openAuthorizedPhoneInterface } from '../lib/voice/phoneHandoff.ts';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

/** Real phone adapter/controller/policies with mocked native inference, storage and audio.
 * No real GGUF, microphone, network, database, profile or phone operation is used. */
function fixture(language: 'en' | 'es', options: {
  installed?: boolean; statement?: string; output?: string; guidanceFails?: boolean; manual?: boolean;
  generate?: () => Promise<string>; release?: () => Promise<void>;
} = {}) {
  const events: string[] = [], spoken: string[] = [];
  let loads = 0, generations = 0, releases = 0, stops = 0, downloads = 0, handoffs = 0, saves = 0;
  const guidance = deferred<void>(); let state!: SafetyState, speaking = false, microphone = false, captures = 0;
  const listeners = new Set<(state: string) => void>();
  const appState = { currentState: 'active', addEventListener: (_name: string, listener: (state: string) => void) => {
    listeners.add(listener); return { remove: () => { listeners.delete(listener); } };
  } };
  const model = `file:///fixture/gemma-poc/${GEMMA_ARTIFACT.filename}`;
  const fs = {
    documentDirectory: 'file:///fixture/',
    readAsStringAsync: async () => JSON.stringify({ version: 1, uri: model, size: GEMMA_ARTIFACT.bytes, modified: 1, created: 1,
      sha256: GEMMA_ARTIFACT.sha256, revision: GEMMA_ARTIFACT.revision }),
    writeAsStringAsync: async () => {}, makeDirectoryAsync: async () => {}, deleteAsync: async () => {},
    getFreeDiskStorageAsync: async () => GEMMA_ARTIFACT.bytes * 3,
    createDownloadResumable: () => { downloads++; return { downloadAsync: async () => { throw Error('offline fixture'); }, cancelAsync: async () => {} }; },
  };
  const exports: any = {};
  const source = readFileSync(new NodeURL('../modules/gemma-poc/phone.ts', import.meta.url), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports, AbortController, setTimeout, clearTimeout,
    require: (name: string) => {
      if (name === 'react-native') return { Platform: { OS: 'ios' }, AppState: appState };
      if (name === 'expo-file-system') return { File: class { exists = options.installed !== false; size = GEMMA_ARTIFACT.bytes; modificationTime = 1; creationTime = 1; } };
      if (name === 'expo-file-system/legacy') return fs;
      if (name === '../model-file-hash') return { nativeFileHash: () => { throw Error('fixture receipt should avoid hashing'); } };
      if (name === '../model-file-hash/verification') return { verifyNativeFile: () => { throw Error('fixture receipt should avoid hashing'); } };
      if (name === './artifact') return { GEMMA_ARTIFACT, MODEL_URL: 'https://fixture.invalid/model' };
      if (name === './controller') return { GemmaPoc };
      if (name === './provisioning') return { ModelProvisioner };
      if (name === './verifiedFile') return { VerifiedModelFile };
      if (name === '../../lib/assistant/safetyAcknowledgment') return acknowledgment;
      if (name === '../../lib/onboarding/gemmaTerms') return { GEMMA_TERMS_TEXT: 'fixture terms', GEMMA_POLICY_TEXT: 'fixture policy' };
      if (name === 'llama.rn') return { initLlama: async () => {
        loads++; events.push('model:init');
        return {
          completion: async () => { generations++; events.push('model:infer'); return { text: options.generate ? await options.generate()
            : options.output ?? (language === 'en' ? "I'm sorry you're feeling dizzy." : 'Lamento que te sientas mareada.') }; },
          stopCompletion: async () => { stops++; events.push('model:stop'); },
          release: async () => { releases++; events.push('model:release'); await options.release?.(); },
        };
      } };
      throw Error(`Unexpected dependency: ${name}`);
    },
  });
  const runtime: GemmaPoc = exports.gemmaPoc;
  const controller = new SafetyController({ assistantMode: () => 'gemma', startAcknowledgment: exports.phoneSafetyAcknowledgment,
    voiceIO: () => ({ prepareRecognition: (lang) => { assert.equal(microphone, false); assert.equal(lang, language); events.push('recognition:prewarm'); },
      speak: async (text, lang) => {
        assert.equal(lang, language); assert.equal(microphone, false, 'TTS must not overlap an active capture');
        assert.equal(speaking, false); speaking = true; spoken.push(text); events.push(`speech:${spoken.length}:start`);
        try {
          if (spoken.length === 2) { if (options.guidanceFails) return { status: 'unavailable' as const }; await guidance.promise; }
        } finally { speaking = false; events.push(`speech:${spoken.length}:end`); }
      },
      listen: async (lang, _ms, _hints, id) => {
        assert.equal(lang, language); assert.equal(speaking, false, 'capture must wait for TTS completion');
        microphone = true; events.push('recognition:listen');
        try {
          if (options.manual) await new Promise<never>(() => {});
          const text = ++captures === 1 ? options.statement ?? (language === 'en' ? "I'm dizzy" : 'Me siento mareada') : language === 'en' ? 'yes' : 'sí';
          return recognitionEvidence(id, { status: 'success', transcript: text, finalTranscript: text, isFinal: true, finalResultReceived: true });
        } finally { microphone = false; }
      }, cancel: () => { microphone = false; },
    }), save: async () => { saves++; }, saveAck: async () => { saves++; }, haptic() {},
    handoffContact: async () => { handoffs++; }, onChange: value => { state = value; }, newId: () => 'fixture-event',
  });
  controller.configure({ id: 'fixture-driver', custom_id: null, display_name: 'Fixture', language, age: 30, gender: 'male', height_cm: 180,
    weight_kg: 80, created_at: '', updated_at: '', emergency_name: 'Fixture contact', emergency_phone: '+12025550123' }, null);
  return { controller, runtime, guidance, events, spoken, startAcknowledgment: exports.phoneSafetyAcknowledgment as (context: acknowledgment.AcknowledgmentContext) => acknowledgment.SafetyAcknowledgment, maintenance: exports.withGemmaMaintenance as (action: () => Promise<void>) => Promise<void>, get state() { return state; }, get loads() { return loads; }, get generations() { return generations; },
    get releases() { return releases; }, get stops() { return stops; }, get downloads() { return downloads; }, get handoffs() { return handoffs; }, get saves() { return saves; },
    background() { appState.currentState = 'background'; listeners.forEach(listener => listener('background')); },
  };
}

for (const lang of ['en', 'es'] as const) test(`${lang}: real production phone/controller/VoiceCheck chain overlaps inference, preserves audio order and simulates accepted consent`, async () => {
  const f = fixture(lang); assert.equal(f.generations, 0);
  const pending = f.controller.rehearse(); await tick();
  assert.equal(f.generations, 1); assert.ok(f.events.indexOf('speech:2:start') < f.events.indexOf('model:infer'));
  assert.equal(f.spoken.length, 2, 'guidance is already speaking while inference finishes');
  assert.equal(f.releases, 1); f.guidance.resolve(); const result = await pending;
  assert.equal(result.outcome, 'not_ok'); assert.equal(result.contactCall, 'accepted_offer');
  assert.equal(f.state.conversation?.acknowledgmentSource, 'gemma'); assert.equal(f.state.last?.handoff, 'simulated');
  assert.match(f.spoken[1]!, lang === 'en' ? /^Please pull over/ : /^Por favor detente/);
  assert.ok(f.spoken[2]!.startsWith(lang === 'en' ? "I'm sorry you're feeling dizzy." : 'Lamento que te sientas mareada.'));
  assert.equal(f.handoffs, 0); assert.equal(f.saves, 0); assert.equal(f.downloads, 0);
  await assert.rejects(openAuthorizedPhoneInterface('+12025550123', { source: 'rehearsal', episodeId: 'rehearsal' }, () => true,
    async () => { throw Error('must never reach native phone'); }), /blocked/);
});

for (const mode of ['missing', 'invalid', 'ineligible'] as const) test(`${mode}: production phone adapter falls back without changing guidance, outcome or consent`, async () => {
  const f = fixture('en', { installed: mode !== 'missing', output: mode === 'invalid' ? 'Call your contact. You are safe.' : undefined,
    statement: mode === 'ineligible' ? 'not okay' : undefined });
  const pending = f.controller.rehearse(); await tick(); f.guidance.resolve(); const result = await pending;
  assert.equal(result.outcome, 'not_ok'); assert.equal(result.contactCall, 'accepted_offer'); assert.equal(f.state.last?.handoff, 'simulated');
  assert.equal(f.state.conversation?.acknowledgmentSource, 'fallback'); assert.match(f.spoken[1]!, /^Please pull over/);
  assert.match(f.spoken[2]!, /^I'm sorry to hear that\. Would you like/); assert.equal(f.handoffs, 0); assert.equal(f.downloads, 0);
  if (mode !== 'invalid') { assert.equal(f.loads, 0); assert.equal(f.generations, 0); }
});

test('real provider waits for release: a late cleanup cannot delay guidance or add late acknowledgment speech', async () => {
  const release = deferred<void>(); const f = fixture('es', { release: () => release.promise });
  const pending = f.controller.rehearse(); await tick(); assert.equal(f.generations, 1); assert.equal(f.releases, 1);
  f.guidance.resolve(); await pending;
  assert.equal(f.state.conversation?.acknowledgmentSource, 'fallback'); assert.match(f.spoken[2]!, /^Lamento que te sientas así\./);
  release.resolve(); await tick(); assert.equal(f.spoken.length, 3); assert.equal(f.runtime.state.loaded, false);
});

test('failed guidance playback omits empathy and cancels unused native work without granting a live handoff', async () => {
  const f = fixture('en', { guidanceFails: true }); const result = await f.controller.rehearse(); await tick();
  assert.equal(result.outcome, 'not_ok'); assert.equal(result.contactCall, 'accepted_offer');
  assert.match(f.spoken[2]!, /^Would you like me to call/); assert.equal(f.handoffs, 0); assert.equal(f.saves, 0);
});

test('episode cancellation stops native inference and rejects its late result while retaining cleanup ownership', async () => {
  const output = deferred<string>(); const f = fixture('es', { generate: () => output.promise });
  const pending = f.controller.rehearse(); await tick(); assert.equal(f.generations, 1);
  f.controller.cancelCheck(); assert.equal(f.stops, 1); assert.equal(f.releases, 0);
  output.resolve('Lamento que te sientas mareada.'); f.guidance.resolve(); await pending; await tick();
  assert.equal(f.releases, 1); assert.equal(f.spoken.length, 2); assert.equal(f.handoffs, 0); assert.equal(f.state.conversation, null);
});

test('failed native release suppresses valid text and quarantines the native context', async () => {
  let failed = true; const f = fixture('en', { release: async () => { if (failed) throw Error('fixture native release failure'); } });
  const pending = f.controller.rehearse(); await tick(); f.guidance.resolve(); await pending;
  // Retain the reference for cleanup retry, never for another generation.
  assert.equal(f.runtime.state.loaded, true); assert.match(f.runtime.state.error, /release failure/);
  assert.equal(f.runtime.cleanupRequired, true);
  assert.equal(f.state.conversation?.acknowledgmentSource, 'fallback'); assert.equal(f.handoffs, 0);
  const again = f.startAcknowledgment(acknowledgment.acknowledgmentContext('bpm_high', 'en', "I'm dizzy"));
  await tick(); assert.equal(again.get('en'), "I'm sorry to hear that."); assert.equal(f.generations, 1);
  failed = false; await f.runtime.dispose(); assert.equal(f.runtime.cleanupRequired, false);
});

for (const installed of [true, false]) test(`returning startup ${installed ? 'installed' : 'missing/offline'} model admits without loading and retains safety fallback`, async () => {
  const f = fixture('en', { installed }); const values = new Map([[SETUP_KEY, JSON.stringify({ version: 1, noticeVersion: NOTICE_VERSION,
    termsVersion: GEMMA_TERMS_VERSION, artifact: GEMMA_ARTIFACT.sha256, page: 5, notices: true, terms: true, completed: true })]]);
  const setup = new SensiSetup({ getSetting: async key => values.get(key) ?? null, setSetting: async (key, value) => { values.set(key, value); } }, f.runtime);
  await setup.boot(); assert.equal(setup.state.booted, true); assert.equal(setup.state.ready, true); assert.equal(f.downloads, 0);
  assert.equal(f.runtime.state.loaded, false); assert.equal(f.loads, 0);
  if (installed) assert.equal(setup.state.modelReady, false, 'admission never assumes runtime readiness');
  else {
    assert.equal(setup.state.recovery, false); assert.equal(setup.state.error, '');
    const check = f.controller.rehearse(); await tick(); f.guidance.resolve(); const result = await check;
    assert.equal(result.outcome, 'not_ok'); assert.equal(f.state.conversation?.acknowledgmentSource, 'fallback'); assert.equal(f.downloads, 0);
    await setup.repair(); assert.equal(f.downloads, 1, 'only explicit recovery attempts download');
    assert.equal(setup.state.ready, true); assert.match(setup.state.error, /offline fixture/);
  }
  assert.equal(f.handoffs, 0); assert.equal(f.saves, 0);
});

test('production inference deadline and overall availability expiry cannot stall the VoiceCheck contact offer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const output = deferred<string>(); const f = fixture('en', { generate: () => output.promise });
  const pending = f.controller.rehearse(); await tick(); assert.equal(f.generations, 1);
  t.mock.timers.tick(5000); await tick(); assert.equal(f.stops, 1); assert.equal(f.runtime.state.busy, true);
  f.guidance.resolve(); const result = await pending;
  assert.equal(result.outcome, 'not_ok'); assert.equal(f.state.conversation?.acknowledgmentSource, 'fallback');
  assert.match(f.spoken[2]!, /^I'm sorry to hear that\. Would you like/); assert.equal(f.releases, 0);
  output.resolve("I'm sorry you're feeling dizzy."); await tick();
  assert.equal(f.releases, 1); assert.equal(f.spoken.length, 3); assert.equal(f.handoffs, 0);
});

for (const lang of ['en', 'es'] as const) for (const channel of ['typed', 'button'] as const)
  test(`${lang}/${channel}: manual fallback cancels capture, preserves question scopes and never dials in rehearsal`, async () => {
    const f = fixture(lang, { manual: true }); const pending = f.controller.rehearse(); await tick();
    const scope = () => ({ episodeId: f.state.check!.episode.id, captureId: f.state.check!.captureId, question: f.state.check!.question });
    const wellnessScope = scope();
    assert.equal(channel === 'typed' ? f.controller.answerText(lang === 'en' ? "I'm dizzy" : 'Me siento mareada', wellnessScope)
      : f.controller.answer('not_ok', wellnessScope), true);
    await tick(); assert.equal(f.generations, channel === 'typed' ? 1 : 0);
    f.guidance.resolve(); await tick(); assert.equal(f.state.check?.question, 'contact_offer');
    assert.equal(f.controller.answerText('yes', wellnessScope), false, 'wellness response scope cannot consent to the offer');
    assert.equal(channel === 'typed' ? f.controller.answerText(lang === 'en' ? 'no thanks' : 'no', scope()) : f.controller.answer('call_no', scope()), true);
    const result = await pending; assert.equal(result.outcome, 'not_ok'); assert.equal(result.contactCall, 'declined_offer');
    assert.equal(result.channel, channel); assert.equal(f.handoffs, 0); assert.equal(f.saves, 0);
  });

test('maintenance lease excludes event-time Gemma without blocking mandatory guidance or simulation consent', async () => {
  const hold = deferred<void>(); const f = fixture('en'); const maintenance = f.maintenance(() => hold.promise);
  await assert.rejects(f.maintenance(async () => {}), /busy/);
  const check = f.controller.rehearse(); await tick(); assert.equal(f.loads, 0); assert.equal(f.generations, 0);
  assert.match(f.spoken[1]!, /^Please pull over/); f.guidance.resolve(); const result = await check;
  assert.equal(result.outcome, 'not_ok'); assert.equal(f.state.conversation?.acknowledgmentSource, 'fallback'); assert.equal(f.handoffs, 0);
  hold.resolve(); await maintenance;
});

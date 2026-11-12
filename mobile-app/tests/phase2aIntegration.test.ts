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
import * as semantics from '../lib/assistant/safetySemantic.ts';
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
  installed?: boolean; followup?: string; statement?: string; output?: string; guidanceFails?: boolean; manual?: boolean;
  generate?: () => Promise<string>; release?: () => Promise<void>;
} = {}) {
  const events: string[] = [], spoken: string[] = [];
  let loads = 0, generations = 0, releases = 0, stops = 0, downloads = 0, handoffs = 0, saves = 0;
  const guidance = deferred<void>(), clarification = deferred<void>(); let state!: SafetyState, speaking = false, microphone = false, captures = 0;
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
      if (name === '../../lib/voice/responsivenessDiagnostics') return { responsivenessProbe: () => () => {} };
      if (name === '../../lib/assistant/safetySemantic') return semantics;
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
  const controller = new SafetyController({ assistantMode: () => 'gemma', startAcknowledgment: exports.phoneSafetyAcknowledgment, startSemantic: exports.phoneSafetySemantic,
    voiceIO: () => ({ prepareRecognition: (lang) => { assert.equal(microphone, false); assert.equal(lang, language); events.push('recognition:prewarm'); },
      speak: async (text, lang) => {
        assert.equal(lang, language); assert.equal(microphone, false, 'TTS must not overlap an active capture');
        assert.equal(speaking, false); speaking = true; spoken.push(text); events.push(`speech:${spoken.length}:start`);
        try {
          if (options.followup && text === "I didn't catch that.") await clarification.promise;
          if (/^(?:Please pull over|Por favor detente)/.test(text)) { if (options.guidanceFails) return { status: 'unavailable' as const }; await guidance.promise; }
        } finally { speaking = false; events.push(`speech:${spoken.length}:end`); }
      },
      listen: async (lang, _ms, _hints, id) => {
        assert.equal(lang, language); assert.equal(speaking, false, 'capture must wait for TTS completion');
        microphone = true; events.push('recognition:listen');
        try {
          if (options.manual) await new Promise<never>(() => {});
          const text = ++captures === 1 ? options.statement ?? (language === 'en' ? "I'm dizzy" : 'Me siento mareada') : captures === 2 && options.followup ? options.followup : language === 'en' ? 'yes' : 'sí';
          return recognitionEvidence(id, { status: 'success', transcript: text, finalTranscript: text, isFinal: true, finalResultReceived: true });
        } finally { microphone = false; }
      }, cancel: () => { microphone = false; },
    }), save: async () => { saves++; }, saveAck: async () => { saves++; }, haptic() {},
    handoffContact: async () => { handoffs++; }, onChange: value => { state = value; }, newId: () => 'fixture-event',
  });
  controller.configure({ id: 'fixture-driver', custom_id: null, display_name: 'Fixture', language, age: 30, gender: 'male', height_cm: 180,
    weight_kg: 80, created_at: '', updated_at: '', emergency_name: 'Fixture contact', emergency_phone: '+12025550123' }, null);
  return { controller, runtime, guidance, clarification, events, spoken, startAcknowledgment: exports.phoneSafetyAcknowledgment as (context: acknowledgment.AcknowledgmentContext) => acknowledgment.SafetyAcknowledgment, maintenance: exports.withGemmaMaintenance as (action: () => Promise<void>) => Promise<void>, get state() { return state; }, get loads() { return loads; }, get generations() { return generations; },
    get releases() { return releases; }, get stops() { return stops; }, get downloads() { return downloads; }, get handoffs() { return handoffs; }, get saves() { return saves; },
    background() { appState.currentState = 'background'; listeners.forEach(listener => listener('background')); },
  };
}

for (const lang of ['en', 'es'] as const) test(`${lang}: immediate sentence guidance overlaps actual adapter inference and preserves consent and audio ownership`, async () => {
  const f = fixture(lang); const pending = f.controller.rehearse(); await tick();
  assert.equal(f.generations, 1); assert.equal(f.loads, 1);
  assert.equal(f.spoken.length, 4); assert.match(f.spoken[3]!, /pull over|detente/);
  assert.equal(f.spoken.some(t => /Would you like|¿Quieres/.test(t)), false, 'offer waits for guidance');
  f.guidance.resolve(); const result = await pending;
  assert.equal(result.outcome, 'not_ok'); assert.equal(result.contactCall, 'accepted_offer');
  assert.equal(f.state.conversation?.acknowledgmentSource, 'gemma'); assert.equal(f.state.last?.handoff, 'simulated');
  assert.equal(f.spoken.length, 7);
  assert.deepEqual(f.state.conversation?.messages.filter(m => m.role === 'assistant').map(m => m.text), f.spoken, 'visible assistant messages exactly match TTS');
  assert.equal(f.handoffs, 0); assert.equal(f.saves, 0); assert.equal(f.downloads, 0);
  await assert.rejects(openAuthorizedPhoneInterface('+12025550123', { source: 'rehearsal', episodeId: 'rehearsal' }, () => true, async () => {}), /blocked/);
});
for (const mode of ['missing', 'invalid', 'ineligible'] as const) test(`${mode}: actual production adapter retains verification and validation fallback`, async () => {
  const f = fixture('en', { installed: mode !== 'missing', output: mode === 'invalid' ? 'Call your contact. You are safe.' : undefined });
  const ack = f.startAcknowledgment(acknowledgment.acknowledgmentContext('bpm_high', 'en', mode === 'ineligible' ? 'not okay' : "I'm dizzy"));
  await tick(); assert.equal(ack.get('en'), "I'm sorry to hear that.");
  assert.equal(f.handoffs, 0); assert.equal(f.downloads, 0);
  if (mode !== 'invalid') assert.equal(f.generations, 0);
});
test('production adapter waits for release; late cleanup cannot publish a consumed acknowledgment', async () => {
  const release = deferred<void>(); const f = fixture('es', { release: () => release.promise });
  const ack = f.startAcknowledgment(acknowledgment.acknowledgmentContext('bpm_high', 'es', 'Me siento mareada'));
  await tick(); assert.equal(f.generations, 1); assert.equal(f.releases, 1);
  assert.equal(ack.get('es'), 'Lamento que te sientas así.'); release.resolve(); await tick();
  assert.equal(ack.source, 'fallback'); assert.equal(f.runtime.state.loaded, false);
});
test('episode cancellation stops independently running inference and retains cleanup ownership', async () => {
  const output = deferred<string>(); const f = fixture('es', { generate: () => output.promise });
  const ack = f.startAcknowledgment(acknowledgment.acknowledgmentContext('bpm_high', 'es', 'Me siento mareada'));
  await tick(); assert.equal(f.generations, 1); ack.cancel(); assert.equal(f.stops, 1); assert.equal(f.releases, 0);
  output.resolve('Lamento que te sientas mareada.'); await tick(); assert.equal(f.releases, 1); assert.equal(ack.source, 'fallback');
});
test('failed native release suppresses valid text and quarantines the native context', async () => {
  let failed = true; const f = fixture('en', { release: async () => { if (failed) throw Error('fixture native release failure'); } });
  const context = acknowledgment.acknowledgmentContext('bpm_high', 'en', "I'm dizzy");
  const first = f.startAcknowledgment(context); await tick(); assert.equal(first.get('en'), "I'm sorry to hear that.");
  assert.equal(f.runtime.state.loaded, true); assert.equal(f.runtime.cleanupRequired, true);
  const again = f.startAcknowledgment(context); await tick(); assert.equal(again.get('en'), "I'm sorry to hear that."); assert.equal(f.generations, 1);
  failed = false; await f.runtime.dispose(); assert.equal(f.runtime.cleanupRequired, false);
});
test('failed coordinated playback keeps typed/button follow-up and cannot grant live authorization', async () => {
  const f = fixture('en', { guidanceFails: true }); const result = await f.controller.rehearse();
  assert.equal(result.outcome, 'not_ok'); assert.equal(f.handoffs, 0); assert.equal(f.saves, 0);
  assert.match(f.spoken.join(' '), /pull over.*Would you like/);
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

test('production adapter deadline cannot publish late text', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const output = deferred<string>(); const f = fixture('en', { generate: () => output.promise });
  const ack = f.startAcknowledgment(acknowledgment.acknowledgmentContext('bpm_high', 'en', "I'm dizzy"));
  await tick(); assert.equal(f.generations, 1); t.mock.timers.tick(5000); await tick();
  assert.equal(f.stops, 1); assert.equal(ack.get('en'), "I'm sorry to hear that.");
  output.resolve("I'm sorry you're feeling dizzy."); await tick(); assert.equal(f.releases, 1); assert.equal(ack.source, 'fallback');
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
  assert.match(f.spoken.join(' '), /Please pull over/); f.guidance.resolve(); const result = await check;
  assert.equal(result.outcome, 'not_ok'); assert.equal(f.state.conversation?.acknowledgmentSource, 'fallback'); assert.equal(f.handoffs, 0);
  hold.resolve(); await maintenance;
});

for (const mode of ['accepted','invalid','missing'] as const) test(`production phone semantic adapter during clarification (${mode}, mocked native GGUF)`, async () => {
  const f = fixture('en',{statement:'fatigue this evening',followup:'perhaps',installed:mode!=='missing',output:mode==='invalid'?'unsafe extra prose':'{"state":"NOT_OK","context":"fatigue","concern":"yes"}'});
  f.guidance.resolve(); const pending=f.controller.rehearse(); await tick();
  assert.equal(f.generations,mode==='missing'?0:1); assert.equal(f.releases,mode==='missing'?0:1);
  assert.ok(f.spoken.includes("I didn't catch that.")); f.clarification.resolve();const result=await pending;
  assert.equal(result.outcome,mode==='accepted'?'not_ok':'no_response');assert.equal(f.handoffs,0);assert.equal(f.downloads,0);assert.equal(f.saves,0);
  assert.equal(f.generations,mode==='missing'?0:1,'no second model reload for ineligible empathy');assert.equal(f.runtime.state.loaded,false);
});

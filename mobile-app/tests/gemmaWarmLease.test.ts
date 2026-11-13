import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import ts from 'typescript';
import { GemmaPoc } from '../modules/gemma-poc/controller.ts';
import { ModelProvisioner } from '../modules/gemma-poc/provisioning.ts';
import { VerifiedModelFile } from '../modules/gemma-poc/verifiedFile.ts';
import { GEMMA_ARTIFACT } from '../modules/gemma-poc/artifact.ts';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const semanticContext = { event: 'bpm_high' as const, language: 'en' as const, statement: 'I feel dizzy and weak' };

/** Real phone adapter against a fixed installed-model receipt and controllable
 * native context; everything else is a fixture. No native binary is used. */
function harness(options: { output?: string; release?: () => Promise<void> } = {}) {
  const counts = { inits: 0, releases: 0, generations: 0 };
  const source = readFileSync(new NodeURL('../modules/gemma-poc/phone.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: any = {};
  const deps: Record<string, unknown> = {
    'react-native': { Platform: { OS: 'ios' }, AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) } },
    'expo-file-system': { File: class { exists = true; size = GEMMA_ARTIFACT.bytes; modificationTime = 1; creationTime = 1; } },
    'expo-file-system/legacy': {
      documentDirectory: 'file:///fixture/',
      readAsStringAsync: async () => JSON.stringify({ version: 1, uri: `file:///fixture/gemma-poc/${GEMMA_ARTIFACT.filename}`,
        size: GEMMA_ARTIFACT.bytes, modified: 1, created: 1, sha256: GEMMA_ARTIFACT.sha256, revision: GEMMA_ARTIFACT.revision }),
      writeAsStringAsync: async () => {}, getFreeDiskStorageAsync: async () => GEMMA_ARTIFACT.bytes * 3,
      makeDirectoryAsync: async () => {}, deleteAsync: async () => {}, moveAsync: async () => {},
      createDownloadResumable: () => ({ downloadAsync: async () => ({ status: 200 }), cancelAsync: async () => {} }),
    },
    '../model-file-hash': { nativeFileHash: () => { throw Error('fixture receipt avoids hashing'); } },
    '../model-file-hash/verification': { verifyNativeFile: async () => { throw Error('fixture receipt avoids hashing'); } },
    './artifact': { GEMMA_ARTIFACT, MODEL_URL: 'https://fixture.invalid/model' },
    './controller': { GemmaPoc }, './provisioning': { ModelProvisioner }, './verifiedFile': { VerifiedModelFile },
    '../../lib/voice/responsivenessDiagnostics': { responsivenessProbe: () => () => {} },
    '../../lib/assistant/safetySemantic': { startSemantic: (generate: (signal: AbortSignal) => Promise<string>) => generate(new AbortController().signal) },
    '../../lib/assistant/safetyAcknowledgment': { startSafetyAcknowledgment: (generate: (signal: AbortSignal) => Promise<string>) => generate(new AbortController().signal) },
    '../../lib/onboarding/gemmaTerms': { GEMMA_TERMS_TEXT: 'fixture terms', GEMMA_POLICY_TEXT: 'fixture policy' },
    'llama.rn': { initLlama: async () => { counts.inits++; return {
      completion: async () => { counts.generations++; return { text: options.output ?? '{"state":"OK","context":"dizziness","concern":"no"}' }; },
      stopCompletion: async () => {}, release: async () => { counts.releases++; await options.release?.(); } }; } },
  };
  new Function('require', 'exports', '__DEV__', compiled)((name: string) => {
    assert.ok(name in deps, `fixture is missing module ${name}`); return deps[name];
  }, exports, false);
  return { exports, counts: () => ({ ...counts }), get poc() { return exports.gemmaPoc; } };
}
async function settle(check: () => boolean, limit = 200) {
  for (let n = 0; n < limit && !check(); n++) await tick();
  return check();
}

test('warm lease keeps the model loaded across a completed semantic event', async () => {
  const f = harness();
  f.exports.beginGemmaWarmLease();
  assert.equal(await settle(() => f.poc.state.loaded), true, 'begin must fire the load');
  assert.equal(f.counts().inits, 1, 'begin must load at most once');
  await f.exports.phoneSafetySemantic(semanticContext);
  assert.deepEqual(f.counts(), { inits: 1, releases: 0, generations: 1 });
  assert.equal(f.poc.state.loaded, true, 'the lease must skip the event-scoped dispose');
  assert.equal(f.poc.state.error, '');
});
test('nested leases dispose only when the last holder ends', async () => {
  const f = harness();
  f.exports.beginGemmaWarmLease(); f.exports.beginGemmaWarmLease();
  await settle(() => f.poc.state.loaded);
  await f.exports.phoneSafetySemantic(semanticContext);
  f.exports.endGemmaWarmLease();
  await settle(() => f.counts().releases > 0, 5);
  assert.deepEqual(f.counts(), { inits: 1, releases: 0, generations: 1 }, 'an inner end must not unload');
  assert.equal(f.poc.state.loaded, true);
  f.exports.endGemmaWarmLease();
  assert.equal(await settle(() => f.counts().releases === 1), true);
  assert.equal(f.poc.state.loaded, false);
});
test('ending without a lease stays at zero and keeps the no-lease cleanup behavior', async () => {
  const f = harness();
  f.exports.endGemmaWarmLease();
  await f.exports.phoneSafetySemantic(semanticContext);
  assert.deepEqual(f.counts(), { inits: 1, releases: 1, generations: 1 }, 'no lease: the model disposes after the event');
  assert.equal(f.poc.state.loaded, false);
  f.exports.endGemmaWarmLease();
  f.exports.endGemmaWarmLease();
  assert.deepEqual(f.counts(), { inits: 1, releases: 1, generations: 1 }, 'the lease count never goes negative');
});

test('a lease that ends before the cold load settles chains exactly one dispose after settle', async () => {
  const f = harness();
  f.exports.beginGemmaWarmLease();
  f.exports.endGemmaWarmLease();   // the tap inside the first spoken sentence ends the check before SHA-256/init completes
  assert.equal(f.counts().releases, 0, 'the load is still pending, so end cannot dispose yet');
  assert.equal(await settle(() => f.counts().inits === 1), true, 'the in-flight load still completes');
  assert.equal(await settle(() => f.counts().releases === 1), true, 'the chained dispose runs after the load settles');
  await tick(); await tick();
  assert.equal(f.counts().releases, 1, 'exactly one dispose');
  assert.equal(f.poc.state.loaded, false, 'the model does not stay resident across drives');
});
test('begin, end, begin: the fresh lease reuses the pending load and still releases exactly once', async () => {
  const f = harness();
  f.exports.beginGemmaWarmLease();
  f.exports.endGemmaWarmLease();
  f.exports.beginGemmaWarmLease();   // new lease while the first load is still pending
  assert.equal(await settle(() => f.poc.state.loaded), true);
  assert.equal(f.counts().inits, 1, 'a pending load is reused, never restarted');
  f.exports.endGemmaWarmLease();     // the second end comes after the load settles
  assert.equal(await settle(() => f.counts().releases === 1), true);
  await tick(); await tick();
  assert.equal(f.counts().releases, 1, 'no double dispose with the fresh lease');
  assert.equal(f.poc.state.loaded, false);
});

test('semantic deadline is 3500ms, acknowledgment stays 1500ms', () => {
  const src = readFileSync(new NodeURL('../modules/gemma-poc/controller.ts', import.meta.url), 'utf8');
  // The acknowledgment body is 639 chars from signature to its call site, so the
  // brief's 600-char window cannot match the real source; 700 keeps the same pin.
  assert.match(src, /generateSafetySemantic[\s\S]{0,600}?, 3500\);/);
  assert.match(src, /generateSafetyAcknowledgment[\s\S]{0,700}?, 1500\);/);
  assert.doesNotMatch(src, /, 3500\);[\s\S]{0,200}, 3500\);/); // only the semantic lane
});

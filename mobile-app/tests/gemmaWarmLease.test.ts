import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import ts from 'typescript';
import { GemmaPoc } from '../modules/gemma-poc/controller.ts';
import { ModelProvisioner } from '../modules/gemma-poc/provisioning.ts';
import { VerifiedModelFile } from '../modules/gemma-poc/verifiedFile.ts';
import { SEMANTIC_DECISION_MS, startSemantic } from '../lib/assistant/safetySemantic.ts';
import { GEMMA_ARTIFACT } from '../modules/gemma-poc/artifact.ts';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const semanticContext = { event: 'bpm_high' as const, language: 'en' as const, statement: 'I feel dizzy and weak' };

/** Real phone adapter against a fixed installed-model receipt and controllable
 * native context; everything else is a fixture. No native binary is used. */
function harness(options: { output?: string; release?: () => Promise<void>; initialize?: () => Promise<void>; generate?: () => Promise<string>; stop?: () => Promise<void>; realTasks?: boolean } = {}) {
  let stops = 0;
  const listeners = new Set<(state: string) => void>();
  const appState = { currentState: 'active', addEventListener: (_event: string, listener: (state: string) => void) => { listeners.add(listener); return { remove() { listeners.delete(listener); } }; } };
  const counts = { inits: 0, releases: 0, generations: 0 };
  const source = readFileSync(new NodeURL('../modules/gemma-poc/phone.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: any = {};
  const deps: Record<string, unknown> = {
    'react-native': { Platform: { OS: 'ios' }, AppState: appState },
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
    '../../lib/assistant/safetySemantic': { SEMANTIC_DECISION_MS, startSemantic: options.realTasks ? startSemantic : (generate: (signal: AbortSignal) => Promise<string>) => generate(new AbortController().signal) },
    '../../lib/assistant/safetyAcknowledgment': { startSafetyAcknowledgment: (generate: (signal: AbortSignal) => Promise<string>) => generate(new AbortController().signal) },
    '../../lib/onboarding/gemmaTerms': { GEMMA_TERMS_TEXT: 'fixture terms', GEMMA_POLICY_TEXT: 'fixture policy' },
    'llama.rn': { initLlama: async () => { counts.inits++; await options.initialize?.(); return {
      completion: async () => { counts.generations++; return { text: await options.generate?.() ?? options.output ?? '{"state":"OK","context":"dizziness","concern":"no"}' }; },
      stopCompletion: async () => { stops++; await options.stop?.(); }, release: async () => { counts.releases++; await options.release?.(); } }; } },
  };
  new Function('require', 'exports', '__DEV__', compiled)((name: string) => {
    assert.ok(name in deps, `fixture is missing module ${name}`); return deps[name];
  }, exports, false);
  return { exports, counts: () => ({ ...counts }), get poc() { return exports.gemmaPoc; }, stops: () => stops, background() { appState.currentState = 'background'; for (const listener of [...listeners]) listener('background'); }, foreground() { appState.currentState = 'active'; } };
}
async function settle(check: () => boolean, limit = 200) {
  for (let n = 0; n < limit && !check(); n++) await tick();
  return check();
}

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

test('warm lease reuses the model across an event, then releases exactly once', async () => {
  const f = harness(); const lease = f.exports.beginGemmaWarmLease();
  assert.ok(lease); assert.equal(await settle(() => f.poc.state.loaded), true);
  await f.exports.phoneSafetySemantic(semanticContext);
  assert.deepEqual(f.counts(), { inits: 1, releases: 0, generations: 1 });
  lease.release(); lease.release();
  assert.equal(await settle(() => !f.poc.state.loaded), true);
  assert.equal(f.counts().releases, 1);
});
test('overlapping holders retain residency until the last valid token releases', async () => {
  const f = harness(); const a = f.exports.beginGemmaWarmLease(), b = f.exports.beginGemmaWarmLease();
  assert.ok(a); assert.ok(b); await settle(() => f.poc.state.loaded);
  a.release(); a.release(); f.exports.endGemmaWarmLease();
  assert.equal(f.poc.state.loaded, true);
  b.release(); assert.equal(await settle(() => !f.poc.state.loaded), true);
  assert.equal(f.counts().releases, 1);
});
test('unmatched release cannot unload an independently owned diagnostic runtime', async () => {
  const f = harness(); await f.poc.load();
  f.exports.endGemmaWarmLease(); f.exports.endGemmaWarmLease(null);
  assert.equal(f.poc.state.loaded, true); assert.equal(f.counts().releases, 0);
  assert.equal(f.exports.beginGemmaWarmLease(), null, 'cannot claim someone else’s runtime');
  await assert.rejects(f.exports.phoneSafetySemantic(semanticContext), /busy/);
  assert.equal(f.counts().generations, 0); assert.equal(f.counts().releases, 0);
  await f.poc.dispose();
});
test('standalone events still clean up without a warm owner', async () => {
  const f = harness(); await f.exports.phoneSafetySemantic(semanticContext);
  assert.deepEqual(f.counts(), { inits: 1, releases: 1, generations: 1 });
});
test('last release cancels pending verification without starting native initialization', async () => {
  const f = harness(); const lease = f.exports.beginGemmaWarmLease(); lease.release();
  assert.equal(await settle(() => !f.poc.state.busy), true);
  assert.equal(f.counts().inits, 0); assert.equal(f.poc.state.loaded, false);
});
test('cancelled cold initialization releases its late context once; no cancelled-load reuse', async () => {
  const init = deferred<void>(); const f = harness({ initialize: () => init.promise });
  const lease = f.exports.beginGemmaWarmLease(); await settle(() => f.counts().inits === 1);
  lease.release();
  assert.equal(f.exports.beginGemmaWarmLease(), null);
  init.resolve(); await settle(() => !f.poc.state.busy); await tick();
  assert.equal(f.counts().releases, 1); assert.equal(f.poc.state.loaded, false);
  const fresh = f.exports.beginGemmaWarmLease(); assert.ok(fresh);
  await settle(() => f.poc.state.loaded); fresh.release();
  await settle(() => !f.poc.state.loaded); assert.equal(f.counts().releases, 2);
});
test('maintenance and warm ownership exclude one another', async () => {
  const hold = deferred<void>(); const f = harness();
  const repair = f.exports.withGemmaMaintenance(() => hold.promise);
  assert.equal(f.exports.beginGemmaWarmLease(), null); assert.equal(f.counts().inits, 0);
  hold.resolve(); await repair;
  const lease = f.exports.beginGemmaWarmLease(); assert.ok(lease);
  await assert.rejects(f.exports.withGemmaMaintenance(async () => {}), /busy/);
  await settle(() => f.poc.state.loaded); lease.release(); await settle(() => !f.poc.state.loaded);
});
test('background rejects acquisition and revokes pending cold initialization', async () => {
  const init = deferred<void>(); const f = harness({ initialize: () => init.promise });
  f.background(); assert.equal(f.exports.beginGemmaWarmLease(), null);
  f.foreground(); const lease = f.exports.beginGemmaWarmLease(); await settle(() => f.counts().inits === 1);
  f.background(); init.resolve(); await settle(() => !f.poc.state.busy);
  assert.equal(f.poc.state.loaded, false); assert.equal(f.counts().releases, 1);
  f.foreground(); await tick(); assert.equal(f.counts().inits, 1, 'foreground does not auto-start model work');
  lease.release(); assert.equal(f.counts().releases, 1);
});
test('real semantic task cancellation stops native work before warm release', async () => {
  const output = deferred<string>(), stopped = deferred<void>();
  const f = harness({ realTasks: true, generate: () => output.promise, stop: () => stopped.promise });
  const lease = f.exports.beginGemmaWarmLease(); await settle(() => f.poc.state.loaded);
  const task = f.exports.phoneSafetySemantic(semanticContext); await settle(() => f.counts().generations === 1);
  task.cancel(); lease.release();
  assert.equal(f.stops(), 1); assert.equal(f.counts().releases, 0);
  output.resolve('{"state":"OK","context":"none","concern":"no"}'); await tick();
  assert.equal(f.counts().releases, 0);
  stopped.resolve(); await settle(() => f.counts().releases === 1);
  assert.equal(task.get(), null); assert.equal(f.poc.state.loaded, false);
});
test('new acquisition cannot race disposal, and an old token cannot release a fresh owner', async () => {
  const release = deferred<void>(); const f = harness({ release: () => release.promise });
  const old = f.exports.beginGemmaWarmLease(); await settle(() => f.poc.state.loaded);
  old.release(); assert.equal(f.exports.beginGemmaWarmLease(), null);
  await assert.rejects(f.exports.phoneSafetySemantic(semanticContext), /busy/);
  release.resolve(); await settle(() => !f.poc.state.loaded); await tick();
  const fresh = f.exports.beginGemmaWarmLease(); assert.ok(fresh); await settle(() => f.poc.state.loaded);
  old.release(); assert.equal(f.poc.state.loaded, true);
  fresh.release(); await settle(() => !f.poc.state.loaded); assert.equal(f.counts().releases, 2);
});
test('failed disposal stays quarantined and requires explicit maintenance recovery', async () => {
  let fail = true; const f = harness({ release: async () => { if (fail) throw Error('release failed'); } });
  const lease = f.exports.beginGemmaWarmLease(); await settle(() => f.poc.state.loaded);
  lease.release(); await settle(() => f.poc.cleanupRequired && !f.poc.state.busy); await tick();
  assert.equal(f.exports.beginGemmaWarmLease(), null);
  fail = false; await f.exports.withGemmaMaintenance(() => f.poc.dispose());
  assert.equal(f.poc.cleanupRequired, false); assert.equal(f.poc.state.loaded, false);
});

test('semantic budget is shared at 2000ms and acknowledgment remains 1500ms', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const output = deferred<string>();
  const f = harness({ realTasks: true, generate: () => output.promise, stop: async () => { output.resolve('late'); } });
  const lease = f.exports.beginGemmaWarmLease(); await settle(() => f.poc.state.loaded);
  const task = f.exports.phoneSafetySemantic(semanticContext); await settle(() => f.counts().generations === 1);
  t.mock.timers.tick(SEMANTIC_DECISION_MS); await tick();
  assert.equal(f.stops(), 1); assert.equal(task.get(), null);
  lease.release(); await settle(() => !f.poc.state.loaded);
  const src = readFileSync(new NodeURL('../modules/gemma-poc/controller.ts', import.meta.url), 'utf8');
  assert.match(src, /generateSafetyAcknowledgment[\s\S]{0,700}?, 1500\);/);
});

test('cold loading consumes the semantic availability budget before native generation', async t => {
  let clock = 0;
  t.mock.method(performance, 'now', () => clock);
  const f = harness({ realTasks: true, initialize: async () => { clock = 100; } });
  const task = f.exports.phoneSafetySemantic(semanticContext, 60);
  await task.completion;
  assert.equal(task.get(), null);
  assert.deepEqual(f.counts(), { inits: 1, releases: 1, generations: 0 });
});

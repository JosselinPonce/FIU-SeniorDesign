import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SensiSetup, SETUP_KEY, type SetupRuntime } from '../lib/onboarding/setup.ts';
import type { PocState } from '../modules/gemma-poc/controller.ts';
import { VerifiedModelFile, type FileIdentity } from '../modules/gemma-poc/verifiedFile.ts';
import { GEMMA_ARTIFACT } from '../modules/gemma-poc/artifact.ts';
function fixture(existing = false) {
  const values = new Map<string, string>();
  let exists = existing, corrupt = false, initFails = false, downloadFails = false, verifyFails = false;
  let downloads = 0, loads = 0, disposed = 0, downloadIntegrityFails = false;
  let hold: (() => Promise<void>) | null = null;
  let holdDownload: (() => Promise<void>) | null = null;
  const state: PocState = { phase: '', installed: false, loaded: false, busy: false, response: '', error: '', progress: null, loadMs: null, inferenceMs: null };
  const runtime: SetupRuntime = { state, subscribe: fn => { fn(state); return () => {}; },
    async load() {
      loads++; state.error = ''; state.installed = false;
      if (hold) await hold();
      if (verifyFails) { state.error = 'Native hash service unavailable'; return; }
      if (!exists) { state.error = 'Model is missing. Provision it first.'; return; }
      if (corrupt) { state.error = 'Model integrity check failed. Provision the approved artifact again.'; return; }
      state.installed = true;
      if (initFails) { state.error = 'Gemma native initialization failed: unsupported device'; return; }
      state.loaded = true;
    },
    async provision() {
      downloads++; state.error = ''; if (holdDownload) await holdDownload();
      if (downloadFails) { state.error = 'Model download stalled'; return; }
      if (downloadIntegrityFails) { state.error = 'Model integrity check failed'; return; }
      exists = true; corrupt = false; state.installed = true;
    },
    async dispose() { disposed++; state.loaded = false; state.error = ''; }, cancel() {},
  };
  const store = { getSetting: async (key: string) => values.get(key) ?? null, setSetting: async (key: string, value: string) => { values.set(key, value); } };
  const setup = new SensiSetup(store, runtime);
  return { setup, runtime, store, values, get downloads() { return downloads; }, get loads() { return loads; }, get disposed() { return disposed; },
    corrupt: () => { corrupt = true; }, remove: () => { exists = false; }, failInit: (v: boolean) => { initFails = v; },
    failDownload: (v: boolean) => { downloadFails = v; }, failVerify: () => { verifyFails = true; }, hold: (fn: () => Promise<void>) => { hold = fn; },
    failDownloadIntegrity: () => { downloadIntegrityFails = true; }, holdDownload: (fn: () => Promise<void>) => { holdDownload = fn; } };
}
async function accept(s: SensiSetup) { await s.acknowledge('notices', true); await s.acknowledge('terms', true); }
test('fresh install cannot skip notices, terms, installation or completion', async () => {
  const f = fixture(); await f.setup.boot(); assert.equal(f.setup.state.page, 0);
  await f.setup.go(5); assert.equal(f.setup.state.page, 0);
  await f.setup.prepare(); assert.equal(f.downloads, 0); assert.equal(await f.setup.complete(), false);
  await f.setup.go(2); await f.setup.acknowledge('notices', true); await f.setup.go(4);
  await f.setup.prepare(); assert.equal(f.downloads, 0);
  await f.setup.acknowledge('terms', true); await f.setup.prepare();
  assert.equal(f.downloads, 1); assert.equal(f.loads, 2); assert.equal(f.setup.state.page, 5);
  assert.equal(f.setup.state.modelReady, true); assert.equal(f.runtime.state.loaded, false);
  assert.equal(f.setup.state.ready, false); assert.equal(await f.setup.complete(), true);
  assert.equal(JSON.parse(f.values.get(SETUP_KEY)!).completed, true);
});
test('existing model/profiles are reused without another download or profile writes', async () => {
  const f = fixture(true); f.values.set('driver_profiles', 'existing-profile'); f.values.set('onboarded', '1');
  await f.setup.boot(); assert.equal(f.setup.state.page, 0);
  await accept(f.setup); await f.setup.prepare(); await f.setup.complete();
  assert.equal(f.downloads, 0); assert.equal(f.loads, 1); assert.equal(f.values.get('driver_profiles'), 'existing-profile');
  assert.deepEqual([...f.values.keys()].sort(), [SETUP_KEY, 'driver_profiles', 'onboarded'].sort());
});
test('returning user checks integrity/runtime then enters dashboard without repeated slides/download', async () => {
  const f = fixture(true); await f.setup.boot(); await accept(f.setup); await f.setup.prepare(); await f.setup.complete();
  const restarted = new SensiSetup(f.store, f.runtime); await restarted.boot();
  assert.equal(restarted.state.ready, true); assert.equal(restarted.state.modelReady, true);
  assert.equal(f.downloads, 0); assert.equal(f.runtime.state.loaded, false);
});
for (const problem of ['missing', 'corrupt', 'runtime'] as const) test(`returning ${problem} model blocks dashboard and offers recovery`, async () => {
  const f = fixture(true); await f.setup.boot(); await accept(f.setup); await f.setup.prepare(); await f.setup.complete();
  if (problem === 'missing') f.remove(); if (problem === 'corrupt') f.corrupt(); if (problem === 'runtime') f.failInit(true);
  const restarted = new SensiSetup(f.store, f.runtime); await restarted.boot();
  assert.equal(restarted.state.ready, false); assert.equal(restarted.state.page, 4); assert.ok(restarted.state.error);
  assert.equal(f.downloads, 0, 'launch never silently downloads');
  f.failInit(false); await restarted.prepare(); assert.equal(restarted.state.modelReady, true);
  assert.equal(f.downloads, problem === 'runtime' ? 0 : 1);
});
test('failed download remains unready and retries the existing provisioner', async () => {
  const f = fixture(); await f.setup.boot(); await accept(f.setup); f.failDownload(true);
  await f.setup.prepare(); assert.equal(f.setup.state.ready, false); assert.match(f.setup.state.error, /stalled/);
  assert.equal(await f.setup.complete(), false); f.failDownload(false); await f.setup.prepare();
  assert.equal(f.setup.state.modelReady, true); assert.equal(f.downloads, 2);
});
test('verification service failure never redownloads a present model', async () => {
  const f = fixture(true); await accept(f.setup); f.failVerify(); await f.setup.prepare();
  assert.equal(f.downloads, 0); assert.equal(f.setup.state.modelReady, false); assert.match(f.setup.state.error, /hash service/);
});
test('interrupted initialization cannot complete setup; restart restores consent and page', async () => {
  const f = fixture(true); await f.setup.boot(); await accept(f.setup); await f.setup.go(4);
  let finish!: () => void; f.hold(() => new Promise<void>(r => { finish = r; }));
  const work = f.setup.prepare(); await new Promise(r => setImmediate(r)); f.setup.cancel(); finish(); await work;
  assert.equal(f.setup.state.ready, false); assert.equal(f.setup.state.modelReady, false); assert.equal(f.runtime.state.loaded, false);
  const restart = new SensiSetup(f.store, f.runtime); await restart.boot();
  assert.equal(restart.state.page, 4); assert.equal(restart.state.notices, true); assert.equal(restart.state.terms, true); assert.equal(restart.state.ready, false);
});
test('setup never steals an owned runtime or repeats boot work', async () => {
  const f = fixture(); await f.setup.boot(); await accept(f.setup); f.runtime.state.busy = true;
  await f.setup.prepare(); assert.equal(f.loads, 0); assert.equal(f.disposed, 0);
  await Promise.all([f.setup.boot(), f.setup.boot()]); assert.equal(f.loads, 0);
});
test('download SHA-256 failure never marks installation or setup ready', async () => {
  const f = fixture(); await accept(f.setup); f.failDownloadIntegrity(); await f.setup.prepare();
  assert.match(f.setup.state.error, /integrity/); assert.equal(f.runtime.state.installed, false);
  assert.equal(f.setup.state.modelReady, false); assert.equal(await f.setup.complete(), false);
});
test('interrupted download cannot advance onboarding after a late native return', async () => {
  const f = fixture(); await accept(f.setup);
  let finish!: () => void; f.holdDownload(() => new Promise<void>(r => { finish = r; }));
  const work = f.setup.prepare(); await new Promise(r => setImmediate(r)); f.setup.cancel(); finish(); await work;
  assert.equal(f.setup.state.ready, false); assert.equal(f.setup.state.modelReady, false); assert.equal(f.setup.state.page, 4);
});
test('failed acknowledgment persistence and obsolete notices cannot authorize setup', async () => {
  const f = fixture(); f.store.setSetting = async () => { throw Error('storage unavailable'); };
  await f.setup.acknowledge('notices', true); assert.equal(f.setup.state.notices, false);
  await f.setup.prepare(); assert.equal(f.loads, 0);
  const g = fixture(); g.values.set(SETUP_KEY, JSON.stringify({ version: 1, completed: true, notices: true, terms: true, termsVersion: 'obsolete' }));
  await g.setup.boot(); assert.equal(g.setup.state.ready, false); assert.equal(g.setup.state.terms, false); assert.equal(g.loads, 0);
});
function cacheFixture() {
  let identity: FileIdentity | null = { size: GEMMA_ARTIFACT.bytes, modified: 100, created: 50 };
  let receipt: any = null, hashes = 0, valid = true, change = false;
  const cache = new VerifiedModelFile({ identity: () => identity, read: async () => receipt, write: async value => { receipt = value; },
    hash: async (_uri, signal) => { hashes++; if (signal.aborted) throw Error('cancelled'); if (!valid) throw Error('Model integrity check failed'); if (change) identity = { ...identity!, modified: 200 }; return true; },
  }, GEMMA_ARTIFACT);
  return { cache, get hashes() { return hashes; }, get receipt() { return receipt; }, identity: (v: FileIdentity | null) => { identity = v; }, corrupt: () => { valid = false; }, mutate: () => { change = true; } };
}
const signal = () => new AbortController().signal;
test('unchanged native-verified file avoids repeated hashing; forced checks hash again', async () => {
  const f = cacheFixture(); assert.equal(await f.cache.verify('model', signal()), true); assert.equal(f.hashes, 1);
  assert.equal(await f.cache.verify('model', signal()), true); assert.equal(f.hashes, 1);
  await f.cache.verify('model', signal(), undefined, true); assert.equal(f.hashes, 2);
});
test('missing, incomplete, changed or corrupt model cannot gain a trusted receipt', async () => {
  const f = cacheFixture(); f.identity(null); assert.equal(await f.cache.verify('model', signal()), false);
  f.identity({ size: 10, modified: 100, created: 50 }); await assert.rejects(f.cache.verify('model', signal()), /size/); assert.equal(f.receipt, null);
  f.identity({ size: GEMMA_ARTIFACT.bytes, modified: 100, created: 50 }); await f.cache.verify('model', signal());
  f.identity({ size: GEMMA_ARTIFACT.bytes, modified: 200, created: 50 }); f.corrupt();
  await assert.rejects(f.cache.verify('model', signal()), /integrity/); assert.equal(f.hashes, 2);
});
test('missing metadata, concurrent file mutation and cancellation cannot bypass native verification', async () => {
  const f = cacheFixture(); f.identity({ size: GEMMA_ARTIFACT.bytes, modified: null, created: null });
  await f.cache.verify('model', signal()); await f.cache.verify('model', signal()); assert.equal(f.hashes, 2);
  const g = cacheFixture(); g.mutate(); await assert.rejects(g.cache.verify('model', signal()), /changed during/); assert.equal(g.receipt, null);
  const abort = new AbortController(); abort.abort(); await assert.rejects(g.cache.verify('model', abort.signal), /cancelled/);
});
test('failed forced SHA-256 invalidates an earlier receipt even when metadata is unchanged', async () => {
  const f = cacheFixture(); await f.cache.verify('model', signal()); assert.ok(f.receipt);
  f.corrupt(); await assert.rejects(f.cache.verify('model', signal(), undefined, true), /integrity/);
  assert.equal(f.receipt, null);
  await assert.rejects(f.cache.verify('model', signal()), /integrity/); assert.equal(f.hashes, 3);
});

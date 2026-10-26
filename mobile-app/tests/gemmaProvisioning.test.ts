import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelProvisioner, PROVISION_LIMITS, type ProvisionProgress } from '../modules/gemma-poc/provisioning.ts';
import { GemmaPoc } from '../modules/gemma-poc/controller.ts';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fixture(options: { stuckCancel?: boolean; failVerify?: boolean; pendingVerify?: boolean; pendingDelete?: boolean; limits?: typeof PROVISION_LIMITS } = {}) {
  let transfer = deferred<void>();
  const verification = deferred<void>(), deletion = deferred<void>();
  let report!: (bytes: number) => void;
  let activate = 0, discard = 0, cancel = 0, starts = 0, verified = 0;
  const progress: ProvisionProgress[] = [];
  const runner = new ModelProvisioner({ bytes: 100,
    prepare: async () => {},
    transfer: callback => {
      report = callback; transfer = deferred<void>();
      return { download: () => { starts++; return transfer.promise; }, cancel: async () => { cancel++; if (!options.stuckCancel) transfer.resolve(); } };
    },
    verify: async signal => {
      verified++;
      if (options.failVerify) throw Error('SHA-256 mismatch');
      if (options.pendingVerify) await verification.promise;
      if (signal.aborted) throw Error('verification cancelled');
    },
    activate: async signal => { assert.equal(signal.aborted, false); activate++; },
    discard: async () => { discard++; if (options.pendingDelete) await deletion.promise; },
  }, options.limits ?? { downloadMs: 900, stallMs: 60, verifyMs: 120, cleanupMs: 15 });
  return { runner, progress, report: (bytes: number) => report(bytes), finish: () => transfer.resolve(), verification, deletion,
    run: (signal = new AbortController().signal) => runner.run(signal, p => progress.push(p)),
    counts: () => ({ activate, discard, cancel, starts, verified }) };
}
test('slow but progressing transfer exceeds old two-minute budget, then gets a separate verification budget', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture({ pendingVerify: true, limits: PROVISION_LIMITS }); const result = f.run(); await tick();
  for (let n = 1; n <= 5; n++) { t.mock.timers.tick(50_000); f.report(n * 10); await tick(); }
  assert.equal(f.counts().cancel, 0); f.finish(); await tick();
  t.mock.timers.tick(100_000); await tick(); assert.equal(f.counts().cancel, 0);
  f.verification.resolve(); await result;
  assert.equal(f.counts().activate, 1); assert.equal(f.counts().discard, 0);
  assert.equal(f.progress.at(-1)?.stage, 'verify');
  assert.equal(PROVISION_LIMITS.downloadMs, 900000);
});
test('stalled transfer cancels, discards partial data and can retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); const failed = assert.rejects(f.run(), /stalled/); await tick();
  t.mock.timers.tick(60); await failed;
  assert.deepEqual(f.counts(), { activate: 0, discard: 1, cancel: 1, starts: 1, verified: 0 });
  const retry = f.run(); await tick(); f.finish(); await retry;
  assert.equal(f.counts().activate, 1); assert.equal(f.counts().starts, 2);
});
test('duplicate byte callbacks do not conceal a stalled transfer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); const failed = assert.rejects(f.run(), /stalled/); await tick();
  f.report(10); t.mock.timers.tick(50); f.report(10); t.mock.timers.tick(10); await failed;
  assert.equal(f.counts().activate, 0);
});
test('user cancellation cannot verify or activate a partial download', async () => {
  const f = fixture(); const abort = new AbortController();
  const failed = assert.rejects(f.run(abort.signal), /cancelled/); await tick();
  abort.abort(); await failed;
  assert.equal(f.counts().cancel, 1); assert.equal(f.counts().discard, 1); assert.equal(f.counts().verified, 0);
});
test('verification failure discards the file and never activates it', async () => {
  const f = fixture({ failVerify: true }); const failed = assert.rejects(f.run(), /SHA-256 mismatch/);
  await tick(); f.finish(); await failed;
  assert.equal(f.counts().activate, 0); assert.equal(f.counts().discard, 1);
});
test('verification timeout keeps staging owned until verification has unwound', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture({ pendingVerify: true }); const failed = assert.rejects(f.run(), /Cleanup is still pending/);
  await tick(); f.finish(); await tick(); t.mock.timers.tick(120); await tick();
  t.mock.timers.tick(15); await failed;
  await assert.rejects(f.run(), /cleanup is still pending/);
  assert.equal(f.counts().discard, 0); f.verification.resolve(); await tick();
  assert.equal(f.counts().discard, 1); assert.equal(f.counts().activate, 0);
});
test('hung native cancellation releases UI but never allows overlapping writers; late completion permits retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture({ stuckCancel: true });
  const poc = new GemmaPoc({ verify: async () => false,
    provision: (signal, progress) => f.runner.run(signal, progress), initialize: async () => { throw Error('unexpected'); } });
  const failed = poc.provision(); await tick(); t.mock.timers.tick(60); await tick(); t.mock.timers.tick(15); await failed;
  assert.equal(poc.state.busy, false); assert.equal(poc.state.installed, false);
  assert.match(poc.state.error, /Cleanup is still pending/);
  await poc.provision(); assert.match(poc.state.error, /cleanup is still pending/);
  assert.equal(f.counts().starts, 1);
  const previousProgress = poc.state.progress;
  f.report(99); assert.equal(poc.state.progress, previousProgress);
  f.finish(); await tick();
  const retry = poc.provision(); await tick(); f.finish(); await retry;
  assert.equal(poc.state.installed, true); assert.equal(f.counts().starts, 2);
});
test('a hard download limit still applies while bytes keep arriving', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); const failed = assert.rejects(f.run(), /15-minute limit/); await tick();
  for (let n = 1; n <= 17; n++) { t.mock.timers.tick(50); f.report(n); await tick(); }
  t.mock.timers.tick(50); await failed; assert.equal(f.counts().activate, 0);
});
test('pending file deletion also prevents a new writer until cleanup finishes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture({ pendingDelete: true }); const failed = assert.rejects(f.run(), /Cleanup is still pending/);
  await tick(); t.mock.timers.tick(60); await tick(); t.mock.timers.tick(15); await failed;
  await assert.rejects(f.run(), /cleanup is still pending/);
  f.deletion.resolve(); await tick(); const retry = f.run(); await tick(); f.finish(); await retry;
  assert.equal(f.counts().activate, 1);
});
test('user cancellation surfaces bounded cleanup failure rather than an indefinite waiting message', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture({ stuckCancel: true });
  const poc = new GemmaPoc({ verify: async () => false,
    provision: (signal, progress) => f.runner.run(signal, progress), initialize: async () => { throw Error('unexpected'); } });
  const pending = poc.provision(); await tick(); poc.cancel(); await tick();
  t.mock.timers.tick(15); await pending;
  assert.equal(poc.state.busy, false); assert.match(poc.state.error, /Cleanup is still pending/);
  assert.equal(poc.state.installed, false); f.finish(); await tick();
});

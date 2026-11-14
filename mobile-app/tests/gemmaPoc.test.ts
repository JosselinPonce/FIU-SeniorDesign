import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { SEMANTIC_DECISION_MS } from '../lib/assistant/safetySemantic.ts';
import { GemmaPoc, type Context } from '../modules/gemma-poc/controller.ts';
import { GEMMA_ARTIFACT, MODEL_URL, TEST_PROMPT, assertArtifact } from '../modules/gemma-poc/artifact.ts';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fixture(overrides: Partial<Context> = {}) {
  let releases = 0, stops = 0;
  const prompts: string[] = [];
  const context: Context = { generate: async text => { prompts.push(text); return 'I hear you.'; },
    stop: async () => { stops++; }, release: async () => { releases++; }, ...overrides };
  const poc = new GemmaPoc({ verify: async () => true, provision: async () => {}, initialize: async () => context }, 10);
  return { poc, context, prompts, releases: () => releases, stops: () => stops };
}
const semanticContext = { event: 'bpm_high' as const, language: 'en' as const, statement: 'fatigue this evening' };
for (const trigger of ['cancel', 'deadline', 'dispose'] as const) test(`semantic ${trigger} stops native generation, discards output and orders release`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const output = deferred<string>(), stopped = deferred<void>();
  let stops = 0;
  const f = fixture({ generate: () => output.promise, stop: () => { stops++; return stopped.promise; } });
  await f.poc.load();
  const running = f.poc.generateSafetySemantic(semanticContext);
  let disposal: Promise<void> | undefined;
  if (trigger === 'cancel') f.poc.cancel();
  if (trigger === 'deadline') t.mock.timers.tick(SEMANTIC_DECISION_MS);
  if (trigger === 'dispose') disposal = f.poc.dispose();
  assert.equal(stops, 1);
  assert.equal(f.poc.state.busy, true);
  await assert.rejects(f.poc.generateSafetySemantic(semanticContext), /active/);
  output.resolve('{"state":"OK","context":"none","concern":"no"}');
  await tick();
  assert.equal(f.releases(), 0, 'native stop must settle before reuse/release');
  assert.equal(f.poc.state.busy, true);
  stopped.resolve();
  assert.equal(await running, '');
  await (disposal ?? f.poc.dispose());
  assert.equal(stops, 1);
  assert.equal(f.releases(), 1);
  assert.equal(f.poc.state.loaded, false);
});

for (const synchronous of [false, true]) test(`semantic stop failure retains ownership until natural completion (sync=${synchronous})`, async () => {
  const output = deferred<string>();
  const f = fixture({ generate: () => output.promise, stop: () => {
    if (synchronous) throw Error('native stop failed');
    return Promise.reject(Error('native stop failed'));
  } });
  await f.poc.load();
  const running = f.poc.generateSafetySemantic(semanticContext);
  f.poc.cancel(); await tick();
  assert.match(f.poc.state.error, /Cancellation failed/);
  assert.equal(f.poc.state.busy, true);
  const disposal = f.poc.dispose();
  await tick(); assert.equal(f.releases(), 0);
  output.resolve('late'); assert.equal(await running, ''); await disposal;
  assert.equal(f.releases(), 1);
});

test('an old cancellation handle cannot stop a newer native operation', async () => {
  let output = deferred<string>();
  const f = fixture({ generate: () => output.promise });
  await f.poc.load();
  const first = f.poc.generateSafetySemantic(semanticContext);
  const oldCancel = f.poc.cancellationHandle();
  output.resolve('first'); await first;
  output = deferred<string>();
  const second = f.poc.generateSafetySemantic(semanticContext);
  oldCancel();
  assert.equal(f.stops(), 0);
  assert.equal(f.poc.state.busy, true);
  output.resolve('second'); assert.equal(await second, 'second');
  await f.poc.dispose();
});
test('approved artifact is revision-pinned and size/hash mismatch is rejected', () => {
  assert.match(MODEL_URL, new RegExp(GEMMA_ARTIFACT.revision));
  assertArtifact(GEMMA_ARTIFACT.bytes, GEMMA_ARTIFACT.sha256);
  assert.throws(() => assertArtifact(0, GEMMA_ARTIFACT.sha256), /integrity/);
  assert.throws(() => assertArtifact(GEMMA_ARTIFACT.bytes, 'bad'), /integrity/);
});
test('missing or corrupt models never initialize native inference', async () => {
  for (const verify of [async () => false, async () => { throw Error('corrupt'); }]) {
    let initialized = false;
    const poc = new GemmaPoc({ verify, provision: async () => {}, initialize: async () => { initialized = true; throw Error('unexpected'); } });
    await poc.load(); assert.equal(initialized, false); assert.equal(poc.state.loaded, false); assert.ok(poc.state.error);
  }
});
test('fixed prompt, timing, and safe unload', async () => {
  const f = fixture(); await f.poc.load(); await f.poc.run();
  assert.deepEqual(f.prompts, [TEST_PROMPT]); assert.equal(f.poc.state.response, 'I hear you.');
  assert.equal(typeof f.poc.state.loadMs, 'number'); assert.equal(typeof f.poc.state.inferenceMs, 'number');
  await f.poc.dispose(); assert.equal(f.releases(), 1); assert.equal(f.poc.state.loaded, false);
});
test('duplicate request rejected; cancelled late result discarded; disposal waits for native completion', async () => {
  const result = deferred<string>(); const f = fixture({ generate: () => result.promise });
  await f.poc.load(); const running = f.poc.run();
  await assert.rejects(f.poc.run(), /active/);
  const disposal = f.poc.dispose(); assert.equal(f.stops(), 1); assert.equal(f.releases(), 0);
  await assert.rejects(f.poc.load(), /active/);
  result.resolve('late unsafe text'); await running; await disposal;
  assert.equal(f.poc.state.response, ''); assert.equal(f.releases(), 1);
});
test('generation deadline cancels native work and retains ownership until it settles', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const result = deferred<string>(); const f = fixture({ generate: () => result.promise });
  await f.poc.load(); const running = f.poc.run(); t.mock.timers.tick(10); await tick();
  assert.equal(f.stops(), 1); assert.match(f.poc.state.error, /timed out/); assert.equal(f.poc.state.busy, true);
  await assert.rejects(f.poc.run(), /active/);
  result.resolve('late'); await running; assert.equal(f.poc.state.response, ''); await f.poc.dispose();
});
test('cancelled initialization releases its late context without publishing it', async () => {
  const init = deferred<Context>(); const f = fixture();
  const poc = new GemmaPoc({ verify: async () => true, provision: async () => {}, initialize: () => init.promise });
  const loading = poc.load(); await tick(); poc.cancel(); init.resolve(f.context); await loading;
  assert.equal(poc.state.loaded, false); assert.equal(f.releases(), 1); assert.match(poc.state.error, /cancel/i);
});
test('native stop is awaited before release, including when generation already ended', async () => {
  const result = deferred<string>(), stopped = deferred<void>();
  const f = fixture({ generate: () => result.promise, stop: () => stopped.promise });
  await f.poc.load(); const running = f.poc.run(); const disposal = f.poc.dispose();
  result.resolve('late'); await tick(); assert.equal(f.releases(), 0); assert.equal(f.poc.state.busy, true);
  stopped.resolve(); await running; await disposal; assert.equal(f.releases(), 1);
});
test('failed release retains context for an explicit disposal retry', async () => {
  let fail = true;
  const f = fixture({ release: async () => { if (fail) throw Error('release failed'); } });
  await f.poc.load(); await f.poc.dispose(); assert.equal(f.poc.state.loaded, true); assert.match(f.poc.state.error, /release failed/);
  fail = false; await f.poc.dispose(); assert.equal(f.poc.state.loaded, false);
});
test('provisioning failure remains unverified and cannot silently initialize', async () => {
  let initialized = false;
  const poc = new GemmaPoc({ verify: async () => false, provision: async () => { throw Error('checksum mismatch'); },
    initialize: async () => { initialized = true; throw Error('unexpected'); } });
  await poc.provision(); assert.equal(poc.state.installed, false); assert.match(poc.state.error, /checksum mismatch/);
  await poc.load(); assert.equal(initialized, false);
});
test('unsupported native runtime error is surfaced without a loaded context', async () => {
  const poc = new GemmaPoc({ verify: async () => true, provision: async () => {},
    initialize: async () => { throw Error('unsupported device backend'); } });
  await poc.load(); assert.match(poc.state.error, /unsupported device backend/); assert.equal(poc.state.loaded, false);
});
test('diagnostic entry stays development-only; shared provisioning requires onboarding consent', () => {
  const read = (file: string) => readFileSync(new NodeURL(file, import.meta.url), 'utf8');
  const phone = read('../modules/gemma-poc/phone.ts');
  assert.match(read('../modules/gemma-poc/GemmaDiagnostic.tsx'), /if \(!__DEV__\)/);
  assert.match(read('../lib/onboarding/setup.ts'), /!this.state.notices \|\| !this.state.terms/);
  assert.match(phone, /n_predict: 64/);
  assert.match(phone, /await verifyFile\(paths\(\).staging, signal, progress, true\)/);
  assert.match(phone, /verifyNativeFile\(nativeFileHash\(\)/);
  assert.doesNotMatch(phone, /hash.update|readBytes|base64/);
  assert.doesNotMatch(phone, /SafetyController|VoiceCheck|supabase|openai|handoffContact/);
  const shell = read('../components/SmartWheelScreen.tsx');
  assert.match(shell, /const GemmaDiagnostic = __DEV__ \?/);
  assert.match(shell, /gemmaOpen && GemmaDiagnostic && !drive.hasActiveSession/);
  assert.doesNotMatch(read('../lib/voice/voiceCheck.ts'), /gemma-poc/);
});

test('failed release quarantines the retained context; only cleanup retry can make a subsequent load usable', async () => {
  const { acknowledgmentContext } = await import('../lib/assistant/safetyAcknowledgment.ts');
  let fail = true, generated = 0;
  const f = fixture({ generate: async () => { generated++; return "I'm sorry you're feeling dizzy."; }, release: async () => { if (fail) throw Error('release failed'); } });
  await f.poc.load(); await f.poc.dispose(); assert.equal(f.poc.cleanupRequired, true); assert.equal(f.poc.state.cleanupRequired, true);
  await f.poc.run(); assert.equal(generated, 0);
  assert.equal(await f.poc.generateSafetyAcknowledgment(acknowledgmentContext('bpm_high', 'en', "I'm dizzy")), '');
  assert.equal(generated, 0); await f.poc.load(); assert.equal(f.poc.cleanupRequired, true);
  fail = false; await f.poc.dispose(); assert.equal(f.poc.cleanupRequired, false); assert.equal(f.poc.state.loaded, false);
  await f.poc.load(); await f.poc.run(); assert.equal(generated, 1); await f.poc.dispose();
});
test('cancelled initialization with failed release is also quarantined', async () => {
  const init = deferred<Context>(); let fail = true, generated = 0;
  const poc = new GemmaPoc({ verify: async () => true, provision: async () => {}, initialize: () => init.promise });
  const loading = poc.load(); await tick(); poc.cancel();
  init.resolve({ generate: async () => { generated++; return 'bad'; }, stop: async () => {}, release: async () => { if (fail) throw Error('release failed'); } });
  await loading; assert.equal(poc.cleanupRequired, true); await poc.run(); assert.equal(generated, 0);
  fail = false; await poc.dispose(); assert.equal(poc.state.loaded, false);
});

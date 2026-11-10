import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { ContextualGemmaDiagnostic, CONTEXTUAL_FIXTURES, diagnosticSummary, requireDebugDiagnostic, type MemorySample } from '../modules/gemma-poc/contextualDiagnostic.ts';
import { GemmaPoc, type Context } from '../modules/gemma-poc/controller.ts';
import { acknowledgmentCandidates, acknowledgmentContext, acknowledgmentPrompt, canGenerateAcknowledgment } from '../lib/assistant/safetyAcknowledgment.ts';
Object.defineProperty(globalThis, '__DEV__', { value: true, writable: true, configurable: true });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const sample: MemorySample = { status: 'available', devicePhysicalBytes: 8e9, availableToProcessBytes: 2e9, residentBytes: 3e8, physicalFootprintBytes: 4e8, uptimeMs: 123 };
function fixture(override: Partial<Context> = {}) {
  let now = 0, loads = 0, releases = 0, stops = 0, snapshots = 0; const prompts: string[] = [];
  const runtime = new GemmaPoc({ verify: async () => { now += 2; return true; }, provision: async () => { throw Error('must not provision'); },
    initialize: async () => { loads++; now += 3; return {
      generate: async prompt => { prompts.push(prompt); now += 5;
        const context = CONTEXTUAL_FIXTURES.map(f => acknowledgmentContext(f.event, f.language, f.statement))
          .find(c => canGenerateAcknowledgment(c) && acknowledgmentPrompt(c) === prompt)!;
        return acknowledgmentCandidates(context)[0]!;
      }, stop: async () => { stops++; }, release: async () => { releases++; now += 7; }, ...override,
    }; },
  });
  const deps = { current: () => true, now: () => now, osVersion: 'fixture-os', memory: async (): Promise<MemorySample> => { snapshots++; now += 100; return sample; } };
  const runner = new ContextualGemmaDiagnostic(runtime, deps);
  return { runtime, runner, deps, prompts, get loads() { return loads; }, get releases() { return releases; }, get stops() { return stops; }, get snapshots() { return snapshots; } };
}

test('mocked native suite uses all unchanged production prompts/validation and separates lifecycle from memory sampling', async () => {
  const f = fixture(); const report = await f.runner.run(() => {});
  assert.equal(report.status, 'complete'); assert.equal(report.rows.length, 12);
  assert.equal(f.loads, 6); assert.equal(f.releases, 6); assert.equal(f.snapshots, 24);
  assert.deepEqual(f.prompts, CONTEXTUAL_FIXTURES.map(f => acknowledgmentContext(f.event, f.language, f.statement)).filter(canGenerateAcknowledgment).map(acknowledgmentPrompt));
  for (const row of report.rows) {
    if (row.inferenceSkipped) {
      assert.equal(row.fallbackReason, 'ineligible_statement'); assert.equal(row.generatedOutput, null);
      assert.equal(row.loadOperationMs, null); assert.equal(row.inferenceMs, null); assert.equal(row.releaseOperationMs, null);
      assert.equal(row.validationAccepted, false); assert.deepEqual(row.memory, {}); continue;
    }
    assert.equal(row.validationAccepted, true); assert.equal(row.fallbackReason, 'accepted'); assert.equal(row.releaseSucceeded, true);
    assert.equal(row.loadOperationMs, 5); assert.equal(row.inferenceOperationMs, 5); assert.equal(row.releaseOperationMs, 7);
    assert.equal(row.operationSumMs, 17); assert.equal(typeof row.initializationMs, 'number'); assert.equal(typeof row.inferenceMs, 'number');
    assert.deepEqual(row.memory.afterRelease, sample); assert.equal(row.statementOmitted, row.kind !== 'grounded');
  }
  assert.deepEqual(diagnosticSummary(report.rows, 'es'), { cases: 6, skipped: 3, attempted: 3, completedOutput: 3, accepted: 3, released: 3 });
  assert.equal(diagnosticSummary(report.rows, 'en', 'grounded').attempted, 3); assert.equal(report.peakNativeMemoryMeasured, false);
});

test('invalid and empty completions retain raw output, rejection reason and localized fallback', async () => {
  for (const text of ['Call mom. You are safe to drive.', '']) {
    const report = await fixture({ generate: async () => text }).runner.run(() => {});
    for (const row of report.rows.filter(row => !row.inferenceSkipped)) {
      assert.equal(row.generatedOutput, text); assert.equal(row.validationAccepted, false); assert.equal(row.validatedText, null);
      assert.equal(row.fallbackReason, text ? 'validator_rejected' : 'empty_output');
      assert.equal(row.fallbackText, row.language === 'en' ? "I'm sorry to hear that." : 'Lamento que te sientas así.');
    }
  }
});

test('production timeout stops generation, retains native ownership and discards late output', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const output = deferred<string>(); const f = fixture({ generate: () => output.promise });
  const pending = f.runner.run(() => {}); await tick(); t.mock.timers.tick(1500); await tick();
  assert.equal(f.stops, 1); assert.equal(f.releases, 0); assert.equal(f.runtime.state.busy, true);
  output.resolve("I'm sorry you're feeling dizzy."); const report = await pending;
  assert.equal(report.rows[0]!.fallbackReason, 'inference_timeout'); assert.equal(report.rows[0]!.generatedOutput, null);
  assert.equal(report.rows[0]!.releaseSucceeded, true);
});

test('cancel and duplicate run preserve ownership; cancelled output never advances to another fixture', async () => {
  const output = deferred<string>(); const f = fixture({ generate: () => output.promise });
  const pending = f.runner.run(() => {}); await tick(); await assert.rejects(f.runner.run(() => {}), /Unload/);
  f.runner.cancel(); assert.equal(f.stops, 1); assert.equal(f.releases, 0);
  output.resolve("I'm sorry you're feeling dizzy."); const report = await pending;
  assert.equal(report.status, 'cancelled'); assert.equal(report.rows.length, 1); assert.equal(report.rows[0]!.generatedOutput, null);
  assert.equal(f.releases, 1); assert.equal(f.loads, 1);
});

test('cancelled initialization releases its late context without inference', async () => {
  const init = deferred<Context>(); let releases = 0, generates = 0;
  const runtime = new GemmaPoc({ verify: async () => true, provision: async () => {}, initialize: () => init.promise });
  const runner = new ContextualGemmaDiagnostic(runtime, { current: () => true, now: () => performance.now(), osVersion: 'fixture', memory: async () => sample });
  const pending = runner.run(() => {}); await tick(); runner.cancel();
  init.resolve({ generate: async () => { generates++; return 'bad'; }, stop: async () => {}, release: async () => { releases++; } });
  const report = await pending; assert.equal(report.status, 'cancelled'); assert.equal(generates, 0); assert.equal(releases, 1);
});

test('model absence and release failure stop the suite; absent memory diagnostics do not', async () => {
  const runtime = new GemmaPoc({ verify: async () => false, provision: async () => { throw Error('must not provision'); }, initialize: async () => { throw Error('must not load'); } });
  const missing = new ContextualGemmaDiagnostic(runtime, { current: () => true, now: () => 0, osVersion: 'fixture', memory: async () => { throw Error('missing'); } });
  const report = await missing.run(() => {}); assert.equal(report.status, 'error'); assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0]!.fallbackReason, 'initialization_error'); assert.equal(report.rows[0]!.initializationMs, null);
  assert.equal(diagnosticSummary(report.rows, 'en').attempted, 0);
  const failed = fixture({ release: async () => { throw Error('release failed'); } });
  const failReport = await failed.runner.run(() => {}); assert.equal(failReport.status, 'error'); assert.equal(failReport.rows.length, 1);
  assert.equal(failReport.rows[0]!.fallbackReason, 'release_error'); assert.equal(failed.runtime.state.loaded, true);
  const noMemory = fixture(); noMemory.deps.memory = async () => { throw Error('missing bridge'); };
  const memoryReport = await noMemory.runner.run(() => {}); assert.equal(memoryReport.status, 'complete');
  assert.equal(memoryReport.rows[0]!.memory.beforeLoad?.status, 'unavailable');
});

test('runner never steals a loaded context or one acquired during snapshot sampling', async () => {
  const f = fixture(); await f.runtime.load(); await assert.rejects(f.runner.run(() => {}), /Unload/); assert.equal(f.releases, 0); await f.runtime.dispose();
  const other = fixture(); other.deps.memory = async () => { await other.runtime.load(); return sample; };
  const report = await other.runner.run(() => {}); assert.equal(report.status, 'error');
  assert.equal(report.rows[0]!.fallbackReason, 'runtime_owned'); assert.equal(other.releases, 0); await other.runtime.dispose();
});

test('Release cannot construct or invoke the suite or look up memory methods', async () => {
  const f = fixture(); (globalThis as any).__DEV__ = false;
  try {
    assert.throws(() => fixture(), /Debug/); await assert.rejects(f.runner.run(() => {}), /Debug/);
    let lookups = 0; const exports: any = {};
    const source = readFileSync(new NodeURL('../modules/gemma-poc/diagnosticMemory.ts', import.meta.url), 'utf8');
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
      exports, require: (name: string) => name === 'expo' ? { requireOptionalNativeModule: () => { lookups++; return {}; } } : { requireDebugDiagnostic },
    });
    await assert.rejects(exports.readGemmaDiagnosticMemory(), /Debug/); assert.equal(lookups, 0); assert.equal(f.loads, 0);
  } finally { (globalThis as any).__DEV__ = true; }
});

test('no diagnostic dependency can access safety actions, persistence or personal input; native methods compile only in Debug', () => {
  const read = (path: string) => readFileSync(new NodeURL(path, import.meta.url), 'utf8');
  for (const path of ['../modules/gemma-poc/contextualDiagnostic.ts', '../modules/gemma-poc/diagnosticMemory.ts'])
    assert.doesNotMatch(read(path), /SafetyController|VoiceCheck\(|Linking|supabase|repositories|writeAsString|AsyncStorage|TextInput|console\./);
  const screen = read('../modules/gemma-poc/GemmaDiagnostic.tsx');
  assert.match(screen, /contextual = __DEV__ \? require/); assert.match(screen, /memory = __DEV__ \? require/);
  assert.match(screen, /runner\?\.cancel\(\)/); assert.match(screen, /JSON.stringify\(report/);
  assert.match(read('../modules/model-file-hash/ios/ModelFileHashModule.swift'), /#if DEBUG\s+AsyncFunction\("gemmaMemorySnapshot"\)[\s\S]*?#endif/);
  const helper = read('../modules/model-file-hash/ios/ModelFileHashModule.swift').split('// BEGIN DEBUG GEMMA MEMORY\n')[1]!.split('// END DEBUG GEMMA MEMORY')[0]!;
  assert.ok(helper.startsWith('#if DEBUG')); assert.ok(helper.trimEnd().endsWith('#endif'));
  assert.match(helper, /os_proc_available_memory/); assert.match(helper, /phys_footprint/);
});

test('an unresponsive optional memory probe times out without blocking inference or cleanup', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); let calls = 0;
  f.deps.memory = () => ++calls === 1 ? new Promise(() => {}) : Promise.resolve(sample);
  const pending = f.runner.run(() => {}); await tick(); assert.equal(f.loads, 0);
  t.mock.timers.tick(1000); const report = await pending;
  assert.equal(report.status, 'complete'); assert.deepEqual(report.rows[0]!.memory.beforeLoad, { status: 'unavailable', reason: 'snapshot_timeout' });
  assert.equal(f.loads, 6); assert.equal(f.releases, 6);
});

test('background/inactive lifetime cannot publish late output or start the next fixture', async () => {
  const output = deferred<string>(); const f = fixture({ generate: () => output.promise });
  let current = true, publications = 0; f.deps.current = () => current;
  const pending = f.runner.run(() => { publications++; }); await tick(); const before = publications;
  current = false; f.runner.cancel(); output.resolve("I'm sorry you're feeling dizzy.");
  const report = await pending; assert.equal(report.status, 'cancelled'); assert.equal(publications, before);
  assert.equal(report.rows[0]!.generatedOutput, null); assert.equal(f.loads, 1); assert.equal(f.releases, 1);
});

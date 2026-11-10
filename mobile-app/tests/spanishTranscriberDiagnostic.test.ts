import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { URL as NodeURL } from 'node:url';
import ts from 'typescript';

const source = readFileSync(new NodeURL('../modules/local-foundation-models/index.ts', import.meta.url), 'utf8');
function bridge(dev: boolean, native: Record<string, unknown> = {}) {
  let lookups = 0;
  const exports: any = {};
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'exports', '__DEV__', compiled)((name: string) => {
    if (name === 'expo') return { requireOptionalNativeModule: () => { lookups++; return native; } };
    if (name === 'react-native') return { Platform: { OS: 'ios' } };
    throw new Error(`Unexpected dependency ${name}`);
  }, exports, dev);
  return { api: exports, lookups: () => lookups };
}

test('production rejects every new diagnostic entry point before looking up native methods', async () => {
  const { api, lookups } = bridge(false);
  await assert.rejects(api.checkSpanishTranscriberCapability(), /development build/);
  await assert.rejects(api.testSpanishOfflineTranscription('test'), /development build/);
  await assert.rejects(api.cancelSpanishOfflineTranscription('test'), /development build/);
  assert.throws(() => api.subscribeSpanishTranscriberTestProgress(() => {}), /development build/);
  assert.equal(lookups(), 0);
});

test('conflicting inventory signals do not assert missing assets or readiness', () => {
  const { api } = bridge(true);
  for (const assetStatus of ['supported', 'downloading', 'unsupported', 'unknown']) {
    assert.equal(api.spanishTranscriberReadiness({ locale: 'es-US', installedLocale: true, assetStatus }), 'Inventory signals differ; readiness uncertain');
  }
  assert.equal(api.spanishTranscriberReadiness({ installedLocale: false, assetStatus: 'installed' }), 'Inventory signals differ; readiness uncertain');
  assert.equal(api.spanishTranscriberReadiness({ installedLocale: true, assetStatus: 'installed' }), 'Readiness reported; offline test required');
});

test('capability queries do not run microphone tests; test and cancellation preserve request IDs', async () => {
  const calls: string[] = [];
  const capability = { status: 'available', reservedLocales: [] };
  const { api } = bridge(true, {
    checkSpanishTranscriberCapability: async () => { calls.push('query'); return capability; },
    testSpanishOfflineTranscription: async (id: string) => { calls.push(`test:${id}`); return { status: 'success', transcript: 'Sí, estoy bien.' }; },
    cancelSpanishOfflineTranscription: async (id: string) => { calls.push(`cancel:${id}`); },
  });
  assert.equal(await api.checkSpanishTranscriberCapability(), capability);
  assert.deepEqual(calls, ['query']);
  assert.equal((await api.testSpanishOfflineTranscription('isolated')).transcript, 'Sí, estoy bien.');
  await api.cancelSpanishOfflineTranscription('isolated');
  assert.deepEqual(calls, ['query', 'test:isolated', 'cancel:isolated']);
  await assert.rejects(bridge(true).api.testSpanishOfflineTranscription('test'), /Rebuild the Debug app/);
});

test('native permission waiter tolerates cancellation before registration and late permission callbacks', { skip: process.platform !== 'darwin' }, () => {
  const swift = readFileSync(new NodeURL('../modules/local-foundation-models/ios/LocalFoundationModelsModule.swift', import.meta.url), 'utf8');
  const waiter = swift.split('private final class DiagnosticPermissionWaiter')[1]?.split('#if DEBUG')[0];
  assert.ok(waiter);
  const directory = mkdtempSync(join(tmpdir(), 'drivesense-spanish-permission-'));
  const file = join(directory, 'Permission.swift');
  writeFileSync(file, `import Foundation
final class DiagnosticPermissionWaiter${waiter}
@main struct Test {
  static func main() async {
    let cancelled = DiagnosticPermissionWaiter()
    cancelled.resolve(false)
    let early: Bool = await withCheckedContinuation { cancelled.install($0) }
    assert(!early)
    cancelled.resolve(true)
    let pending = DiagnosticPermissionWaiter()
    let late: Bool = await withCheckedContinuation {
      pending.install($0)
      pending.resolve(false)
      pending.resolve(true)
    }
    assert(!late)
    let granted = DiagnosticPermissionWaiter()
    let result: Bool = await withCheckedContinuation {
      granted.install($0)
      granted.resolve(true)
      granted.resolve(false)
    }
    assert(result)
  }
}`);
  const binary = join(directory, 'permission-test');
  execFileSync('xcrun', ['swiftc', '-parse-as-library', '-module-cache-path', join(directory, 'module-cache'), file, '-o', binary], { stdio: 'pipe' });
  execFileSync(binary, [], { timeout: 10000 });
});

test('Spanish response state accepts finalized short responses and rejects unfinalized trailing speech', { skip: process.platform !== 'darwin' }, () => {
  const swift = readFileSync(new NodeURL('../modules/local-foundation-models/ios/LocalFoundationModelsModule.swift', import.meta.url), 'utf8');
  const state = swift.split('// BEGIN SPANISH RESPONSE STATE:')[1]?.split('// END SPANISH RESPONSE STATE')[0];
  assert.ok(state);
  const valueType = state.slice(state.indexOf('struct SpanishTranscriberResponse'));
  const directory = mkdtempSync(join(tmpdir(), 'drivesense-spanish-response-'));
  const file = join(directory, 'Response.swift');
  writeFileSync(file, `import Foundation
${valueType}
for phrase in ["sí", "no", "estoy bien"] {
  var response = SpanishTranscriberResponse()
  response.receive(phrase, isFinal: false, end: 0.4)
  assert(!response.complete)
  response.receive(phrase, isFinal: true, end: 0.4)
  assert(response.complete && response.text == phrase)
  response.receive(phrase, isFinal: true, end: 0.4)
  assert(response.text == phrase)
}
var revised = SpanishTranscriberResponse()
revised.receive("sí", isFinal: true, end: 0.3)
revised.receive("no estoy bien", isFinal: false, end: 1.2)
assert(!revised.complete)
revised.receive("no estoy bien", isFinal: true, end: 1.2)
assert(revised.complete && revised.text == "sí no estoy bien")
var invalid = SpanishTranscriberResponse()
invalid.receive("sí", isFinal: true, end: 0.3)
invalid.receive("", isFinal: true, end: 0.5)
assert(!invalid.complete)
var noSpeech = SpanishTranscriberResponse()
assert(!noSpeech.complete && noSpeech.text.isEmpty)
`);
  const binary = join(directory, 'response-test');
  execFileSync('xcrun', ['swiftc', '-module-cache-path', join(directory, 'module-cache'), file, '-o', binary], { stdio: 'pipe' });
  execFileSync(binary, [], { timeout: 10000 });
});

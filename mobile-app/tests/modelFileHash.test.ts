import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { verifyNativeFile, type HashBridge, type HashResult } from '../modules/model-file-hash/verification.ts';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const expected = { bytes: 3, sha256: createHash('sha256').update('abc').digest('hex') };
function fixture() {
  let listener: Parameters<HashBridge['addListener']>[1] = () => {};
  let resolve!: (r: HashResult) => void;
  let requestId = '', cancels = 0, removes = 0;
  const bridge: HashBridge = {
    hashFile: async (_uri, id) => { requestId = id; return new Promise(r => { resolve = r; }); },
    cancelHash: async () => { cancels++; },
    addListener: (_event, next) => { listener = next; return { remove: () => { removes++; } }; },
  };
  return { bridge, complete: (change: Partial<HashResult> = {}) => resolve({ requestId, ...expected, ...change }),
    emit: (bytes: number, id = requestId) => listener({ requestId: id, bytes, total: expected.bytes }),
    counts: () => ({ cancels, removes }), id: () => requestId };
}
test('native digest must match exact size, identity and expected SHA-256; progress is scoped', async () => {
  const f = fixture(); const progress: number[] = [];
  const done = verifyNativeFile(f.bridge, 'file:///model', expected, new AbortController().signal, n => progress.push(n));
  f.emit(0); f.emit(2); f.emit(1); f.emit(2); f.emit(3, 'old'); f.emit(4);
  f.complete(); assert.equal(await done, true); f.emit(3);
  assert.deepEqual(progress, [0, 2]); assert.equal(f.counts().removes, 1);
});
test('checksum mismatch, incomplete result and stale identity cannot verify', async () => {
  for (const change of [{ sha256: 'wrong' }, { bytes: 2 }, { requestId: 'old' }]) {
    const f = fixture(); const pending = verifyNativeFile(f.bridge, 'file:///model', expected, new AbortController().signal);
    f.complete(change); await assert.rejects(pending, /integrity/); assert.equal(f.counts().removes, 1);
  }
});
test('cancelled hash stays pending until native closes the file, discards late success, then can retry', async () => {
  const f = fixture(); const abort = new AbortController();
  const first = verifyNativeFile(f.bridge, 'file:///model', expected, abort.signal);
  let settled = false; void first.catch(() => { settled = true; });
  const id = f.id(); abort.abort(); await tick();
  assert.equal(f.counts().cancels, 1); assert.equal(settled, false);
  f.complete(); await assert.rejects(first, /cancelled/);
  const second = verifyNativeFile(f.bridge, 'file:///model', expected, new AbortController().signal);
  assert.notEqual(f.id(), id); f.complete(); assert.equal(await second, true);
});
test('already cancelled hashes never enter native code; native errors release event listeners', async () => {
  const f = fixture(); const abort = new AbortController(); abort.abort();
  await assert.rejects(verifyNativeFile(f.bridge, 'file:///model', expected, abort.signal), /cancelled/);
  assert.equal(f.id(), '');
  f.bridge.hashFile = async () => { throw Error('file missing or truncated'); };
  await assert.rejects(verifyNativeFile(f.bridge, 'file:///model', expected, new AbortController().signal), /truncated/);
  assert.equal(f.counts().removes, 1);
});
test('repeated verification rehashes and detects subsequent corruption instead of caching trust', async () => {
  const f = fixture();
  const first = verifyNativeFile(f.bridge, 'file:///model', expected, new AbortController().signal); f.complete(); await first;
  const next = verifyNativeFile(f.bridge, 'file:///model', expected, new AbortController().signal); f.complete({ sha256: 'changed' });
  await assert.rejects(next, /integrity/);
});
test('real iOS streaming SHA-256 matches Node crypto; rejects short files and cancellation', { skip: process.platform !== 'darwin' }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'drivesense-sha256-'));
  try {
    const path = join(directory, 'fixture.bin');
    const payload = Buffer.alloc(3 * 1024 * 1024 + 17, 0x61); writeFileSync(path, payload);
    const source = readFileSync(new NodeURL('../modules/model-file-hash/ios/FileSHA256.swift', import.meta.url), 'utf8');
    const script = join(directory, 'verify.swift');
    writeFileSync(script, `${source}
      let url = URL(fileURLWithPath: ${JSON.stringify(path)})
      for _ in 0..<2 {
        let hash = try streamFileSHA256(url, expectedBytes: ${payload.length}, cancelled: { false }, progress: { _ in })
        assert(hash == "${createHash('sha256').update(payload).digest('hex')}")
      }
      do {
        _ = try streamFileSHA256(url, expectedBytes: ${payload.length + 1}, cancelled: { false }, progress: { _ in })
        fatalError("short file accepted")
      } catch FileHashError.invalidSize {}
      do {
        _ = try streamFileSHA256(url, expectedBytes: ${payload.length}, cancelled: { true }, progress: { _ in })
        fatalError("cancelled hash accepted")
      } catch FileHashError.cancelled {}
      print("native SHA-256 passed")
    `);
    assert.match(execFileSync('xcrun', ['swift', '-module-cache-path', join(directory, 'cache'), script], { encoding: 'utf8' }), /native SHA-256 passed/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

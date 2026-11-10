import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

test('native cue completion and cancellation resume once; late delegate callbacks cannot resume again', { skip: process.platform !== 'darwin' }, () => {
  const source = readFileSync(new NodeURL('../modules/local-foundation-models/ios/LocalSpeechPlayback.swift', import.meta.url), 'utf8');
  const operation = source.split('  @MainActor private final class Operation')[1]?.split('  private var active:')[0];
  assert.ok(operation);
  const directory = mkdtempSync(join(tmpdir(), 'drivesense-cue-completion-'));
  const script = join(directory, 'Cue.swift');
  writeFileSync(script, `import Foundation
import AVFoundation
@MainActor final class Operation${operation}
@main struct Test {
  @MainActor static func main() async {
    let finished = Operation("success")
    do {
      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
        finished.completion = continuation
        finished.finish()
        finished.finish(NSError(domain: "late", code: 1))
      }
    } catch { preconditionFailure("Late failure replaced successful completion") }
    assert(finished.completion == nil)
    let cancelled = Operation("cancelled")
    do {
      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
        cancelled.completion = continuation
        cancelled.finish(CancellationError())
        cancelled.finish()
      }
      preconditionFailure("Cancellation became success")
    } catch is CancellationError {} catch { preconditionFailure("Wrong cancellation error") }
    assert(cancelled.completion == nil)
  }
}`);
  const binary = join(directory, 'cue-test');
  execFileSync('xcrun', ['swiftc', '-parse-as-library', '-swift-version', '5', '-module-cache-path', join(directory, 'cache'), script, '-o', binary], { stdio: 'pipe' });
  execFileSync(binary, [], { timeout: 10000 });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { URL as NodeURL } from 'node:url';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

test('native graceful finish is once-only and rejects premature, cancelled and stale captures', { skip: process.platform !== 'darwin' }, () => {
  const source = readFileSync(new NodeURL('../modules/local-foundation-models/ios/OfflineSpeechDiagnostic.swift', import.meta.url), 'utf8');
  const method = source.match(/  private func finishRecognitionTask\(_ current: Capture\) \{[\s\S]*?\n  \}/)?.[0];
  assert.ok(method);
  const endpoint = source.split('  private func beginFinalizing(')[1]?.split('  private func endRequestAudio(')[0];
  assert.ok(endpoint);
  assert.match(endpoint, /guard capture === current, current.phase == "listening"/);
  assert.match(endpoint, /stopCapture\(current\)\s+endRequestAudio\(current\)\s+finishRecognitionTask\(current\)/);
  const cleanup = source.split('  private func finish(_ requestId:')[1];
  assert.ok(cleanup);
  assert.doesNotMatch(cleanup, /finishRecognitionTask\(current\)/);
  const directory = mkdtempSync(join(tmpdir(), 'drivesense-finalization-'));
  try {
    const script = join(directory, 'regression.swift');
    writeFileSync(script, `import Foundation
      final class RecognitionTask {
        var finishes = 0
        func finish() { finishes += 1 }
      }
      final class Capture {
        var phase = "listening"
        var audioEnded = false
        var taskFinishRequested = false
        var task: RecognitionTask? = RecognitionTask()
      }
      final class Harness {
        var capture: Capture?
        ${method.replace('private func', 'func')}
      }
      let owner = Harness()
      let current = Capture()
      owner.capture = current
      owner.finishRecognitionTask(current)
      assert(current.task!.finishes == 0)
      current.phase = "finalizing"
      owner.finishRecognitionTask(current)
      assert(current.task!.finishes == 0)
      current.audioEnded = true
      owner.finishRecognitionTask(current)
      owner.finishRecognitionTask(current)
      assert(current.task!.finishes == 1 && current.taskFinishRequested)
      // Native cleanup invalidates capture before cancelling on timeout/cancellation.
      for _ in ["timeout", "cancelled", "completed"] {
        let stale = Capture()
        stale.phase = "finalizing"
        stale.audioEnded = true
        owner.capture = stale
        owner.capture = nil
        owner.finishRecognitionTask(stale)
        assert(stale.task!.finishes == 0 && !stale.taskFinishRequested)
      }
      let replacement = Capture()
      owner.capture = replacement
      owner.finishRecognitionTask(current)
      assert(current.task!.finishes == 1 && replacement.task!.finishes == 0)
      replacement.phase = "finalizing"
      replacement.audioEnded = true
      replacement.task = nil
      owner.finishRecognitionTask(replacement)
      assert(!replacement.taskFinishRequested)
      print("PASS")
    `);
    const output = execFileSync('xcrun', ['swift', '-module-cache-path', join(directory, 'cache'), script],
      { encoding: 'utf8', timeout: 60000 });
    assert.match(output, /PASS/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

// Execute the actual pure Swift state from the recognizer, without Speech,
// AVFoundation, Expo, signing, or an iOS build. Other hosts retain the JS tests.
test('native transcript state preserves partial speech without manufacturing a final result', { skip: process.platform !== 'darwin' }, () => {
  const source = readFileSync(new NodeURL('../modules/local-foundation-models/ios/OfflineSpeechDiagnostic.swift', import.meta.url), 'utf8');
  const state = source.split('// BEGIN TRANSCRIPT STATE:')[1]?.split('\n').slice(1).join('\n').split('// END TRANSCRIPT STATE')[0];
  assert.ok(state, 'native transcript state must be available for regression validation');
  const directory = mkdtempSync(join(tmpdir(), 'drivesense-transcripts-'));
  try {
    const script = join(directory, 'regression.swift');
    writeFileSync(script, `import Foundation\n${state}\n
      var empty = OfflineRecognitionTranscripts()
      empty.receive("", isFinal: true)
      assert(empty.finalResultReceived && !empty.hasFinalTranscript)
      assert(empty.emptyFinalReason == "no_speech")
      var partial = OfflineRecognitionTranscripts()
      partial.receive("Yes please", isFinal: false)
      partial.receive("", isFinal: false)
      assert(partial.displayTranscript == "Yes please" && !partial.finalResultReceived)
      partial.receive("   ", isFinal: true)
      assert(partial.partialTranscript == "Yes please" && partial.finalTranscript.isEmpty)
      assert(partial.displayTranscript == "Yes please")
      assert(partial.finalResultReceived && !partial.hasFinalTranscript)
      assert(partial.emptyFinalReason == "empty_final_after_partial")
      var completed = OfflineRecognitionTranscripts()
      completed.receive("Yes", isFinal: false)
      completed.receive("Yes please", isFinal: true)
      assert(completed.partialTranscript == "Yes")
      assert(completed.finalTranscript == "Yes please" && completed.hasFinalTranscript)
      assert(completed.displayTranscript == "Yes please")
      print("PASS")
    `);
    const output = execFileSync('xcrun', ['swift', '-module-cache-path', join(directory, 'cache'), script],
      { encoding: 'utf8', timeout: 60000 });
    assert.match(output, /PASS/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

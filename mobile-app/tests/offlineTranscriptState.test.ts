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

test('native bounded noise calibration and endpoint decisions', { skip: process.platform !== 'darwin' }, () => {
  const source = readFileSync(new NodeURL('../modules/local-foundation-models/ios/OfflineSpeechDiagnostic.swift', import.meta.url), 'utf8');
  const state = source.split('// BEGIN ENDPOINT STATE:')[1]?.split('\n').slice(1).join('\n').split('// END ENDPOINT STATE')[0];
  assert.ok(state);
  const directory = mkdtempSync(join(tmpdir(), 'drivesense-endpoint-'));
  try {
    const script = join(directory, 'regression.swift');
    writeFileSync(script, `import Foundation
      ${state}
      func feed(_ state: inout OfflineEndpointState, _ level: Double, _ frames: Int, _ time: inout Double) {
        for _ in 0..<frames { time += 0.02; state.receive(level: level, duration: 0.02, now: time) }
      }
      var quiet = OfflineEndpointState(); var q = 0.0
      feed(&quiet, -65, 31, &q)
      assert(quiet.ready && quiet.thresholdDb == -48 && quiet.samples.isEmpty)
      feed(&quiet, -46, 15, &q); feed(&quiet, -65, 60, &q)
      assert(quiet.endpoint(now: q, speechRecognized: true, deadline: 15) == nil)
      // A continuation or refusal resets the full silence interval.
      feed(&quiet, -44, 10, &q); feed(&quiet, -65, 60, &q)
      assert(quiet.endpoint(now: q, speechRecognized: true, deadline: 15) == nil)
      feed(&quiet, -65, 7, &q)
      assert(quiet.endpoint(now: q, speechRecognized: true, deadline: 15) == "audio_silence")
      assert(quiet.endpoint(now: q, speechRecognized: false, deadline: 15) == nil)
      assert(quiet.endpoint(now: q + 1, speechRecognized: true, deadline: 15) == nil) // stalled tap
      var noisy = OfflineEndpointState(); var n = 0.0
      feed(&noisy, -38.2, 31, &n)
      assert(noisy.calibration == "stable" && abs(noisy.thresholdDb + 32.2) < 0.001)
      feed(&noisy, -27, 20, &n); feed(&noisy, -38.2, 67, &n)
      assert(noisy.endpoint(now: n, speechRecognized: true, deadline: 15) == "audio_silence")
      assert((noisy.diagnostics(now: n)["aboveThresholdFraction"] as! Double) < 0.6)
      var robust = OfflineEndpointState(); var r = 0.0
      feed(&robust, -38.2, 15, &r); feed(&robust, -10, 1, &r); feed(&robust, -38.2, 15, &r)
      assert(abs(robust.thresholdDb + 32.2) < 0.001)
      var immediate = OfflineEndpointState(); var i = 0.0
      for _ in 0..<16 { feed(&immediate, -45, 1, &i); feed(&immediate, -30, 1, &i) }
      assert(immediate.calibration == "variable_input" && immediate.thresholdDb == -48)
      // Delayed Apple evidence also invalidates steady speech in the initial window.
      var early = OfflineEndpointState(); var e = 0.0
      feed(&early, -35, 31, &e); early.recognizedSpeech(startSeconds: 0.05, now: e + 0.5)
      assert(early.calibration == "speech_during_calibration" && early.thresholdDb == -48)
      var during = OfflineEndpointState(); var d = 0.0
      feed(&during, -35, 5, &d); during.recognizedSpeech(startSeconds: 0, now: d)
      feed(&during, -35, 40, &d)
      assert(during.thresholdDb == -48 && during.samples.isEmpty)
      let floor = noisy.noiseFloorDb
      feed(&noisy, -24, 500, &n)
      assert(noisy.noiseFloorDb == floor && noisy.thresholdDb < -32)
      assert(noisy.endpoint(now: n, speechRecognized: true, deadline: 30) == nil)
      assert(noisy.endpoint(now: 12.5, speechRecognized: true, deadline: 15) == "capture_budget")
      assert(noisy.endpoint(now: 12.5, speechRecognized: false, deadline: 15) == nil)
      print("PASS")
    `);
    assert.match(execFileSync('xcrun', ['swift', '-module-cache-path', join(directory, 'cache'), script],
      { encoding: 'utf8', timeout: 60000 }), /PASS/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

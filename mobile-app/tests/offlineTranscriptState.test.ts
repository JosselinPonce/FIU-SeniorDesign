import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { URL as NodeURL } from 'node:url';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

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

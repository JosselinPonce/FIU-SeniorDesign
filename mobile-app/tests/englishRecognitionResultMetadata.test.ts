import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const native = readFileSync(new NodeURL('../modules/local-foundation-models/ios/OfflineSpeechDiagnostic.swift', import.meta.url), 'utf8');

test('actual result metadata distinguishes empty best, punctuation, segments and alternatives without retaining content', { skip: process.platform !== 'darwin' }, () => {
  const helper = native.split('// BEGIN ENGLISH RESULT METADATA:')[1].split('\n').slice(1).join('\n').split('// END ENGLISH RESULT METADATA')[0];
  const transcripts = native.split('// BEGIN TRANSCRIPT STATE:')[1].split('\n').slice(1).join('\n').split('// END TRANSCRIPT STATE')[0];
  const folder = mkdtempSync(join(tmpdir(), 'drivesense-result-metadata-'));
  const file = join(folder, 'Result.swift');
  writeFileSync(file, `import Foundation
struct Segment { let substring: String }
struct Transcription { var formattedString: String; var segments: [Segment] }
final class SFSpeechRecognitionResult {
  var bestTranscription: Transcription; let isFinal: Bool; let transcriptions: [Transcription]
  init(_ best: Transcription, final: Bool, alternatives: [Transcription] = []) {
    bestTranscription = best; isFinal = final; transcriptions = [best] + alternatives
  }
}
${helper}
${transcripts}
func run() throws {
  let words = Transcription(formattedString: "PRIVATE SYNTHETIC YES", segments: [Segment(substring: "PRIVATE")])
  let empty = Transcription(formattedString: " \\n ", segments: [])
  let partial = SFSpeechRecognitionResult(words, final: false)
  assert(englishRecognitionResultMetadata(nil)["resultPresent"] as? Bool == false)
  assert(englishRecognitionResultMetadata(partial)["rawIsFinal"] as? Bool == false)
  let final = SFSpeechRecognitionResult(empty, final: true, alternatives: [words])
  let snapshot = englishRecognitionResultMetadata(final)
  assert(snapshot["rawIsFinal"] as? Bool == true && snapshot["bestTrimmedPresent"] as? Bool == false)
  assert(snapshot["segmentCount"] as? Int == 0 && snapshot["hasNonemptySegment"] as? Bool == false)
  assert(snapshot["transcriptionCount"] as? Int == 2 && snapshot["nonemptyTranscriptionCount"] as? Int == 1)
  var state = OfflineRecognitionTranscripts()
  state.receive(words.formattedString, isFinal: false)
  state.receive(final.bestTranscription.formattedString, isFinal: true)
  assert(state.hasPartial && state.finalResultReceived && !state.hasFinalTranscript)
  assert(state.emptyFinalReason == "empty_final_after_partial") // alternatives never promoted
  let punctuation = SFSpeechRecognitionResult(Transcription(formattedString: "...", segments: []), final: true)
  let punctuationMetadata = englishRecognitionResultMetadata(punctuation)
  assert(punctuationMetadata["bestTrimmedPresent"] as? Bool == true && punctuationMetadata["bestAlphanumericPresent"] as? Bool == false)
  let odd = SFSpeechRecognitionResult(Transcription(formattedString: "", segments: words.segments), final: true)
  assert(englishRecognitionResultMetadata(odd)["hasNonemptySegment"] as? Bool == true)
  let before = englishRecognitionResultMetadata(partial)
  partial.bestTranscription = empty
  let after = englishRecognitionResultMetadata(partial)
  assert(before["bestTrimmedPresent"] as? Bool == true && after["bestTrimmedPresent"] as? Bool == false)
  // Mutable stub demonstrates that separate snapshots can reveal a difference;
  // it does not establish that Apple's objects mutate on the physical phone.
  let json = String(data: try JSONSerialization.data(withJSONObject: snapshot), encoding: .utf8)!
  assert(!json.contains("PRIVATE") && !json.contains("SYNTHETIC"))
  print("PASS")
}
try run()
`);
  const output = execFileSync('xcrun', ['swift', '-module-cache-path', join(folder, 'cache'), file], { encoding: 'utf8', timeout: 60000 });
  assert.match(output, /PASS/);
});

test('result observations are Debug-only, bounded, ownership guarded and do not select alternatives', () => {
  let depth = 0;
  const release = native.split('\n').filter(line => {
    if (line.trim() === '#if DEBUG') { depth++; return false; }
    if (line.trim() === '#endif') { depth--; return false; }
    return depth === 0;
  }).join('\n');
  for (const token of ['englishRecognitionResultMetadata', 'debugResultMetadata', 'debugRequestConfiguration', 'callbackResultMetadata', 'english-result-metadata-v1']) assert.equal(release.includes(token), false, token);
  const callback = native.split('current.task = recognizer.recognitionTask(with: request)')[1].split('current.timings.mark("recognitionPreparationCompleted")')[0];
  assert.ok(callback.indexOf('callbackResultMetadata =') < callback.indexOf('Task { @MainActor'));
  assert.ok(callback.indexOf('self.capture === current') < callback.indexOf('current.debugResultMetadata['));
  assert.match(callback, /debugResultMetadata\[metadataPoint \+ "AtCallback"\] == nil/);
  assert.match(callback, /current.transcripts.receive\(result.bestTranscription.formattedString, isFinal: result.isFinal\)/);
  assert.doesNotMatch(release, /transcriptions\[/);
  assert.match(release, /request.requiresOnDeviceRecognition = true/);
  assert.match(release, /request.shouldReportPartialResults = true/);
  assert.match(release, /request.taskHint = \.confirmation/);
});

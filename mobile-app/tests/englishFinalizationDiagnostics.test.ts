import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const native = readFileSync(new NodeURL('../modules/local-foundation-models/ios/OfflineSpeechDiagnostic.swift', import.meta.url), 'utf8');
function releaseSource(source: string) {
  let depth = 0;
  return source.split('\n').filter(line => {
    if (line.trim() === '#if DEBUG') { depth++; return false; }
    if (line.trim() === '#endif') { depth--; return false; }
    return depth === 0;
  }).join('\n');
}
test('new native metadata and milestones compile out of Release and never inspect transcript content', () => {
  const release = releaseSource(native);
  for (const marker of ['englishFinalizationDebug', 'rawAppleIsFinal', 'taskSnapshots', 'debugEndpointSelection', 'callbackReceivedAt',
    'inputStopRequested', 'inputStopped', 'engineTapStopRequested', 'engineTapStopped', 'endAudioRequested', 'endAudioReturned',
    'taskFinishRequested"', 'taskFinishReturned', 'appleFinalCallbackReceived', 'appleFinalCallbackHandled', 'cleanupCancelRequested', 'captureDeadlineReached']) {
    assert.equal(release.includes(marker), false, marker);
  }
  const report = native.split('report["englishFinalizationDebug"] = [')[1].split('#endif')[0];
  assert.doesNotMatch(report, /partialTranscript|finalTranscript|formattedString|localizedDescription|userInfo|audioPCM/);
  assert.match(report, /"captureId": current.id/);
  assert.match(report, /"endpointAtSelection": current.debugEndpointSelection/);
  const body = release.split('private func beginFinalizing(')[1].split('private func endRequestAudio(')[0];
  assert.match(body, /stopCapture\(current\)\s+endRequestAudio\(current\)\s+finishRecognitionTask\(current\)/);
  assert.match(body, /let grace = 2.5/);
  assert.equal((native.match(/current\.taskFinishRequested = true/g) ?? []).length, 1);
  assert.match(native, /guard let self, self.capture === current else \{ return \}\s+#if DEBUG/);
});
test('actual task snapshot helper records public state/error metadata without error messages', { skip: process.platform !== 'darwin' }, () => {
  const method = native.match(/    func snapshotTask\(_ point: String\) \{[\s\S]*?\n    \}/)![0];
  const folder = mkdtempSync(join(tmpdir(), 'drivesense-task-metadata-'));
  const file = join(folder, 'Snapshot.swift');
  writeFileSync(file, `import Foundation
    struct State { var rawValue = 2 }
    final class TaskStub { var state = State(); var isCancelled = false; var isFinishing = true; var error: Error? }
    final class Capture { var task: TaskStub? = TaskStub(); var taskSnapshots: [String: [String: Any]] = [:]
    ${method}
    }
    let c = Capture()
    c.task!.error = NSError(domain: "SpeechFixture", code: 1101, userInfo: [NSLocalizedDescriptionKey: "PRIVATE TEXT"])
    for _ in 0..<1000 { c.snapshotTask("callback") }
    assert(c.taskSnapshots.count == 1)
    let snapshot = c.taskSnapshots["callback"]!
    assert(snapshot["state"] as? Int == 2 && snapshot["isCancelled"] as? Bool == false)
    assert(snapshot["errorDomain"] as? String == "SpeechFixture" && snapshot["errorCode"] as? Int == 1101)
    assert(!String(describing: snapshot).contains("PRIVATE"))
    c.task!.isCancelled = true; c.snapshotTask("afterCleanupCancel")
    assert(c.taskSnapshots["afterCleanupCancel"]!["isCancelled"] as? Bool == true)
    c.task = nil; c.snapshotTask("missing"); assert(c.taskSnapshots.count == 2)
    print("PASS")`);
  const output = execFileSync('xcrun', ['swift', '-module-cache-path', join(folder, 'cache'), file], { encoding: 'utf8', timeout: 60000 });
  assert.match(output, /PASS/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
const native = readFileSync(new NodeURL('../modules/local-foundation-models/ios/OfflineSpeechDiagnostic.swift', import.meta.url), 'utf8');
const preparation = native.split('// BEGIN VOICE RECOGNITION PREPARATION')[1];

test('native prewarming never opens audio input, requests permission, starts recognition, changes sessions or installs assets', () => {
  assert.ok(preparation);
  for (const forbidden of ['AVAudioEngine(', 'installTap(', 'setCategory(', 'setActive(', 'requestRecordPermission', 'requestAuthorization', 'recognitionTask(', 'start(inputSequence:', 'assetInstallationRequest', 'downloadAndInstall']) {
    assert.equal(preparation.includes(forbidden), false, forbidden);
  }
  assert.match(preparation, /after == \.installed/);
  assert.match(preparation, /prepareToAnalyze\(in: format\)/);
  assert.match(preparation, /release\(reservedLocale:/);
});

test('real native preparation owner rejects stale activation, cancels pending work, disposes late results and expires unused resources', { skip: process.platform !== 'darwin' }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'drivesense-prewarm-'));
  const file = join(directory, 'Preparation.swift');
  const coordinator = preparation.slice(preparation.indexOf('/// Microphone-free work'))
    .replaceAll('20_000_000_000', '200_000_000').replaceAll('5_000_000_000', '100_000_000');
  writeFileSync(file, `import Foundation
@MainActor final class UIApplication {
  enum State { case active }
  static let shared = UIApplication(); var applicationState = State.active
  static let didEnterBackgroundNotification = Notification.Name("background")
}
let AVAudioSessionRouteChangeReasonKey = "routeReason"
enum AVAudioSession {
  enum RouteChangeReason: UInt { case categoryChange = 3 }
  static let interruptionNotification = Notification.Name("interruption")
  static let routeChangeNotification = Notification.Name("route")
}
@MainActor final class VoiceRecognitionTimings {
  var events: [String: Double] = [:]
  func mark(_ name: String) { events[name] = ProcessInfo.processInfo.systemUptime }
}
@MainActor class PreparedVoiceRecognition {
  let timings: VoiceRecognitionTimings; var recognizer: Int?; var disposals = 0
  init(locale: String, timings: VoiceRecognitionTimings) { self.timings = timings }
  func dispose() async -> [String] { disposals += 1; return [] }
}
@MainActor enum Control {
  static var waiter: CheckedContinuation<Void, Never>?
  static var built: PreparedVoiceRecognition?
}
@MainActor final class PreparedSpanishRecognition: PreparedVoiceRecognition {
  static func build(timings: VoiceRecognitionTimings) async throws -> PreparedVoiceRecognition {
    let value = PreparedSpanishRecognition(locale: "es-US", timings: timings); Control.built = value
    await withCheckedContinuation { Control.waiter = $0 }
    return value // Intentionally ignores cancellation, like a delayed native API.
  }
}
@MainActor final class OfflineSpeechDiagnostic {
  static let shared = OfflineSpeechDiagnostic(); let isBusy = false
  func prevalidate(_ locale: String) throws -> Int { 1 }
}
@MainActor final class LocalSpeechPlayback { static let shared = LocalSpeechPlayback(); let isBusy = false }
@MainActor final class SpanishOfflineRecognition { static let shared = SpanishOfflineRecognition(); let isBusy = false }
${coordinator}
@main struct Test {
  @MainActor static func spin() async { for _ in 0..<30 { await Task.yield() } }
  @MainActor static func rejected(_ id: String) async {
    do { _ = try await VoiceRecognitionPreparation.shared.consume("es-US", id: id); preconditionFailure("stale capture activated") }
    catch {}
  }
  @MainActor static func main() async throws {
    let owner = VoiceRecognitionPreparation.shared
    assert(owner.prepare("en-US", id: "english")["status"] as? String == "started")
    await spin()
    do { _ = try await owner.consume("en-US", id: "wrong"); preconditionFailure("wrong capture accepted") } catch {}
    let english = try await owner.consume("en-US", id: "english")!
    assert(english.recognizer == 1)
    assert(owner.isBusy && owner.permitsCapture("english") && !owner.permitsCapture("other"))
    await owner.cancel("english") // Active capture, not prewarm, owns disposal after handoff.
    assert(english.disposals == 0)
    _ = await english.dispose(); owner.finish("english")
    assert(!owner.isBusy)
    do { _ = try await owner.consume("en-US", id: "english"); preconditionFailure("completed capture reused") } catch {}

    _ = owner.prepare("es-US", id: "cancel")
    await spin(); assert(Control.waiter != nil)
    let cancelledValue = Control.built!
    let consuming = Task { await rejected("cancel") }
    await spin()
    let cancellation = Task { await owner.cancel("cancel") }
    await spin(); await consuming.value
    assert(owner.isBusy) // Retain ownership while a cancelled native operation is suspended.
    Control.waiter?.resume(); Control.waiter = nil
    await cancellation.value; await spin()
    assert(cancelledValue.disposals == 1 && !owner.isBusy)
    await rejected("cancel")

    _ = owner.prepare("es-US", id: "background")
    await spin(); let backgroundValue = Control.built!
    Control.waiter?.resume(); Control.waiter = nil; await spin()
    NotificationCenter.default.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
    await spin()
    assert(backgroundValue.disposals == 1)
    await rejected("background")

    _ = owner.prepare("es-US", id: "route")
    await spin(); let routeValue = Control.built!
    Control.waiter?.resume(); Control.waiter = nil; await spin()
    NotificationCenter.default.post(name: AVAudioSession.routeChangeNotification, object: nil,
      userInfo: [AVAudioSessionRouteChangeReasonKey: AVAudioSession.RouteChangeReason.categoryChange.rawValue])
    await spin(); assert(routeValue.disposals == 0 && owner.isBusy)
    NotificationCenter.default.post(name: AVAudioSession.routeChangeNotification, object: nil)
    await spin(); assert(routeValue.disposals == 1); await rejected("route")

    _ = owner.prepare("es-US", id: "interruption")
    await spin(); let interruptedValue = Control.built!
    Control.waiter?.resume(); Control.waiter = nil; await spin()
    NotificationCenter.default.post(name: AVAudioSession.interruptionNotification, object: nil)
    await spin(); assert(interruptedValue.disposals == 1); await rejected("interruption")

    _ = owner.prepare("en-US", id: "expired")
    try await Task.sleep(nanoseconds: 300_000_000)
    assert(!owner.isBusy)
    do { _ = try await owner.consume("en-US", id: "expired"); preconditionFailure("expired capture activated") } catch {}

    _ = owner.prepare("es-US", id: "timeout")
    await spin(); let timeoutValue = Control.built!
    await rejected("timeout") // The activation deadline expires while the builder is suspended.
    Control.waiter?.resume(); Control.waiter = nil; await spin()
    assert(timeoutValue.disposals == 1 && !owner.isBusy)
  }
}
`);
  const binary = join(directory, 'preparation');
  execFileSync('xcrun', ['swiftc', '-swift-version', '5', '-parse-as-library', '-module-cache-path', join(directory, 'cache'), file, '-o', binary], { stdio: 'pipe' });
  execFileSync(binary, [], { stdio: 'pipe', timeout: 15000 });
});

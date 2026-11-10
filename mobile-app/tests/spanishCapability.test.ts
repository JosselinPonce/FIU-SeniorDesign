import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
const native = readFileSync(new NodeURL('../modules/local-foundation-models/ios/LocalFoundationModelsModule.swift', import.meta.url), 'utf8');
const helper = native.split('// BEGIN SPANISH CAPABILITY REPORT')[1]!.split('// END SPANISH CAPABILITY REPORT')[0]!;
const inventory = native.slice(native.indexOf('@available(iOS 26.0, *)'), native.indexOf('// BEGIN SPANISH CAPABILITY REPORT'));

test('Spanish capability routes to the actual transcriber inventory; English keeps the legacy recognizer', () => {
  const bridge = native.split('AsyncFunction("checkOfflineSpeechCapability")')[1]!.split('AsyncFunction("prepareOfflineRecognition")')[0]!;
  assert.match(bridge, /if locale == "es-US".*SpanishSpeechCapability.report\(locale\)/);
  assert.match(bridge, /return await OfflineSpeechDiagnostic.shared.capability\(locale\)/);
  assert.match(helper, /supportedLocale\(equivalentTo:/); assert.match(helper, /\.progressiveTranscription/);
  assert.match(helper, /SpeechTranscriber.installedLocales/); assert.match(helper, /AssetInventory.status/);
  assert.match(helper, /requires_ios_26/); assert.match(helper, /capture is not verified/);
  assert.doesNotMatch(helper, /SFSpeechRecognizer\(locale:|\.supportsOnDeviceRecognition|\.isAvailable.*recognizer/);
  for (const operation of [/reserve\(/, /downloadAndInstall/, /SpeechAnalyzer\(/, /prepareToAnalyze/, /AVAudioEngine\(/,
    /requestAuthorization\(/, /requestRecordPermission\(/, /setCategory\(/, /setActive\(/]) assert.doesNotMatch(helper, operation);
});

test('real Swift capability logic handles hardware, equivalent locale, missing assets and conflicting inventory without audio', { skip: process.platform !== 'darwin' }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'drivesense-spanish-capability-'));
  const file = join(directory, 'Capability.swift'), executable = join(directory, 'capability');
  writeFileSync(file, `import Foundation
@MainActor enum State {
  static var available = true
  static var locale: Locale? = Locale(identifier: "es-MX")
  static var installed = [Locale(identifier: "es-MX")]
  static var status = AssetInventory.Status.installed
  static var queries = 0
}
@MainActor struct SpeechTranscriber {
  enum Preset { case progressiveTranscription }
  static var isAvailable: Bool { State.available }
  static func supportedLocale(equivalentTo: Locale) async -> Locale? { State.locale }
  static var installedLocales: [Locale] { get async { State.installed } }
  init(locale: Locale, preset: Preset) {}
}
@MainActor enum AssetInventory {
  enum Status { case installed, supported, downloading, unsupported }
  static func status(forModules: [SpeechTranscriber]) async -> Status { State.queries += 1; return State.status }
}
enum SFSpeechRecognizer { static func authorizationStatus() -> String { "authorized" } }
struct AVAudioSession { static func sharedInstance() -> AVAudioSession { AVAudioSession() }; let recordPermission = "granted" }
${inventory}
${helper}
@main struct Test {
  @MainActor static func main() async {
    var result = await SpanishSpeechCapability.report("es-US")
    precondition(result["locale"] as? String == "es-US")
    precondition(result["resolvedLocale"] as? String == "es-MX")
    precondition(result["recognizerAvailable"] as? Bool == true)
    precondition(result["reason"] as? String == "assets_installed_capture_unverified")
    State.installed = []
    result = await SpanishSpeechCapability.report("es-US")
    precondition(result["recognizerAvailable"] as? Bool == false)
    precondition(result["reason"] as? String == "asset_readiness_uncertain")
    State.status = .supported
    result = await SpanishSpeechCapability.report("es-US")
    precondition(result["reason"] as? String == "offline_assets_unavailable")
    State.installed = [Locale(identifier: "es-MX")]
    result = await SpanishSpeechCapability.report("es-US")
    precondition(result["reason"] as? String == "asset_readiness_uncertain")
    State.available = false; let before = State.queries
    result = await SpanishSpeechCapability.report("es-US")
    precondition(result["supportsOnDeviceRecognition"] as? Bool == false)
    precondition(result["reason"] as? String == "offline_unsupported")
    precondition(State.queries == before)
    State.available = true; State.locale = Locale(identifier: "en-US")
    result = await SpanishSpeechCapability.report("es-US")
    precondition(result["reason"] as? String == "unsupported_locale")
    State.locale = nil
    result = await SpanishSpeechCapability.report("es-US")
    precondition(result["reason"] as? String == "unsupported_locale")
    print("Spanish capability logic passed")
  }
}
`);
  execFileSync('xcrun', ['swiftc', '-swift-version', '5', '-parse-as-library', file, '-module-cache-path', join(directory, 'cache'), '-o', executable], { timeout: 30000 });
  assert.match(execFileSync(executable, { encoding: 'utf8', timeout: 5000 }), /logic passed/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { URL as NodeURL } from 'node:url';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
const source = (name: string) => readFileSync(new NodeURL('../' + name, import.meta.url), 'utf8');
const english = source('modules/local-foundation-models/ios/OfflineSpeechDiagnostic.swift');
const spanish = source('modules/local-foundation-models/ios/LocalFoundationModelsModule.swift');

test('Release cannot enable or invoke aligned sessions, even if the Debug control is requested', async () => {
  const flags: any = {};
  new Function('exports', '__DEV__', ts.transpileModule(source('lib/voice/responsivenessDiagnostics.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)(flags, false);
  flags.setDebugSessionAlignmentEnabled(true); assert.equal(flags.debugSessionAlignmentEnabled(), false);
  let lookups = 0; const bridge: any = {};
  new Function('require', 'exports', '__DEV__', ts.transpileModule(source('modules/local-foundation-models/index.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)(
    (name: string) => name === 'expo' ? { requireOptionalNativeModule: () => { lookups++; return {}; } } : { Platform: { OS: 'ios' } }, bridge, false);
  const initialLookups = lookups;
  assert.equal((await bridge.prepareVoiceCheckAlignedSession('release')).aligned, false);
  assert.equal(lookups, initialLookups);
  assert.ok(spanish.split('#if DEBUG\n    AsyncFunction("prepareVoiceCheckAlignedSession")')[1]?.split('#endif')[0]);
});

test('both readiness paths use fresh PCM, exclude cue input, and separately instrument session and engine work', () => {
  assert.match(english, /let preparation = current.meter.preparationPCM\(\)/);
  assert.doesNotMatch(english, /current.phase == "preparing", audio.ready/);
  assert.match(spanish, /while capture.meter.preparationPCM\(\).first == nil/);
  assert.doesNotMatch(spanish, /while !capture.meter.snapshot\(\).ready/);
  for (const code of [english, spanish]) {
    for (const milestone of ['sessionCategoryStarted', 'sessionCategoryCompleted', 'sessionActivationStarted', 'sessionActivationCompleted', 'recognitionPreparationStarted', 'recognitionPreparationCompleted', 'microphoneSetupStarted', 'microphoneSetupCompleted', 'enginePreparationStarted', 'enginePreparationCompleted', 'engineHardwareStartRequested']) assert.ok(code.includes(milestone), milestone);
    assert.match(code, /state.beginListening\(\)/);
    assert.match(code, /gate.acceptsSpeech/);
    assert.ok(code.includes('preservingRecordingSession: true'));
  }
  assert.match(english, /current.deadline = now \+ current.listeningSeconds/);
  assert.match(spanish, /let limit = capture.listeningStarted! \+ window \/ 1000/);
  assert.match(english, /finalResultReceived && finalTranscript.rangeOfCharacter/);
});

test('real Debug session owner falls back safely, invalidates routes, restores configuration and rejects cancelled IDs', { skip: process.platform !== 'darwin' }, () => {
  const helper = english.split('// BEGIN SESSION ALIGNMENT:')[1]!.split('// END SESSION ALIGNMENT')[0]!.split('\n').slice(1).join('\n')
    .replace('private func handleEvent', 'func handleEvent');
  assert.doesNotMatch(helper, /AVAudioEngine|installTap|recognitionTask|requestRecordPermission/);
  const directory = mkdtempSync(join(tmpdir(), 'drivesense-session-alignment-'));
  try {
    const file = join(directory, 'test.swift');
    writeFileSync(file, `import Foundation
@MainActor final class UIApplication {
  enum State { case active, background }; static let shared = UIApplication(); var applicationState = State.active
  static let didEnterBackgroundNotification = Notification.Name("background")
}
let AVAudioSessionRouteChangeReasonKey = "routeReason"
final class AVAudioSession {
  struct CategoryOptions: OptionSet { let rawValue: Int; static let defaultToSpeaker = Self(rawValue: 1); static let allowBluetoothHFP = Self(rawValue: 2); static let duckOthers = Self(rawValue: 4) }
  enum Category: String { case playback, playAndRecord }; enum Mode: String { case voicePrompt, \`default\` }; enum Permission { case granted, denied }
  enum Port: String { case builtInSpeaker, builtInReceiver, builtInMic, external }
  struct PortDescription { var portType: Port }; struct Route { var outputs: [PortDescription]; var inputs: [PortDescription] }
  static let routeChangeNotification = Notification.Name("route"); static let interruptionNotification = Notification.Name("interruption")
  static let shared = AVAudioSession(); static func sharedInstance() -> AVAudioSession { shared }
  var category = Category.playback; var mode = Mode.voicePrompt; var categoryOptions: CategoryOptions = []
  var recordPermission = Permission.granted; var isInputAvailable = true
  var currentRoute = Route(outputs: [.init(portType: .builtInSpeaker)], inputs: [.init(portType: .builtInMic)])
  var categoryCalls = 0; var activationCalls = 0; var failActivation = false; var failRestore = false
  func setCategory(_ c: Category, mode m: Mode, options o: CategoryOptions) throws {
    categoryCalls += 1
    if failRestore && c == .playback { throw NSError(domain: "fixture", code: 2) }
    category = c; mode = m; categoryOptions = o
  }
  func setActive(_ value: Bool) throws { activationCalls += 1; if failActivation { throw NSError(domain: "fixture", code: 1) } }
}
@MainActor enum VoiceRecognitionPreparation { static func failure(_ s: String) -> NSError { NSError(domain: s, code: 1) } }
@MainActor final class VoiceRecognitionTimings { var events: [String: Double] = [:]; func mark(_ name: String) { events[name] = 1 } }
${helper}
@main struct Test {
  @MainActor static func settle() async { for _ in 0..<20 { await Task.yield() } }
  @MainActor static func main() async throws {
    let owner = VoiceCheckSessionAlignment.shared; let session = AVAudioSession.shared
    func expectAligned(_ id: String, _ expected: Bool) throws {
      let result = try owner.prepare(id); assert(result["aligned"] as? Bool == expected)
    }
    try expectAligned("one", true)
    assert(owner.canReuse("one") && !owner.canReuse("stale"))
    assert(session.categoryCalls == 1 && session.activationCalls == 1)
    for reason in [3, 8] {
      session.currentRoute.outputs = [.init(portType: reason == 8 ? .builtInSpeaker : .builtInReceiver)]
      NotificationCenter.default.post(name: AVAudioSession.routeChangeNotification, object: nil, userInfo: [AVAudioSessionRouteChangeReasonKey: reason])
      await settle(); assert(owner.canReuse("one"))
    }
    assert(owner.diagnostics("one")?["firstInvalidatingEvent"] is NSNull)
    assert((owner.diagnostics("one")?["events"] as? [[String: Any]])?.count == 2)
    NotificationCenter.default.post(name: AVAudioSession.routeChangeNotification, object: nil)
    await settle(); assert(!owner.canReuse("one"))
    let rejected = owner.diagnostics("one")!
    assert((rejected["failedReusePredicates"] as! [String]).contains("alignmentValid"))
    let first = rejected["firstInvalidatingEvent"] as! [String: Any]
    assert(first["captureOwner"] as? String == "one" && first["source"] as? String == "route")
    assert(first["sessionAtNotification"] != nil && rejected["sessionAtReuse"] != nil)
    assert(owner.restore("one").isEmpty && session.category == .playback && session.mode == .voicePrompt)
    try expectAligned("one", false)
    session.currentRoute.outputs = [.init(portType: .external)]
    try expectAligned("external", false); assert(owner.id == nil)
    session.currentRoute.outputs = [.init(portType: .builtInSpeaker)]
    session.failActivation = true
    try expectAligned("failed", false)
    assert(owner.id == nil && session.category == .playback)
    session.failActivation = false
    try expectAligned("interrupt", true)
    NotificationCenter.default.post(name: AVAudioSession.interruptionNotification, object: nil)
    await settle(); assert(!owner.canReuse("interrupt")); assert(owner.restore("interrupt").isEmpty)
    try expectAligned("cleanup", true)
    session.failRestore = true
    assert(!owner.restore("cleanup").isEmpty && owner.id == "cleanup")
    session.failRestore = false; assert(owner.restore("cleanup").isEmpty && owner.id == nil)
    try expectAligned("background", true)
    NotificationCenter.default.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
    await settle(); assert(!owner.canReuse("background")); assert(owner.restore("background").isEmpty)
    // A queued old callback cannot invalidate a newer generation, including reused IDs.
    try expectAligned("old", true)
    let oldReport = owner.diagnostics("old")!
    let oldToken = UUID(uuidString: oldReport["ownerGeneration"] as! String)!
    let oldState = oldReport["sessionAfterAlignment"] as! [String: Any]
    assert(owner.restore("old").isEmpty)
    try expectAligned("new", true)
    Task { @MainActor in owner.handleEvent(owner: "old", token: oldToken, name: AVAudioSession.interruptionNotification, reason: nil, receivedAt: ProcessInfo.processInfo.systemUptime, receivedState: oldState) }
    await settle(); assert(owner.canReuse("new"))
    assert((owner.diagnostics("new")?["events"] as! [[String: Any]]).isEmpty)
    assert(owner.restore("old").isEmpty && owner.canReuse("new"))
    let newReport = owner.diagnostics("new")!
    let newToken = UUID(uuidString: newReport["ownerGeneration"] as! String)!
    // Even a callback naming the current ID must possess its generation token.
    owner.handleEvent(owner: "new", token: oldToken, name: AVAudioSession.interruptionNotification, reason: nil, receivedAt: ProcessInfo.processInfo.systemUptime, receivedState: oldState)
    assert(owner.canReuse("new"))
    // A route loss observed at delivery must remain fatal even after hardware recovers.
    var missing = newReport["sessionAfterAlignment"] as! [String: Any]; missing["inputPresent"] = false
    owner.handleEvent(owner: "new", token: newToken, name: AVAudioSession.routeChangeNotification, reason: 8, receivedAt: ProcessInfo.processInfo.systemUptime, receivedState: missing)
    assert(!owner.canReuse("new"))
    let firstLoss = owner.diagnostics("new")?["firstInvalidatingEvent"] as! [String: Any]
    assert(firstLoss["routeReasonRawValue"] as? UInt == 8)
    owner.handleEvent(owner: "new", token: newToken, name: AVAudioSession.routeChangeNotification, reason: 3, receivedAt: ProcessInfo.processInfo.systemUptime, receivedState: oldState)
    assert(!owner.canReuse("new")) // No resurrection and first failure is preserved.
    assert((owner.diagnostics("new")?["firstInvalidatingEvent"] as! [String: Any])["routeReasonRawValue"] as? UInt == 8)
    assert(owner.restore("new").isEmpty)
    assert((owner.diagnostics("new")?["restoration"] as! [String: Any])["status"] as? String == "restored")
    assert(!owner.canReuse("new"))
    assert((owner.diagnostics("new")?["failedReusePredicates"] as! [String]).contains("notCancelled"))
    // Each unsafe current session predicate independently prevents reuse.
    for fault in ["categoryMatches", "modeMatches", "optionsMatch", "inputPresent", "inputAvailable", "builtInRoute", "microphonePermissionGranted", "appActive"] {
      try expectAligned(fault, true)
      switch fault {
      case "categoryMatches": session.category = .playback
      case "modeMatches": session.mode = .voicePrompt
      case "optionsMatch": session.categoryOptions = []
      case "inputPresent": session.currentRoute.inputs = []
      case "inputAvailable": session.isInputAvailable = false
      case "builtInRoute": session.currentRoute.outputs = [.init(portType: .external)]
      case "microphonePermissionGranted": session.recordPermission = .denied
      default: UIApplication.shared.applicationState = .background
      }
      assert(!owner.canReuse(fault))
      assert((owner.diagnostics(fault)?["failedReusePredicates"] as! [String]).contains(fault))
      if fault == "builtInRoute" || fault == "inputPresent" || fault == "inputAvailable" {
        NotificationCenter.default.post(name: AVAudioSession.routeChangeNotification, object: nil, userInfo: [AVAudioSessionRouteChangeReasonKey: 8]); await settle()
        assert(owner.diagnostics(fault)?["firstInvalidatingEvent"] is [String: Any])
      }
      assert(owner.restore(fault).isEmpty)
      session.currentRoute = .init(outputs: [.init(portType: .builtInSpeaker)], inputs: [.init(portType: .builtInMic)])
      session.isInputAvailable = true; session.recordPermission = .granted; UIApplication.shared.applicationState = .active
    }
    try expectAligned("cancel_by_action", true)
    assert(owner.restore("cancel_by_action", source: "cancelled").isEmpty)
    let cancelledEvent = owner.diagnostics("cancel_by_action")?["firstInvalidatingEvent"] as! [String: Any]
    assert(cancelledEvent["source"] as? String == "alignment.cancelled")
    assert(!owner.canReuse("cancel_by_action"))
    try expectAligned("hardware_change", true)
    NotificationCenter.default.post(name: AVAudioSession.routeChangeNotification, object: nil, userInfo: [AVAudioSessionRouteChangeReasonKey: 2]); await settle()
    assert(!owner.canReuse("hardware_change")); assert(owner.restore("hardware_change").isEmpty)
    print("PASS")
  }
}`);
    const binary = join(directory, 'test');
    execFileSync('xcrun', ['swiftc', '-swift-version', '5', '-parse-as-library', '-module-cache-path', join(directory, 'cache'), file, '-o', binary], { stdio: 'pipe', timeout: 60000 });
    assert.match(execFileSync(binary, [], { encoding: 'utf8', timeout: 15000 }), /PASS/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('actual English and Spanish meters discard preparation/cue PCM and accept the first listening buffer', { skip: process.platform !== 'darwin' }, () => {
  const gate = english.split('// BEGIN LISTENING GATE:')[1]!.split('// END LISTENING GATE')[0]!.split('\n').slice(1).join('\n');
  const state = english.split('// BEGIN ENDPOINT STATE:')[1]!.split('// END ENDPOINT STATE')[0]!.split('\n').slice(1).join('\n');
  const meter = 'private final class SpeechActivityMeter' + english.split('private final class SpeechActivityMeter')[1]!.split('/// Owns only diagnostic capture.')[0];
  const spanishMeter = 'private final class SpanishSpeechMeter' + spanish.split('private final class SpanishSpeechMeter')[1]!.split('// One native capture owner')[0];
  const directory = mkdtempSync(join(tmpdir(), 'drivesense-listening-input-'));
  try {
    const file = join(directory, 'main.swift');
    writeFileSync(file, `import Foundation
import AVFoundation
final class SFSpeechAudioBufferRecognitionRequest { var frames = 0; func append(_ b: AVAudioPCMBuffer) { frames += Int(b.frameLength) } }
${gate}
${state}
${meter}
${spanishMeter}
let format = AVAudioFormat(standardFormatWithSampleRate: 16000, channels: 1)!
let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 320)!
buffer.frameLength = 320
for i in 0..<320 { buffer.floatChannelData![0][i] = 0.05 }
private let en = SpeechActivityMeter(); private let es = SpanishSpeechMeter()
let request = SFSpeechAudioBufferRecognitionRequest()
for _ in 0..<40 { en.append(buffer, to: request); assert(!es.receive(buffer)) }
assert(request.frames == 0 && en.snapshot().elapsed == 0 && es.snapshot().elapsed == 0)
assert(en.preparationPCM().first != nil && es.preparationPCM().first != nil)
assert(en.prepareCue() && es.prepareCue())
for _ in 0..<10 { en.append(buffer, to: request); assert(!es.receive(buffer)) }
assert(request.frames == 0 && en.snapshot().elapsed == 0 && es.snapshot().elapsed == 0)
assert(en.beginListening(now: 10, seconds: 6) && es.beginListening(now: 10, seconds: 6))
en.append(buffer, to: request); assert(es.receive(buffer))
assert(request.frames == 320 && en.snapshot().elapsed == 0.02 && es.snapshot().elapsed == 0.02)
en.recognizedSpeech(startSeconds: 0); es.recognizedSpeech()
for _ in 0..<30 { en.append(buffer, to: request); assert(es.receive(buffer)) }
assert(en.snapshot().ready && es.snapshot().ready)
assert(en.snapshot().thresholdDb == -48 && es.snapshot().thresholdDb == -48)
en.stopFeeding(); es.stop(); let before = request.frames
en.append(buffer, to: request); assert(!es.receive(buffer)); assert(request.frames == before)
private let cancelled = SpeechActivityMeter(); cancelled.stopFeeding()
assert(!cancelled.prepareCue() && !cancelled.beginListening(now: 10, seconds: 6))
print("PASS")`);
    assert.match(execFileSync('xcrun', ['swift', '-module-cache-path', join(directory, 'cache'), file], { encoding: 'utf8', timeout: 60000 }), /PASS/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

import ExpoModulesCore
import Foundation
import Speech
import AVFoundation
import UIKit

@available(iOS 26.0, *)
private func inventoryName(_ status: AssetInventory.Status) -> String {
  switch status {
  case .installed: return "installed"
  case .supported: return "supported"
  case .downloading: return "downloading"
  case .unsupported: return "unsupported"
  @unknown default: return "unknown"
  }
}

// BEGIN SPANISH CAPABILITY REPORT
@MainActor
private enum SpanishSpeechCapability {
  static func report(_ requested: String) async -> [String: Any] {
    var result: [String: Any] = [
      "locale": requested, "engine": "speech_transcriber", "resolvedLocale": NSNull(),
      "assetStatus": "unknown", "installedLocale": false,
      "supportsOnDeviceRecognition": false, "recognizerAvailable": false,
      "reason": "requires_ios_26", "message": "Spanish offline recognition requires iOS 26 on supported devices.",
      "speechPermission": String(describing: SFSpeechRecognizer.authorizationStatus()),
      "microphonePermission": String(describing: AVAudioSession.sharedInstance().recordPermission)
    ]
    guard #available(iOS 26.0, *) else { return result }
    guard SpeechTranscriber.isAvailable else {
      result["reason"] = "offline_unsupported"
      result["message"] = "SpeechTranscriber is unavailable on this device. Typed and button responses remain available."
      return result
    }
    guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: requested)),
          locale.language.languageCode?.identifier == "es" else {
      result["reason"] = "unsupported_locale"
      result["message"] = "No supported Spanish equivalent is reported. Typed and button responses remain available."
      return result
    }
    let identifier = locale.identifier.replacingOccurrences(of: "_", with: "-")
    result["resolvedLocale"] = identifier
    result["supportsOnDeviceRecognition"] = true
    let installed = await SpeechTranscriber.installedLocales
    let listed = installed.contains { $0.identifier.replacingOccurrences(of: "_", with: "-").lowercased() == identifier.lowercased() }
    let module = SpeechTranscriber(locale: locale, preset: .progressiveTranscription)
    let status = inventoryName(await AssetInventory.status(forModules: [module]))
    result["assetStatus"] = status; result["installedLocale"] = listed
    let available = status == "installed" && listed
    result["recognizerAvailable"] = available
    result["reason"] = available ? "assets_installed_capture_unverified"
      : (status == "installed") != listed || status == "unknown" ? "asset_readiness_uncertain" : "offline_assets_unavailable"
    result["message"] = available
      ? "Spanish recognition assets are reported installed. Microphone capture is not verified."
      : "Recognition assets are unavailable or uncertain. Typed and button responses remain available."
    // Inventory is advisory. Never reserve/install assets, prepare analysis or open audio here.
    return result
  }
}
// END SPANISH CAPABILITY REPORT

private func spanishRecognitionFailure(_ reason: String, status: String = "error") -> [String: Any] {
  ["status": status, "reason": reason, "locale": "es-US", "requiresOnDeviceRecognition": true,
   "transcript": "", "finalTranscript": "", "partialTranscript": "", "isFinal": false,
   "finalResultReceived": false, "hasFinalTranscript": false, "totalTimeMs": 0, "recognitionTimeMs": 0,
   "preparationTimeMs": 0, "listeningTimeMs": 0, "finalizationTimeMs": 0,
   "firstPartialTimeMs": NSNull(), "endpointReason": "none", "silenceTargetMs": 1300, "finalizationGraceMs": 2500]
}

// Permission callbacks may arrive after cancellation; resume the awaiting task exactly once.
private final class DiagnosticPermissionWaiter: @unchecked Sendable {
  private let lock = NSLock()
  private var continuation: CheckedContinuation<Bool, Never>?
  private var answer: Bool?
  func install(_ value: CheckedContinuation<Bool, Never>) {
    lock.lock()
    if let answer { lock.unlock(); value.resume(returning: answer) }
    else { continuation = value; lock.unlock() }
  }
  func resolve(_ value: Bool) {
    lock.lock()
    guard answer == nil else { lock.unlock(); return }
    answer = value
    let pending = continuation
    continuation = nil
    lock.unlock()
    pending?.resume(returning: value)
  }
}

#if DEBUG
@available(iOS 26.0, *)
private enum SpanishTranscriberDiagnostic {
  static func report() async -> [String: Any] {
    let osVersion = ProcessInfo.processInfo.operatingSystemVersionString
    let reserved = await AssetInventory.reservedLocales
    let maximum = AssetInventory.maximumReservedLocales
    guard SpeechTranscriber.isAvailable else {
      return ["status": "hardware_unavailable", "osVersion": osVersion,
              "deviceAvailable": false, "supportedSpanishLocales": [], "installedSpanishLocales": [],
              "requestedLocales": [], "assets": [], "reservedLocales": reserved.map { $0.identifier(.bcp47) }, "maximumReservedLocales": maximum]
    }
    func identifier(_ locale: Locale) -> String { locale.identifier.replacingOccurrences(of: "_", with: "-") }
    let supported = await SpeechTranscriber.supportedLocales
    let installed = await SpeechTranscriber.installedLocales
    let spanish = supported.filter { $0.language.languageCode?.identifier == "es" }
      .sorted { identifier($0) < identifier($1) }
    let installedIDs = Set(installed.map(identifier))
    var requested: [[String: Any]] = []
    for locale in ["es-US", "es-ES", "es-MX"] {
      let equivalent = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: locale))
      requested.append(["locale": locale,
                        "exactSupported": spanish.contains { identifier($0).lowercased() == locale.lowercased() },
                        "equivalentLocale": equivalent.map(identifier) as Any? ?? NSNull()])
    }
    var assets: [[String: Any]] = []
    for locale in spanish {
      // Constructing a module and querying inventory does not start analysis or install assets.
      let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
      let status = await AssetInventory.status(forModules: [transcriber])
      assets.append(["locale": identifier(locale), "installedLocale": installedIDs.contains(identifier(locale)),
                     "assetStatus": inventoryName(status)])
    }
    return ["status": "available", "osVersion": osVersion, "deviceAvailable": true,
            "supportedSpanishLocales": spanish.map(identifier),
            "installedSpanishLocales": installed.filter { $0.language.languageCode?.identifier == "es" }.map(identifier).sorted(),
            "requestedLocales": requested, "assets": assets,
            "reservedLocales": reserved.map { $0.identifier(.bcp47) }.sorted(), "maximumReservedLocales": maximum]
  }
}
#endif

// BEGIN SPANISH RESPONSE STATE: no interpretation or consent decisions.
struct SpanishTranscriberResponse {
  private(set) var segments: [String] = []
  private(set) var finalEnd = -Double.infinity
  private(set) var volatileEnd = -Double.infinity
  private(set) var invalid = false
  mutating func receive(_ text: String, isFinal: Bool, end: Double) {
    guard end.isFinite else { invalid = true; return }
    if isFinal {
      guard end > finalEnd else { return } // ignore duplicate final callbacks
      finalEnd = end
      let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
      guard trimmed.rangeOfCharacter(from: .alphanumerics) != nil, segments.count < 64 else { invalid = true; return }
      segments.append(trimmed)
    } else if text.rangeOfCharacter(from: .alphanumerics) != nil { volatileEnd = max(volatileEnd, end) }
  }
  var text: String { segments.joined(separator: " ") }
  var complete: Bool { !invalid && !segments.isEmpty && finalEnd >= volatileEnd }
}
// END SPANISH RESPONSE STATE

private final class SpanishSpeechMeter: @unchecked Sendable {
  private let lock = NSLock()
  private var state = OfflineEndpointState()
  private var gate = VoiceListeningGate()
  private var firstPreparationPCM: TimeInterval?
  private var lastPreparationPCM: TimeInterval?
  func preparationPCM() -> (first: TimeInterval?, last: TimeInterval?) {
    lock.lock(); defer { lock.unlock() }; return (firstPreparationPCM, lastPreparationPCM)
  }
  func prepareCue() -> Bool { lock.lock(); defer { lock.unlock() }; return gate.nativeReady() }
  func beginListening(now: TimeInterval, seconds: Double) -> Bool {
    lock.lock(); defer { lock.unlock() }
    guard gate.cueFinished(now: now, seconds: seconds) else { return false }
    state.beginListening(); return true
  }
  func stop() { lock.lock(); gate.stop(); lock.unlock() }
  func receive(_ buffer: AVAudioPCMBuffer) -> Bool {
    guard let channels = buffer.floatChannelData, buffer.frameLength > 0 else { return false }
    var power = 0.0
    var count = 0
    for channel in 0..<Int(buffer.format.channelCount) {
      for frame in stride(from: 0, to: Int(buffer.frameLength), by: 4) {
        let sample = Double(channels[channel][frame]); power += sample * sample; count += 1
      }
    }
    lock.lock(); defer { lock.unlock() }
    guard gate.measuresPreparation || gate.acceptsSpeech else { return false }
    let now = ProcessInfo.processInfo.systemUptime
    if gate.acceptsSpeech {
      state.receive(level: 10 * log10(max(power / Double(max(count, 1)), 1e-12)),
                    duration: Double(buffer.frameLength) / buffer.format.sampleRate, now: now)
    } else { firstPreparationPCM = firstPreparationPCM ?? now; lastPreparationPCM = now }
    return gate.acceptsSpeech
  }
  func recognizedSpeech() {
    lock.lock(); defer { lock.unlock() }
    state.recognizedSpeech(startSeconds: 0, now: ProcessInfo.processInfo.systemUptime)
  }
  func snapshot() -> OfflineEndpointState { lock.lock(); defer { lock.unlock() }; return state }
}

// One native capture owner, shared by Spanish VoiceCheck and the isolated Debug fixture.
@available(iOS 26.0, *)
@MainActor
final class SpanishOfflineRecognition {
  static let shared = SpanishOfflineRecognition()
  @MainActor private final class Capture {
    let id: String
    let started = ProcessInfo.processInfo.systemUptime
    let engine = AVAudioEngine()
    var prepared: PreparedSpanishRecognition?
    var timings = VoiceRecognitionTimings()
    var analyzer: SpeechAnalyzer?
    var input: AsyncStream<AnalyzerInput>.Continuation?
    var worker: Task<String, Error>?
    var results: Task<String, Error>?
    var watchdog: Task<Void, Never>?
    var observers: [NSObjectProtocol] = []
    var tapInstalled = false
    var sessionChanged = false
    var previousCategory: AVAudioSession.Category?
    var previousMode: AVAudioSession.Mode?
    var previousOptions: AVAudioSession.CategoryOptions = []
    var introducedReservation = false
    var locale: Locale?
    var stopReason: String?
    var recordingStarted: TimeInterval?
    var listeningStarted: TimeInterval?
    var finalizingStarted: TimeInterval?
    let responseWindowMs: Double?
    let meter = SpanishSpeechMeter()
    var response = SpanishTranscriberResponse()
    var speechReceived = false
    var details: [String: Any] = [:]
    var onCaptureStopped: (() -> Void)?
    init(_ id: String, responseWindowMs: Double?) { self.id = id; self.responseWindowMs = responseWindowMs }
  }
  private var active: Capture?
  var isBusy: Bool { active != nil }
  private var cancelledBeforeStart: [String] = []

  private func stopAudio(_ capture: Capture) {
    capture.meter.stop()
    capture.engine.stop()
    let stopped = capture.onCaptureStopped
    capture.onCaptureStopped = nil
    stopped?()
    if capture.tapInstalled {
      capture.engine.inputNode.removeTap(onBus: 0)
      capture.tapInstalled = false
    }
    capture.input?.finish()
    if let started = capture.recordingStarted, capture.details["captureTimeMs"] == nil {
      capture.details["captureTimeMs"] = (ProcessInfo.processInfo.systemUptime - started) * 1000
    }
  }

  private func requestStop(_ capture: Capture, reason: String) {
    guard active === capture else { return }
    capture.stopReason = capture.stopReason ?? reason
    stopAudio(capture) // Stop capture immediately, even if analyzer work is suspended.
    capture.worker?.cancel()
    VoiceCheckListeningCue.shared.stop(capture.id)
    capture.results?.cancel()
    if let analyzer = capture.analyzer { Task { await analyzer.cancelAndFinishNow() } }
  }

  func cancel(_ requestId: String) async {
    guard let capture = active, capture.id == requestId else {
      cancelledBeforeStart.append(requestId)
      if cancelledBeforeStart.count > 16 { cancelledBeforeStart.removeFirst() }
      return
    }
    requestStop(capture, reason: "cancelled")
    _ = await capture.worker?.result
    // run() owns cleanup; wait until audio restoration and reservation release finish.
    while active === capture { try? await Task.sleep(nanoseconds: 10_000_000) }
  }

  func cancelAll() { if let capture = active { requestStop(capture, reason: "cancelled") } }

  private func deadline(_ capture: Capture, seconds: Double, reason: String) {
    capture.watchdog?.cancel()
    capture.watchdog = Task {
      do { try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)) }
      catch { return }
      requestStop(capture, reason: reason)
    }
  }

  func run(_ requestId: String, responseWindowMs: Double? = nil, prepared: PreparedSpanishRecognition? = nil, progress: @escaping ([String: Any]) -> Void) async -> [String: Any] {
    if let ms = responseWindowMs, !ms.isFinite || !(1000...30000).contains(ms) {
      return spanishRecognitionFailure("invalid_timeout")
    }
    if let index = cancelledBeforeStart.firstIndex(of: requestId) {
      cancelledBeforeStart.remove(at: index)
      return spanishRecognitionFailure("cancelled_before_start", status: "cancelled")
    }
    guard VoiceRecognitionPreparation.shared.permitsCapture(requestId), active == nil, !OfflineSpeechDiagnostic.shared.isBusy, !LocalSpeechPlayback.shared.isBusy else {
      return spanishRecognitionFailure("audio_busy")
    }
    let capture = Capture(requestId, responseWindowMs: responseWindowMs)
    capture.prepared = prepared
    capture.timings = prepared?.timings ?? capture.timings
    capture.timings.mark("captureActivationStarted")
    active = capture
    capture.observers = [UIApplication.didEnterBackgroundNotification, AVAudioSession.interruptionNotification].map { name in
      NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
        Task { @MainActor in self?.requestStop(capture, reason: "interrupted") }
      }
    }
    capture.observers.append(NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: capture.engine, queue: .main) { [weak self] _ in
      Task { @MainActor in
        if capture.recordingStarted != nil { self?.requestStop(capture, reason: "audio_route_changed") }
      }
    })
    deadline(capture, seconds: responseWindowMs == nil ? 20 : 5, reason: responseWindowMs == nil ? "timeout" : "preparation_timeout")
    capture.worker = Task { try await self.execute(capture, progress: progress) }
    let outcome = await capture.worker!.result
    capture.watchdog?.cancel()
    capture.observers.forEach(NotificationCenter.default.removeObserver)
    capture.observers = []
    stopAudio(capture)
    capture.results?.cancel()
    var cleanupErrors: [String] = []
    if let prepared = capture.prepared { cleanupErrors += await prepared.dispose() }
    else if let analyzer = capture.analyzer { await analyzer.cancelAndFinishNow() }
    _ = await capture.results?.result
    if capture.sessionChanged {
      let session = AVAudioSession.sharedInstance()
      do { try session.setActive(false, options: .notifyOthersOnDeactivation) }
      catch { cleanupErrors.append("Deactivate audio: \(error)") }
      if let category = capture.previousCategory, let mode = capture.previousMode {
        do { try session.setCategory(category, mode: mode, options: capture.previousOptions) }
        catch { cleanupErrors.append("Restore audio: \(error)") }
      }
    }
    if capture.introducedReservation, let locale = capture.locale {
      let released = await AssetInventory.release(reservedLocale: locale)
      capture.details["reservationReleased"] = released
      if !released { cleanupErrors.append("Test locale reservation could not be released.") }
    }
    var report = spanishRecognitionFailure("native_error")
    report["nativeRevision"] = "ready-cue-completion-v4"
    report["audioOutputVolume"] = AVAudioSession.sharedInstance().outputVolume
    report["audioOutputRoute"] = AVAudioSession.sharedInstance().currentRoute.outputs.map { $0.portType.rawValue }
    report.merge(capture.details) { _, detail in detail }
    switch outcome {
    case .success(let text):
      report["status"] = capture.response.complete ? "success" : "incomplete"
      report["reason"] = capture.response.complete ? "complete" : "unconfirmed_transcript"
      report["transcript"] = text
    case .failure(let error):
      let native = error as NSError
      report["status"] = capture.stopReason == "cancelled" ? "cancelled" : "error"
      report["transcript"] = ""
      report["reason"] = capture.stopReason ?? "native_error"
      report["error"] = ["domain": native.domain, "code": native.code, "message": native.localizedDescription]
    }
    report["cleanupErrors"] = cleanupErrors
    if let reason = capture.stopReason {
      report["status"] = reason == "cancelled" ? "cancelled" : reason == "no_speech_timeout" ? "timeout" : reason == "finalization_incomplete" ? "incomplete" : "error"
      report["reason"] = reason
      report["transcript"] = ""
    }
    if !cleanupErrors.isEmpty { report["status"] = "error"; report["reason"] = "audio_cleanup_failed" }
    report["totalTimeMs"] = (ProcessInfo.processInfo.systemUptime - capture.started) * 1000
    if report["preparationTimeMs"] == nil {
      report["preparationTimeMs"] = (ProcessInfo.processInfo.systemUptime - capture.started) * 1000
    }
    report["recognitionTimeMs"] = capture.recordingStarted.map { (ProcessInfo.processInfo.systemUptime - $0) * 1000 } ?? 0
    let end = ProcessInfo.processInfo.systemUptime
    report["preparationTimeMs"] = ((capture.listeningStarted ?? end) - capture.started) * 1000
    report["listeningTimeMs"] = capture.listeningStarted.map { ((capture.finalizingStarted ?? end) - $0) * 1000 } ?? 0
    report["finalizationTimeMs"] = capture.finalizingStarted.map { (end - $0) * 1000 } ?? 0
    report["recognitionLocale"] = capture.locale?.identifier(.bcp47)
    // locale is the requested adapter locale; recognitionLocale identifies Apple's resolved model.
    report["locale"] = "es-US"
    report["requiresOnDeviceRecognition"] = true
    let confirmed = report["status"] as? String == "success" && capture.response.complete
    report["isFinal"] = confirmed
    report["finalResultReceived"] = confirmed
    report["hasFinalTranscript"] = confirmed
    report["finalTranscript"] = confirmed ? capture.response.text : ""
    report["partialTranscript"] = ""
    capture.timings.mark("captureCleanupCompleted")
    report["nativeTimingMs"] = capture.timings.events
    active = nil
    return report
  }

  private func execute(_ capture: Capture, progress: @escaping ([String: Any]) -> Void) async throws -> String {
    func fail(_ message: String, reason: String = "native_error") -> NSError {
      capture.stopReason = capture.stopReason ?? reason
      return NSError(domain: "SpanishOfflineRecognition", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
    func phase(_ value: String) {
      let audio = capture.meter.snapshot()
      progress(["requestId": capture.id, "phase": value, "transcript": "", "elapsedMs": (ProcessInfo.processInfo.systemUptime - capture.started) * 1000,
                "audioLevelDb": audio.levelDb, "activityThresholdDb": audio.thresholdDb, "silenceMs": audio.diagnostics(now: ProcessInfo.processInfo.systemUptime)["silenceMs"] ?? 0,
                "measuredActivityMs": audio.activitySeconds * 1000, "endpointReason": capture.details["endpointReason"] ?? "none"])
    }
    phase("preparing")
    let transcriber: SpeechTranscriber
    if let prepared = capture.prepared, let ready = prepared.transcriber {
      transcriber = ready
      capture.locale = prepared.resolvedLocale
      capture.details.merge(prepared.details) { _, value in value }
    } else {
    guard SpeechTranscriber.isAvailable else { throw fail("SpeechTranscriber is unavailable on this device.", reason: "offline_unsupported") }
    guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: "es-US")),
          locale.language.languageCode?.identifier == "es" else { throw fail("No supported Spanish equivalent of es-US.", reason: "unsupported_locale") }
    capture.locale = locale
    capture.details["locale"] = locale.identifier(.bcp47)
    let before = await AssetInventory.reservedLocales
    capture.details["reservationsBefore"] = before.map { $0.identifier(.bcp47) }
    let createdTranscriber = SpeechTranscriber(locale: locale, preset: capture.responseWindowMs == nil ? .transcription : .progressiveTranscription)
    capture.details["assetStatusBefore"] = inventoryName(await AssetInventory.status(forModules: [createdTranscriber]))
    try Task.checkCancellation()
    if !before.contains(where: { $0.identifier(.bcp47) == locale.identifier(.bcp47) }) {
      do {
        guard try await AssetInventory.reserve(locale: locale) else { throw fail("Unable to reserve the Spanish locale.", reason: "reservation_failed") }
      } catch { throw fail("Spanish locale reservation failed: \(error)", reason: "reservation_failed") }
      capture.introducedReservation = true
    }
    capture.details["introducedReservation"] = capture.introducedReservation
    let after = await AssetInventory.status(forModules: [createdTranscriber])
    capture.details["assetStatusAfter"] = inventoryName(after)
    guard after == .installed else { throw fail("Spanish recognition assets are not ready. No download was requested.", reason: "offline_assets_unavailable") }
    try Task.checkCancellation()
    transcriber = createdTranscriber
    }
    guard Bundle.main.object(forInfoDictionaryKey: "NSMicrophoneUsageDescription") != nil else { throw fail("Microphone usage description is missing.") }
    let session = AVAudioSession.sharedInstance()
    var permission = session.recordPermission == .granted
    if session.recordPermission == .undetermined {
      let waiter = DiagnosticPermissionWaiter()
      permission = await withTaskCancellationHandler {
        await withCheckedContinuation { continuation in
          waiter.install(continuation)
          if Task.isCancelled { waiter.resolve(false) }
          else { session.requestRecordPermission { waiter.resolve($0) } }
        }
      } onCancel: { waiter.resolve(false) }
    }
    try Task.checkCancellation()
    guard permission else { throw fail("Microphone permission is required. Enable it in iPhone Settings.") }
    guard UIApplication.shared.applicationState == .active,
          !OfflineSpeechDiagnostic.shared.isBusy, !LocalSpeechPlayback.shared.isBusy else { throw fail("Audio is busy or the app is inactive.") }
    let analyzer: SpeechAnalyzer
    let format: AVAudioFormat
    if let prepared = capture.prepared, let readyAnalyzer = prepared.analyzer, let readyFormat = prepared.format {
      analyzer = readyAnalyzer; format = readyFormat; capture.analyzer = analyzer
    } else {
    let createdAnalyzer = SpeechAnalyzer(modules: [transcriber])
    capture.analyzer = createdAnalyzer
    guard let createdFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else { throw fail("No compatible installed audio format. No assets were downloaded.") }
    try Task.checkCancellation()
    do { try await createdAnalyzer.prepareToAnalyze(in: createdFormat) }
    catch { throw fail("Offline analyzer preparation failed: \(error)", reason: "offline_preparation_failed") }
    try Task.checkCancellation()
    analyzer = createdAnalyzer
    format = createdFormat
    }
    capture.previousCategory = session.category
    capture.previousMode = session.mode
    capture.previousOptions = session.categoryOptions
    capture.sessionChanged = true
    capture.timings.mark("audioSessionSetupStarted")
    var reused = false
#if DEBUG
    if capture.responseWindowMs != nil { reused = VoiceCheckSessionAlignment.shared.canReuse(capture.id) }
#endif
    capture.timings.mark(reused ? "alignedSessionReused" : "sequentialSessionSelected")
    if !reused {
      capture.timings.mark("sessionCategoryStarted")
      try session.setCategory(.playAndRecord, mode: capture.responseWindowMs == nil ? .measurement : .default,
                              options: capture.responseWindowMs == nil ? [.defaultToSpeaker] : [.defaultToSpeaker, .allowBluetoothHFP, .duckOthers])
      capture.timings.mark("sessionCategoryCompleted")
      capture.timings.mark("sessionActivationStarted")
      try session.setActive(true)
      capture.timings.mark("sessionActivationCompleted")
    }
    capture.timings.mark("audioSessionSetupCompleted")
    capture.timings.mark("microphoneSetupStarted")
    let input = capture.engine.inputNode
    let natural = input.outputFormat(forBus: 0)
    guard natural.sampleRate > 0, natural.channelCount > 0,
          let converter = AVAudioConverter(from: natural, to: format) else { throw fail("Microphone audio format cannot be converted.") }
    let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream(bufferingPolicy: .bufferingOldest(64))
    capture.input = continuation
    capture.results = Task {
      for try await result in transcriber.results {
        try Task.checkCancellation()
        let text = String(result.text.characters)
        if !capture.speechReceived, text.rangeOfCharacter(from: .alphanumerics) != nil {
          capture.speechReceived = true
          capture.meter.recognizedSpeech()
        }
        if !result.isFinal, capture.details["firstPartialTimeMs"] == nil, text.rangeOfCharacter(from: .alphanumerics) != nil {
          capture.timings.mark("firstPartialReceived")
          capture.details["firstPartialTimeMs"] = (ProcessInfo.processInfo.systemUptime - capture.started) * 1000
        }
        if result.isFinal { capture.timings.mark("finalResultReceived") }
        capture.response.receive(text, isFinal: result.isFinal, end: CMTimeGetSeconds(CMTimeRangeGetEnd(result.range)))
      }
      return capture.response.text
    }
    capture.timings.mark("microphoneSetupCompleted")
    capture.timings.mark("recognitionPreparationStarted")
    capture.timings.mark("recognitionTaskStarted")
    try await analyzer.start(inputSequence: stream)
    capture.timings.mark("recognitionPreparationCompleted")
    try Task.checkCancellation()
    if capture.responseWindowMs == nil {
      _ = capture.meter.prepareCue()
      _ = capture.meter.beginListening(now: ProcessInfo.processInfo.systemUptime, seconds: 5)
    }
    capture.timings.mark("microphoneTapSetupStarted")
    input.installTap(onBus: 0, bufferSize: 1024, format: natural) { buffer, _ in
      guard capture.meter.receive(buffer) else { return }
      let capacity = AVAudioFrameCount(ceil(Double(buffer.frameLength) * format.sampleRate / natural.sampleRate)) + 32
      guard let converted = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else {
        Task { @MainActor in self.requestStop(capture, reason: "audio_buffer_allocation_failed") }
        return
      }
      var supplied = false
      var conversionError: NSError?
      let status = converter.convert(to: converted, error: &conversionError) { _, state in
        if supplied { state.pointee = .noDataNow; return nil }
        supplied = true
        state.pointee = .haveData
        return buffer
      }
      if let error = conversionError {
        Task { @MainActor in
          capture.details["conversionError"] = error.localizedDescription
          self.requestStop(capture, reason: "audio_conversion_failed")
        }
      } else if status == .error {
        Task { @MainActor in self.requestStop(capture, reason: "audio_conversion_failed") }
      } else if converted.frameLength > 0 {
        if case .dropped = continuation.yield(AnalyzerInput(buffer: converted)) {
          Task { @MainActor in self.requestStop(capture, reason: "audio_buffer_overflow") }
        }
      }
    }
    capture.tapInstalled = true
    capture.timings.mark("microphoneTapSetupCompleted")
    capture.timings.mark("engineStartRequested")
    capture.timings.mark("enginePreparationStarted")
    capture.engine.prepare()
    capture.timings.mark("enginePreparationCompleted")
    capture.timings.mark("engineHardwareStartRequested")
    try capture.engine.start()
    capture.timings.mark("engineStartReturned")
    let listeningStart = ProcessInfo.processInfo.systemUptime
    capture.recordingStarted = listeningStart
    if let window = capture.responseWindowMs {
      // Readiness needs fresh PCM, not endpoint calibration. No pre-cue audio is retained.
      while capture.meter.preparationPCM().first == nil {
        try Task.checkCancellation()
        try await Task.sleep(nanoseconds: 10_000_000)
      }
      if let first = capture.meter.preparationPCM().first { capture.timings.mark("firstPCMReceived", at: first) }
      capture.timings.mark("nativeMicrophoneReady")
      try Task.checkCancellation()
      guard capture.engine.isRunning, let lastBuffer = capture.meter.preparationPCM().last,
            ProcessInfo.processInfo.systemUptime - lastBuffer < 0.35 else {
        throw fail("Live microphone input stopped before readiness.", reason: "audio_interrupted")
      }
      guard capture.meter.prepareCue() else { throw CancellationError() }
      capture.watchdog?.cancel() // Native preparation succeeded; cue time is outside both budgets.
      // The analyzer is prepared and the engine has delivered live PCM.
      // Freeze the meter and recognition stream while the ready cue plays on the same session.
      phase("ready")
      capture.details["audioOutputVolume"] = AVAudioSession.sharedInstance().outputVolume
      capture.details["audioOutputRoute"] = AVAudioSession.sharedInstance().currentRoute.outputs.map { $0.portType.rawValue }
      capture.timings.mark("cueStarted")
      do { try await VoiceCheckListeningCue.shared.play(capture.id, preservingRecordingSession: true, timings: capture.timings) }
      catch { capture.details["listeningCueError"] = error.localizedDescription }
      capture.timings.mark("cueCompleted")
      try Task.checkCancellation()
      guard capture.engine.isRunning else { throw fail("Microphone stopped during the ready cue.", reason: "audio_interrupted") }
      capture.timings.mark("listeningGateOpened")
      capture.listeningStarted = ProcessInfo.processInfo.systemUptime
      guard capture.meter.beginListening(now: capture.listeningStarted!, seconds: window / 1000) else { throw CancellationError() }
      capture.onCaptureStopped = { phase("finalizing") }
      deadline(capture, seconds: window / 1000 + 0.2, reason: "no_speech_timeout")
      phase("listening")
      let limit = capture.listeningStarted! + window / 1000
      while ProcessInfo.processInfo.systemUptime < limit {
        let now = ProcessInfo.processInfo.systemUptime
        if capture.meter.snapshot().ready { capture.timings.mark("calibrationCompleted") }
        if let endpoint = capture.meter.snapshot().endpoint(now: now, speechRecognized: capture.speechReceived, deadline: limit) {
          capture.details["endpointReason"] = endpoint
          break
        }
        try await Task.sleep(nanoseconds: 50_000_000)
      }
      if !capture.speechReceived && capture.meter.snapshot().activitySeconds < 0.12 {
        throw fail("No speech received during the response window.", reason: "no_speech_timeout")
      }
    } else {
      capture.listeningStarted = listeningStart
      capture.onCaptureStopped = { phase("finalizing") }
      phase("recording")
      try await Task.sleep(nanoseconds: 5_000_000_000)
    }
    stopAudio(capture)
    capture.timings.mark("finalizationStarted")
    capture.finalizingStarted = ProcessInfo.processInfo.systemUptime
    if capture.responseWindowMs != nil { deadline(capture, seconds: 2.5, reason: "finalization_incomplete") }
    phase("finalizing")
    try await analyzer.finalizeAndFinishThroughEndOfInput()
    try Task.checkCancellation()
    return try await capture.results!.value
  }
}
public final class LocalFoundationModelsModule: Module {

  public func definition() -> ModuleDefinition {
    Name("LocalFoundationModels")
    AsyncFunction("playVoiceCheckListeningCue") { (requestId: String) async throws in
      try await VoiceCheckListeningCue.shared.play(requestId)
    }
    AsyncFunction("cancelVoiceCheckListeningCue") { (requestId: String) async in
      await VoiceCheckListeningCue.shared.cancel(requestId)
    }
#if DEBUG
    Events("offlineSpeechProgress", "spanishTranscriberTestProgress")
#else
    Events("offlineSpeechProgress")
#endif

#if DEBUG
    AsyncFunction("prepareVoiceCheckAlignedSession") { (requestId: String) async throws -> [String: Any] in
      try await VoiceCheckSessionAlignment.shared.prepare(requestId)
    }
    AsyncFunction("testSpanishOfflineTranscription") { (requestId: String) async -> [String: Any] in
      if #available(iOS 26.0, *) {
        return await SpanishOfflineRecognition.shared.run(requestId) { progress in
          self.sendEvent("spanishTranscriberTestProgress", progress)
        }
      }
      return ["status": "error", "reason": "requires_ios_26", "transcript": ""]
    }
    AsyncFunction("cancelSpanishOfflineTranscription") { (requestId: String) async in
      await VoiceRecognitionPreparation.shared.cancel(requestId)
      if #available(iOS 26.0, *) { await SpanishOfflineRecognition.shared.cancel(requestId) }
    }
    AsyncFunction("checkSpanishTranscriberCapability") { () async -> [String: Any] in
      if #available(iOS 26.0, *) {
        return await SpanishTranscriberDiagnostic.report()
      }
      return ["status": "requires_ios_26", "osVersion": ProcessInfo.processInfo.operatingSystemVersionString,
              "deviceAvailable": false, "supportedSpanishLocales": [], "installedSpanishLocales": [],
              "requestedLocales": [], "assets": [], "reservedLocales": [], "maximumReservedLocales": 0]
    }
#endif

    AsyncFunction("listLocalVoices") { () async -> [[String: Any]] in
      await LocalSpeechPlayback.shared.voices()
    }

    AsyncFunction("speakLocal") { (text: String, voiceId: String, requestId: String) async -> [String: Any] in
      await LocalSpeechPlayback.shared.speak(text, voiceId: voiceId, requestId: requestId)
    }

    AsyncFunction("cancelLocalSpeech") { (requestId: String) async in
      await LocalSpeechPlayback.shared.cancel(requestId)
    }

    AsyncFunction("checkOfflineSpeechCapability") { (locale: String) async -> [String: Any] in
      if locale == "es-US" { return await SpanishSpeechCapability.report(locale) }
      return await OfflineSpeechDiagnostic.shared.capability(locale)
    }

    AsyncFunction("prepareOfflineRecognition") { (locale: String, requestId: String) async -> [String: Any] in
      await VoiceRecognitionPreparation.shared.prepare(locale, id: requestId)
    }

    AsyncFunction("listenOffline") { (locale: String, requestId: String, timeoutMs: Double) async -> [String: Any] in
      let prepared: PreparedVoiceRecognition?
      do { prepared = try await VoiceRecognitionPreparation.shared.consume(locale, id: requestId) }
      catch {
#if DEBUG
        let errors = await VoiceCheckSessionAlignment.shared.restore(requestId)
        if !errors.isEmpty {
          return ["status": "error", "reason": "audio_cleanup_failed", "cleanupErrors": errors, "transcript": "", "isFinal": false,
                  "sessionAlignment": await VoiceCheckSessionAlignment.shared.diagnostics(requestId) ?? [:]]
        }
#endif
        var failure: [String: Any] = ["status": "error", "reason": (error as NSError).localizedDescription, "locale": locale,
                "requiresOnDeviceRecognition": true, "transcript": "", "isFinal": false, "finalResultReceived": false,
                "nativeTimingMs": (error as NSError).userInfo["nativeTimingMs"] ?? [:]]
#if DEBUG
        if let alignment = await VoiceCheckSessionAlignment.shared.diagnostics(requestId) { failure["sessionAlignment"] = alignment }
#endif
        return failure
      }
      var report: [String: Any]
      if locale == "es-US" {
        if #available(iOS 26.0, *) {
          report = await SpanishOfflineRecognition.shared.run(requestId, responseWindowMs: timeoutMs,
                        prepared: prepared as? PreparedSpanishRecognition) { progress in
            self.sendEvent("offlineSpeechProgress", progress)
          }
        } else { report = spanishRecognitionFailure("requires_ios_26") }
      } else {
        report = await OfflineSpeechDiagnostic.shared.listen(locale, requestId: requestId, timeoutMs: timeoutMs, prepared: prepared) { progress in
          self.sendEvent("offlineSpeechProgress", progress)
        }
      }
      if let prepared {
        let errors = await prepared.dispose()
        await prepared.timings.mark("preparedResourcesReleased")
        report["nativeRevision"] = "microphone-free-prewarm-v1"
        report["nativeTimingMs"] = await prepared.timings.events
        if errors.isEmpty { await VoiceRecognitionPreparation.shared.finish(requestId) }
        if !errors.isEmpty { report["status"] = "error"; report["reason"] = "audio_cleanup_failed"; report["cleanupErrors"] = errors }
      }
#if DEBUG
      let errors = await VoiceCheckSessionAlignment.shared.restore(requestId)
      if let alignment = await VoiceCheckSessionAlignment.shared.diagnostics(requestId) { report["sessionAlignment"] = alignment }
      if !errors.isEmpty { report["status"] = "error"; report["reason"] = "audio_cleanup_failed"; report["cleanupErrors"] = (report["cleanupErrors"] as? [String] ?? []) + errors }
#endif
      return report
    }

    AsyncFunction("cancelOfflineListening") { (requestId: String) async throws in
      if #available(iOS 26.0, *) { await SpanishOfflineRecognition.shared.cancel(requestId) }
      await OfflineSpeechDiagnostic.shared.cancel(requestId)
      await VoiceRecognitionPreparation.shared.cancel(requestId)
#if DEBUG
      let errors = await VoiceCheckSessionAlignment.shared.restore(requestId, source: "cancelled")
      if !errors.isEmpty { throw await VoiceRecognitionPreparation.failure("audio_cleanup_failed") }
#endif
    }

    OnDestroy {
#if DEBUG
      Task { @MainActor in
        if let id = VoiceCheckSessionAlignment.shared.id {
          if #available(iOS 26.0, *) { await SpanishOfflineRecognition.shared.cancel(id) }
          OfflineSpeechDiagnostic.shared.cancel(id)
          _ = VoiceCheckSessionAlignment.shared.restore(id)
        }
      }
#endif
      Task { @MainActor in VoiceRecognitionPreparation.shared.cancelAll() }
      Task { @MainActor in VoiceCheckListeningCue.shared.cancelAll() }
      if #available(iOS 26.0, *) { Task { @MainActor in SpanishOfflineRecognition.shared.cancelAll() } }
      Task { @MainActor in OfflineSpeechDiagnostic.shared.cancelAll() }
      Task { @MainActor in LocalSpeechPlayback.shared.cancelAll() }
    }
  }
}

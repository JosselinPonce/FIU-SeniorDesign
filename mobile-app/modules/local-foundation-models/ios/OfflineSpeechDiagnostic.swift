import AVFoundation
import Foundation
import Speech
import UIKit

// BEGIN TRANSCRIPT STATE: pure value semantics, exercised by host Swift regression tests.
struct OfflineRecognitionTranscripts {
  private(set) var partialTranscript = ""
  private(set) var finalTranscript = ""
  private(set) var finalResultReceived = false

  mutating func receive(_ text: String, isFinal: Bool) {
    if isFinal {
      finalResultReceived = true
      finalTranscript = text.trimmingCharacters(in: .whitespacesAndNewlines)
    } else if text.rangeOfCharacter(from: .alphanumerics) != nil {
      partialTranscript = text
    }
  }

  var hasPartial: Bool { partialTranscript.rangeOfCharacter(from: .alphanumerics) != nil }
  var hasFinalTranscript: Bool { finalResultReceived && finalTranscript.rangeOfCharacter(from: .alphanumerics) != nil }
  var displayTranscript: String { hasFinalTranscript ? finalTranscript : partialTranscript }
  var emptyFinalReason: String { hasPartial ? "empty_final_after_partial" : "no_speech" }
}
// END TRANSCRIPT STATE

/// Audio-thread meter and append gate; never infers silence from transcript cadence.
private final class SpeechActivityMeter: @unchecked Sendable {
  struct Snapshot {
    let lastBuffer: TimeInterval?
    let lastActivity: TimeInterval?
    let activitySeconds: Double
    let levelDb: Double
    let thresholdDb: Double
  }
  private let lock = NSLock()
  private var feeding = true
  private var lastBuffer: TimeInterval?
  private var lastActivity: TimeInterval?
  private var activitySeconds = 0.0
  private var levelDb = -120.0
  private var noiseFloorDb = -60.0
  private var thresholdDb = -48.0

  func append(_ buffer: AVAudioPCMBuffer, to request: SFSpeechAudioBufferRecognitionRequest) {
    lock.lock()
    defer { lock.unlock() }
    guard feeding, let channels = buffer.floatChannelData, buffer.frameLength > 0 else { return }
    var power = 0.0
    var count = 0
    for channel in 0..<Int(buffer.format.channelCount) {
      for frame in stride(from: 0, to: Int(buffer.frameLength), by: 4) {
        let value = Double(channels[channel][frame])
        power += value * value
        count += 1
      }
    }
    levelDb = 10 * log10(max(power / Double(max(count, 1)), 1e-12))
    let now = ProcessInfo.processInfo.systemUptime
    lastBuffer = now
    // Conservative energy gate. Quiet frames adapt the floor; loud frames never do.
    thresholdDb = max(-48, min(-30, noiseFloorDb + 12))
    if levelDb >= thresholdDb {
      lastActivity = now
      activitySeconds += Double(buffer.frameLength) / buffer.format.sampleRate
    } else if levelDb < thresholdDb - 6 {
      noiseFloorDb = 0.95 * noiseFloorDb + 0.05 * levelDb
    }
    request.append(buffer)
  }

  func stopFeeding() {
    lock.lock()
    feeding = false // waits for any in-flight append before endAudio is called
    lock.unlock()
  }

  func snapshot() -> Snapshot {
    lock.lock()
    defer { lock.unlock() }
    return Snapshot(lastBuffer: lastBuffer, lastActivity: lastActivity,
                    activitySeconds: activitySeconds, levelDb: levelDb, thresholdDb: thresholdDb)
  }
}

/// Owns only diagnostic capture. The development launcher excludes production audio.
@MainActor
final class OfflineSpeechDiagnostic {
  static let shared = OfflineSpeechDiagnostic()

  private final class Capture {
    let id: String
    let locale: String
    let started = ProcessInfo.processInfo.systemUptime
    let continuation: CheckedContinuation<[String: Any], Never>
    let engine = AVAudioEngine()
    var request: SFSpeechAudioBufferRecognitionRequest?
    var recognizer: SFSpeechRecognizer?
    var task: SFSpeechRecognitionTask?
    var setup: Task<Void, Never>?
    var timer: Timer?
    var activityTimer: Timer?
    var finalizationTimer: Timer?
    let meter = SpeechActivityMeter()
    let progress: ([String: Any]) -> Void
    let deadline: TimeInterval
    var phase = "preparing"
    var firstPartialAt: TimeInterval?
    var captureStopped: TimeInterval?
    var finalizationStarted: TimeInterval?
    var endpointReason = "none"
    var audioEnded = false
    var observers: [NSObjectProtocol] = []
    var tapInstalled = false
    var sessionOwned = false
    var previousCategory: AVAudioSession.Category?
    var previousMode: AVAudioSession.Mode?
    var previousOptions: AVAudioSession.CategoryOptions = []
    var captureStarted: TimeInterval?
    var transcripts = OfflineRecognitionTranscripts()
    var transcript: String { transcripts.displayTranscript }

    init(id: String, locale: String, timeoutMs: Double,
         progress: @escaping ([String: Any]) -> Void,
         continuation: CheckedContinuation<[String: Any], Never>) {
      self.id = id
      self.locale = locale
      self.continuation = continuation
      self.progress = progress
      self.deadline = ProcessInfo.processInfo.systemUptime + timeoutMs / 1000
    }
  }

  private var capture: Capture?
  var isBusy: Bool { capture != nil }
  private var cancelledBeforeStart: [String] = []

  private func canonical(_ locale: String) -> String {
    locale.replacingOccurrences(of: "_", with: "-").lowercased()
  }

  private func exactRecognizer(_ locale: String) -> SFSpeechRecognizer? {
    guard SFSpeechRecognizer.supportedLocales().contains(where: { canonical($0.identifier) == canonical(locale) }),
          let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale)),
          canonical(recognizer.locale.identifier) == canonical(locale) else { return nil }
    return recognizer
  }

  func capability(_ locale: String) -> [String: Any] {
    guard let recognizer = exactRecognizer(locale) else {
      return capabilityResult(locale, false, false, "unsupported_locale", "No recognizer for the exact requested locale.")
    }
    guard recognizer.supportsOnDeviceRecognition else {
      return capabilityResult(locale, false, recognizer.isAvailable, "offline_unsupported", "On-device recognition is unsupported for this locale. Capture will not start.")
    }
    return capabilityResult(locale, true, recognizer.isAvailable,
      recognizer.isAvailable ? "supported" : "recognizer_unavailable",
      recognizer.isAvailable ? "The exact locale supports on-device recognition. Offline operation still needs device testing." : "On-device support exists, but the recognizer is currently unavailable.")
  }

  private func capabilityResult(_ locale: String, _ supports: Bool, _ available: Bool, _ reason: String, _ message: String) -> [String: Any] {
    ["locale": locale, "supportsOnDeviceRecognition": supports, "recognizerAvailable": available,
     "reason": reason, "message": message,
     "speechPermission": String(describing: SFSpeechRecognizer.authorizationStatus()),
     "microphonePermission": String(describing: AVAudioSession.sharedInstance().recordPermission)]
  }

  func listen(_ locale: String, requestId: String, timeoutMs: Double,
              progress: @escaping ([String: Any]) -> Void) async -> [String: Any] {
    if let index = cancelledBeforeStart.firstIndex(of: requestId) {
      cancelledBeforeStart.remove(at: index)
      return immediateError(locale, "cancelled", "Capture cancelled before starting.")
    }
    guard capture == nil else { return immediateError(locale, "busy", "Diagnostic capture is already active.") }
    guard !LocalSpeechPlayback.shared.isBusy else {
      return immediateError(locale, "audio_busy", "Diagnostic speech playback is active. Capture refused.")
    }
    guard timeoutMs.isFinite, (1000...30000).contains(timeoutMs) else {
      return immediateError(locale, "invalid_timeout", "Timeout must be between 1000 and 30000 milliseconds.")
    }
    guard let recognizer = exactRecognizer(locale), recognizer.supportsOnDeviceRecognition else {
      return immediateError(locale, "offline_unsupported", "The exact locale does not support on-device recognition. No network fallback is allowed.")
    }
    guard Bundle.main.object(forInfoDictionaryKey: "NSMicrophoneUsageDescription") != nil,
          Bundle.main.object(forInfoDictionaryKey: "NSSpeechRecognitionUsageDescription") != nil else {
      return immediateError(locale, "missing_usage_description", "Microphone and speech usage descriptions are required in Info.plist.")
    }

    return await withCheckedContinuation { continuation in
      let current = Capture(id: requestId, locale: locale, timeoutMs: timeoutMs,
                            progress: progress, continuation: continuation)
      current.recognizer = recognizer
      capture = current
      publishProgress(current)
      // Includes permission/setup time, so even a stalled permission callback is bounded.
      current.timer = Timer.scheduledTimer(withTimeInterval: timeoutMs / 1000, repeats: false) { [weak self] _ in
        Task { @MainActor in
          guard let self, self.capture === current else { return }
          let reason = current.transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? "no_speech_timeout" : "overall_timeout"
          self.finish(requestId, code: reason, message: "Overall deadline reached without a final result. Any transcript shown is incomplete.")
        }
      }
      current.setup = Task { [weak self] in
        guard let self else { return }
        let speech = await self.speechPermission()
        guard self.capture === current else { return }
        guard speech else { self.finish(requestId, code: "speech_permission_denied", message: "Allow Speech Recognition in iPhone Settings."); return }
        let microphone = await self.microphonePermission()
        guard self.capture === current else { return }
        guard microphone else { self.finish(requestId, code: "microphone_permission_denied", message: "Allow Microphone access in iPhone Settings."); return }
        self.start(current, recognizer: recognizer)
      }
    }
  }

  private func speechPermission() async -> Bool {
    switch SFSpeechRecognizer.authorizationStatus() {
    case .authorized: return true
    case .notDetermined:
      return await withCheckedContinuation { continuation in
        SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0 == .authorized) }
      }
    default: return false
    }
  }

  private func microphonePermission() async -> Bool {
    let session = AVAudioSession.sharedInstance()
    switch session.recordPermission {
    case .granted: return true
    case .undetermined:
      return await withCheckedContinuation { continuation in
        session.requestRecordPermission { continuation.resume(returning: $0) }
      }
    default: return false
    }
  }

  private func start(_ current: Capture, recognizer: SFSpeechRecognizer) {
    guard capture === current else { return }
    guard UIApplication.shared.applicationState == .active else {
      finish(current.id, code: "app_inactive", message: "Bring the app to the foreground before starting capture."); return
    }
    // Recheck the same exact-locale recognizer immediately before constructing a task.
    guard recognizer.supportsOnDeviceRecognition, recognizer.isAvailable else {
      finish(current.id, code: "recognizer_unavailable", message: "Exact-locale on-device recognizer is unavailable. Capture refused."); return
    }
    do {
      let session = AVAudioSession.sharedInstance()
      current.previousCategory = session.category
      current.previousMode = session.mode
      current.previousOptions = session.categoryOptions
      current.sessionOwned = true
      try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetooth, .duckOthers])
      try session.setActive(true)

      let request = SFSpeechAudioBufferRecognitionRequest()
      request.requiresOnDeviceRecognition = true // unconditional; never retry with false
      request.shouldReportPartialResults = true
      request.taskHint = .confirmation
      current.request = request
      current.task = recognizer.recognitionTask(with: request) { [weak self] result, error in
        Task { @MainActor in
          guard let self, self.capture === current else { return }
          if let result {
            current.transcripts.receive(result.bestTranscription.formattedString, isFinal: result.isFinal)
            if !result.isFinal, current.transcript.rangeOfCharacter(from: .alphanumerics) != nil,
               current.firstPartialAt == nil {
              current.firstPartialAt = ProcessInfo.processInfo.systemUptime
            }
          }
          if let error {
            self.finish(current.id, code: "recognition_failed", message: error.localizedDescription)
          } else if result?.isFinal == true {
            self.finish(current.id, code: current.transcripts.hasFinalTranscript ? nil : current.transcripts.emptyFinalReason,
              message: current.transcripts.hasFinalTranscript ? "Final on-device transcription."
                : current.transcripts.hasPartial ? "Speech was detected, but the final result was empty. The response was not confirmed."
                : "No speech recognized.", isFinal: current.transcripts.hasFinalTranscript)
          } else {
            self.publishProgress(current)
          }
        }
      }
      let input = current.engine.inputNode
      let format = input.outputFormat(forBus: 0)
      guard format.sampleRate > 0, format.channelCount > 0,
            format.commonFormat == .pcmFormatFloat32, !format.isInterleaved else {
        finish(current.id, code: "invalid_audio_format", message: "Microphone audio format is unavailable."); return
      }
      let meter = current.meter
      input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in meter.append(buffer, to: request) }
      current.tapInstalled = true
      current.observers = [
        NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] _ in
          Task { @MainActor in self?.finish(current.id, code: "audio_interrupted", message: "Audio session interrupted; capture stopped.") }
        },
        NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
          Task { @MainActor in self?.finish(current.id, code: "backgrounded", message: "App backgrounded; capture stopped.") }
        },
        NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: current.engine, queue: .main) { [weak self] _ in
          Task { @MainActor in
            guard current.phase == "listening" else { return }
            self?.finish(current.id, code: "audio_route_changed", message: "Audio engine configuration changed; capture stopped.")
          }
        }
      ]
      current.engine.prepare()
      try current.engine.start()
      current.captureStarted = ProcessInfo.processInfo.systemUptime
      current.phase = "listening"
      publishProgress(current)
      current.activityTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
        Task { @MainActor in self?.checkEndpoint(current) }
      }
    } catch {
      finish(current.id, code: "audio_setup_failed", message: error.localizedDescription)
    }
  }

  private func checkEndpoint(_ current: Capture) {
    guard capture === current, current.phase == "listening" else { return }
    let now = ProcessInfo.processInfo.systemUptime
    let audio = current.meter.snapshot()
    // Transcript establishes that speech was recognized. Fresh PCM frames establish
    // quiet, with a minimum measured activity duration; a stalled tap is not silence.
    if current.firstPartialAt != nil, audio.activitySeconds >= 0.12,
       let lastBuffer = audio.lastBuffer, now - lastBuffer < 0.35,
       let lastActivity = audio.lastActivity, now - lastActivity >= 1.3 {
      beginFinalizing(current, reason: "audio_silence")
    } else if current.firstPartialAt != nil, now >= current.deadline - 2.5 {
      // Reserve finalization time if continuous noise prevents silence detection.
      beginFinalizing(current, reason: "capture_budget")
    } else {
      publishProgress(current)
    }
  }

  private func stopCapture(_ current: Capture) {
    current.meter.stopFeeding()
    current.engine.stop()
    if current.tapInstalled {
      current.engine.inputNode.removeTap(onBus: 0)
      current.tapInstalled = false
    }
    if current.captureStopped == nil { current.captureStopped = ProcessInfo.processInfo.systemUptime }
  }

  private func beginFinalizing(_ current: Capture, reason: String) {
    guard capture === current, current.phase == "listening" else { return }
    current.phase = "finalizing"
    current.endpointReason = reason
    current.activityTimer?.invalidate()
    current.activityTimer = nil
    current.finalizationStarted = ProcessInfo.processInfo.systemUptime
    stopCapture(current)
    endRequestAudio(current)
    // Keep recognition alive; cancelling here would prevent Apple's final callback.
    publishProgress(current)
    let grace = min(2.5, max(0, current.deadline - ProcessInfo.processInfo.systemUptime))
    current.finalizationTimer = Timer.scheduledTimer(withTimeInterval: grace, repeats: false) { [weak self] _ in
      Task { @MainActor in
        self?.finish(current.id, code: "finalization_incomplete",
          message: "Finalization grace expired. The transcript is partial, not final.")
      }
    }
  }

  private func endRequestAudio(_ current: Capture) {
    guard !current.audioEnded else { return }
    current.audioEnded = true
    current.request?.endAudio()
  }

  private func publishProgress(_ current: Capture) {
    guard capture === current else { return }
    let now = ProcessInfo.processInfo.systemUptime
    let audio = current.meter.snapshot()
    current.progress([
      "requestId": current.id, "phase": current.phase, "transcript": current.transcript,
      "elapsedMs": (now - current.started) * 1000,
      "audioLevelDb": audio.levelDb, "activityThresholdDb": audio.thresholdDb,
      "silenceMs": audio.lastActivity.map { (now - $0) * 1000 } ?? 0,
      "measuredActivityMs": audio.activitySeconds * 1000,
      "endpointReason": current.endpointReason
    ])
  }

  func cancel(_ requestId: String) {
    if capture?.id == requestId {
      finish(requestId, code: "cancelled", message: "Offline transcription cancelled.")
    } else {
      cancelledBeforeStart.append(requestId)
      cancelledBeforeStart = Array(cancelledBeforeStart.suffix(32))
    }
  }

  func cancelAll() {
    if let current = capture { finish(current.id, code: "cancelled", message: "Diagnostic closed.") }
  }

  private func finish(_ requestId: String, code: String?, message: String, isFinal: Bool = false) {
    guard let current = capture, current.id == requestId else { return }
    capture = nil // all callbacks from this capture are now stale
    current.timer?.invalidate()
    current.timer = nil
    current.activityTimer?.invalidate()
    current.activityTimer = nil
    current.finalizationTimer?.invalidate()
    current.finalizationTimer = nil
    current.setup?.cancel()
    current.setup = nil
    for observer in current.observers { NotificationCenter.default.removeObserver(observer) }
    current.observers = []
    stopCapture(current)
    endRequestAudio(current)
    current.task?.cancel()
    var cleanupErrors: [String] = []
    if current.sessionOwned {
      let session = AVAudioSession.sharedInstance()
      do { try session.setActive(false, options: .notifyOthersOnDeactivation) }
      catch { cleanupErrors.append(error.localizedDescription) }
      if let category = current.previousCategory, let mode = current.previousMode {
        do { try session.setCategory(category, mode: mode, options: current.previousOptions) }
        catch { cleanupErrors.append(error.localizedDescription) }
      }
    }
    let now = ProcessInfo.processInfo.systemUptime
    let activity = current.meter.snapshot()
    let cleanupMessage = cleanupErrors.isEmpty ? message : "\(message) Audio cleanup failed: \(cleanupErrors.joined(separator: "; "))"
    let status: String
    switch code {
    case nil: status = cleanupErrors.isEmpty ? "success" : "error"
    case "finalization_incomplete", "empty_final_after_partial": status = "incomplete"
    case "overall_timeout", "no_speech_timeout": status = "timeout"
    case "cancelled": status = "cancelled"
    default: status = "error"
    }
    current.continuation.resume(returning: [
      "status": status,
      "locale": current.locale, "requiresOnDeviceRecognition": true,
      "transcript": current.transcript, "isFinal": isFinal,
      "partialTranscript": current.transcripts.partialTranscript,
      "finalTranscript": current.transcripts.finalTranscript,
      "finalResultReceived": current.transcripts.finalResultReceived,
      "hasFinalTranscript": current.transcripts.hasFinalTranscript,
      "reason": code ?? (cleanupErrors.isEmpty ? "complete" : "audio_cleanup_failed"),
      "message": cleanupMessage, "totalTimeMs": (now - current.started) * 1000,
      "recognitionTimeMs": current.captureStarted.map { (now - $0) * 1000 } ?? 0,
      "listeningTimeMs": current.captureStarted.map { ((current.captureStopped ?? now) - $0) * 1000 } ?? 0,
      "finalizationTimeMs": current.finalizationStarted.map { (now - $0) * 1000 } ?? 0,
      "firstPartialTimeMs": current.firstPartialAt.map { ($0 - current.started) * 1000 } as Any? ?? NSNull(),
      "endpointReason": current.endpointReason,
      "audioLevelDb": activity.levelDb, "activityThresholdDb": activity.thresholdDb,
      "measuredActivityMs": activity.activitySeconds * 1000,
      "silenceMs": activity.lastActivity.map { (now - $0) * 1000 } ?? 0,
      "silenceTargetMs": 1300, "finalizationGraceMs": 2500
    ])
    current.request = nil
    current.task = nil
    current.recognizer = nil
  }

  private func immediateError(_ locale: String, _ reason: String, _ message: String) -> [String: Any] {
    ["status": reason == "cancelled" ? "cancelled" : "error", "locale": locale, "requiresOnDeviceRecognition": true,
     "transcript": "", "isFinal": false, "reason": reason, "message": message,
     "partialTranscript": "", "finalTranscript": "", "finalResultReceived": false, "hasFinalTranscript": false,
     "audioLevelDb": -120, "activityThresholdDb": -48, "measuredActivityMs": 0, "silenceMs": 0,
     "totalTimeMs": 0, "recognitionTimeMs": 0, "listeningTimeMs": 0,
     "finalizationTimeMs": 0, "firstPartialTimeMs": NSNull(), "endpointReason": "none",
     "silenceTargetMs": 1300, "finalizationGraceMs": 2500]
  }
}

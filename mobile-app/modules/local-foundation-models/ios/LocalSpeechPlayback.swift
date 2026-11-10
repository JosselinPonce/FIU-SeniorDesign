import AVFoundation
import Foundation
import UIKit

/// Short local cue, completed before recognition starts. Shares the caller's existing audio lease.
@MainActor
final class VoiceCheckListeningCue {
  static let shared = VoiceCheckListeningCue()
  @MainActor private final class Operation: NSObject, AVAudioPlayerDelegate {
    let id: String
    var player: AVAudioPlayer?
    var task: Task<Void, Error>?
    var completion: CheckedContinuation<Void, Error>?
    var timeout: Task<Void, Never>?
    init(_ id: String) { self.id = id; super.init() }
    func finish(_ error: Error? = nil) {
      timeout?.cancel(); timeout = nil
      let pending = completion; completion = nil
      if let error { pending?.resume(throwing: error) } else { pending?.resume() }
    }
    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
      finish(flag ? nil : NSError(domain: "VoiceCheckCue", code: 2, userInfo: [NSLocalizedDescriptionKey: "Listening cue playback did not finish."]))
    }
    func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
      finish(error ?? NSError(domain: "VoiceCheckCue", code: 3))
    }
  }
  private var active: Operation?
  private var cancelled: [String] = []
  private func waveform() -> Data {
    let rate = 44100, count = 6174 // 140 ms with a smooth attack and release.
    var pcm = Data()
    func append<T: FixedWidthInteger>(_ value: T, to data: inout Data) {
      var little = value.littleEndian
      withUnsafeBytes(of: &little) { data.append(contentsOf: $0) }
    }
    for index in 0..<count {
      let t = Double(index) / Double(rate)
      let envelope = pow(sin(.pi * Double(index) / Double(count)), 2)
      let sample = 0.12 * envelope * (sin(2 * .pi * 660 * t) + 0.4 * sin(2 * .pi * 880 * t))
      append(Int16(sample * 32767), to: &pcm)
    }
    var wav = Data("RIFF".utf8)
    append(UInt32(36 + pcm.count), to: &wav); wav.append(Data("WAVEfmt ".utf8))
    append(UInt32(16), to: &wav); append(UInt16(1), to: &wav); append(UInt16(1), to: &wav)
    append(UInt32(rate), to: &wav); append(UInt32(rate * 2), to: &wav)
    append(UInt16(2), to: &wav); append(UInt16(16), to: &wav)
    wav.append(Data("data".utf8)); append(UInt32(pcm.count), to: &wav); wav.append(pcm)
    return wav
  }
  func play(_ requestId: String, preservingRecordingSession: Bool = false, timings: VoiceRecognitionTimings? = nil) async throws {
    if let index = cancelled.firstIndex(of: requestId) { cancelled.remove(at: index); return }
    guard active == nil else { throw NSError(domain: "VoiceCheckCue", code: 5, userInfo: [NSLocalizedDescriptionKey: "Another listening cue is already active."]) }
    let operation = Operation(requestId)
    active = operation
    defer { if active === operation { active = nil } }
    operation.task = Task {
      defer { operation.player?.stop(); operation.player = nil }
      try Task.checkCancellation()
      let session = AVAudioSession.sharedInstance()
      if !preservingRecordingSession {
        try session.setCategory(.playback, mode: .voicePrompt, options: [.duckOthers])
        try session.setActive(true)
      }
      let player = try AVAudioPlayer(data: waveform())
      operation.player = player
      player.delegate = operation
      player.volume = 0.65 // Moderate cue gain; hardware volume and the selected route remain user-controlled.
      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
        operation.completion = continuation
        timings?.mark("cuePlayerPreparationStarted")
        let prepared = player.prepareToPlay()
        timings?.mark("cuePlayerPreparationReturned")
        guard prepared, player.play() else {
          operation.finish(NSError(domain: "VoiceCheckCue", code: 1, userInfo: [NSLocalizedDescriptionKey: "Listening cue could not start on the current audio route."]))
          return
        }
        timings?.mark("cuePlayerPlayReturned")
        operation.timeout = Task {
          do { try await Task.sleep(nanoseconds: 800_000_000) } catch { return }
          player.stop()
          operation.finish(NSError(domain: "VoiceCheckCue", code: 4, userInfo: [NSLocalizedDescriptionKey: "Listening cue playback timed out."]))
        }
      }
      timings?.mark("cuePlaybackCompletionObserved")
      // Preserve the short acoustic tail, but measure completion from actual playback, not a startup estimate.
      try await Task.sleep(nanoseconds: 40_000_000)
      timings?.mark("cueAcousticTailCompleted")
    }
    try await operation.task!.value
  }
  func cancel(_ requestId: String) async {
    stop(requestId)
    if let operation = active, operation.id == requestId { _ = await operation.task?.result }
  }
  func stop(_ requestId: String) {
    guard let operation = active, operation.id == requestId else {
      cancelled.append(requestId); if cancelled.count > 16 { cancelled.removeFirst() }; return
    }
    operation.player?.stop()
    operation.finish(CancellationError())
    operation.task?.cancel()
  }
  func cancelAll() { if let operation = active { stop(operation.id) } }
}

// BEGIN PLAYBACK COMPLETION STATE: exercised by host Swift regression tests.
struct LocalPlaybackCompletion {
  private(set) var didStart = false
  mutating func started() { didStart = true }
  func permitsSuccess(isSpeaking: Bool, isPaused: Bool) -> Bool {
    didStart && !isSpeaking && !isPaused
  }
}
// END PLAYBACK COMPLETION STATE

/// On-device Apple playback with completion-based promises and no network service.
@MainActor
final class LocalSpeechPlayback: NSObject, AVSpeechSynthesizerDelegate {
  static let shared = LocalSpeechPlayback()
  private let synthesizer = AVSpeechSynthesizer()
  private var operation: Playback?
  private var cancelledBeforeStart: [String] = []
  var isBusy: Bool { operation != nil }

  private final class Playback {
    let id: String
    let utterance: AVSpeechUtterance
    let continuation: CheckedContinuation<[String: Any], Never>
    let started = ProcessInfo.processInfo.systemUptime
    let category: AVAudioSession.Category
    let mode: AVAudioSession.Mode
    let options: AVAudioSession.CategoryOptions
    var timer: Timer?
    var stopTimer: Timer?
    var observers: [NSObjectProtocol] = []
    var stopCode: String?
    var stopMessage: String?
    var completion = LocalPlaybackCompletion()
    var completionEvent = "none"

    init(id: String, utterance: AVSpeechUtterance, continuation: CheckedContinuation<[String: Any], Never>) {
      self.id = id
      self.utterance = utterance
      self.continuation = continuation
      let session = AVAudioSession.sharedInstance()
      category = session.category
      mode = session.mode
      options = session.categoryOptions
    }
  }

  override private init() {
    super.init()
    synthesizer.delegate = self
    synthesizer.usesApplicationAudioSession = true
  }

  private func enUS(_ voice: AVSpeechSynthesisVoice) -> Bool {
    voice.identifier.hasPrefix("com.apple.") &&
      voice.language.replacingOccurrences(of: "_", with: "-").lowercased() == "en-us"
  }

  private func quality(_ voice: AVSpeechSynthesisVoice) -> String {
    if #available(iOS 16.0, *), voice.quality == .premium { return "Premium" }
    return voice.quality == .enhanced ? "Enhanced" : "Standard"
  }

  func voices() -> [[String: Any]] {
    return AVSpeechSynthesisVoice.speechVoices().filter(enUS).sorted {
      $0.quality.rawValue == $1.quality.rawValue ? $0.name < $1.name : $0.quality.rawValue > $1.quality.rawValue
    }.map { ["id": $0.identifier, "name": $0.name, "language": $0.language, "quality": quality($0)] }
  }

  func speak(_ text: String, voiceId: String, requestId: String) async -> [String: Any] {
    if let index = cancelledBeforeStart.firstIndex(of: requestId) {
      cancelledBeforeStart.remove(at: index)
      return failure("cancelled", "Playback cancelled before starting.")
    }
    guard !isBusy, !OfflineSpeechDiagnostic.shared.isBusy else {
      return failure("audio_busy", "Diagnostic capture or playback is already active.")
    }
    guard UIApplication.shared.applicationState == .active else {
      return failure("app_inactive", "Bring the app to the foreground before playback.")
    }
    guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, text.count <= 500 else {
      return failure("invalid_text", "Playback text must contain 1–500 characters.")
    }
    // Verify the identifier is currently exposed to this app; never assume an
    // Accessibility download is usable, and never silently substitute a voice.
    guard let voice = AVSpeechSynthesisVoice.speechVoices().first(where: { $0.identifier == voiceId && enUS($0) }) else {
      return failure("voice_unavailable", "Selected en-US voice is no longer available. Refresh and select an installed voice.")
    }
    let utterance = AVSpeechUtterance(string: text)
    utterance.voice = voice
    utterance.rate = AVSpeechUtteranceDefaultSpeechRate * 0.95
    utterance.volume = 1
    return await withCheckedContinuation { continuation in
      let current = Playback(id: requestId, utterance: utterance, continuation: continuation)
      operation = current
      do {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .voicePrompt, options: .duckOthers)
        try session.setActive(true)
        current.observers = [
          NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.stop(current.id, code: "audio_interrupted", message: "Playback interrupted.") }
          },
          NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.stop(current.id, code: "backgrounded", message: "App backgrounded; playback stopped.") }
          }
        ]
        current.timer = Timer.scheduledTimer(withTimeInterval: 30, repeats: false) { [weak self] _ in
          Task { @MainActor in self?.stop(current.id, code: "playback_timeout", message: "Playback completion timed out.") }
        }
        synthesizer.speak(utterance)
      } catch {
        finish(current, code: "audio_setup_failed", message: error.localizedDescription)
      }
    }
  }

  func cancel(_ requestId: String) {
    if operation?.id == requestId {
      stop(requestId, code: "cancelled", message: "Playback cancelled.")
    } else {
      cancelledBeforeStart.append(requestId)
      cancelledBeforeStart = Array(cancelledBeforeStart.suffix(32))
    }
  }

  func cancelAll() {
    if let current = operation { stop(current.id, code: "cancelled", message: "Diagnostic closed.") }
  }

  private func stop(_ requestId: String, code: String, message: String) {
    guard let current = operation, current.id == requestId, current.stopCode == nil else { return }
    current.stopCode = code
    current.stopMessage = message
    synthesizer.stopSpeaking(at: .immediate)
    // didCancel normally resolves cleanup. Poll only for a confirmed stopped
    // synthesizer if an OS callback is omitted; never manufacture didFinish.
    guard operation === current else { return }
    if !synthesizer.isSpeaking && !synthesizer.isPaused {
      finish(current, code: code, message: message)
    } else {
      current.stopTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
        Task { @MainActor in
          guard let self, self.operation === current else { return }
          if !self.synthesizer.isSpeaking && !self.synthesizer.isPaused {
            self.finish(current, code: code, message: message)
          }
        }
      }
    }
  }

  nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
    Task { @MainActor in
      guard let current = self.operation, current.utterance === utterance else { return }
      current.completion.started()
    }
  }

  nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    Task { @MainActor in
      guard let current = self.operation, current.utterance === utterance else { return }
      current.completionEvent = "didFinish"
      if current.stopCode == nil && !current.completion.permitsSuccess(
        isSpeaking: self.synthesizer.isSpeaking, isPaused: self.synthesizer.isPaused
      ) {
        // Fail closed rather than releasing playback into microphone capture.
        // stop() retains ownership until native cancellation/idle cleanup finishes.
        self.stop(current.id, code: "playback_completion_unconfirmed", message: "Playback completion was not confirmed after start and idle.")
        return
      }
      self.finish(current, code: current.stopCode, message: current.stopMessage ?? "Playback completed.")
    }
  }

  nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
    Task { @MainActor in
      guard let current = self.operation, current.utterance === utterance else { return }
      current.completionEvent = "didCancel"
      self.finish(current, code: current.stopCode ?? "cancelled", message: current.stopMessage ?? "Playback cancelled.")
    }
  }

  private func finish(_ current: Playback, code: String?, message: String) {
    guard operation === current else { return }
    current.timer?.invalidate()
    current.timer = nil
    current.stopTimer?.invalidate()
    current.stopTimer = nil
    for observer in current.observers { NotificationCenter.default.removeObserver(observer) }
    current.observers = []
    var errors: [String] = []
    let session = AVAudioSession.sharedInstance()
    do { try session.setActive(false, options: .notifyOthersOnDeactivation) }
    catch { errors.append(error.localizedDescription) }
    do { try session.setCategory(current.category, mode: current.mode, options: current.options) }
    catch { errors.append(error.localizedDescription) }
    operation = nil
    current.continuation.resume(returning: [
      "status": code == nil && errors.isEmpty ? "completed" : code == "cancelled" && errors.isEmpty ? "cancelled" : "error",
      "reason": code ?? (errors.isEmpty ? "complete" : "audio_cleanup_failed"),
      "message": errors.isEmpty ? message : "\(message) Cleanup: \(errors.joined(separator: "; "))",
      "voiceId": current.utterance.voice?.identifier ?? "",
      "nativeRevision": "playback-start-finish-idle-v2",
      "playbackStarted": current.completion.didStart,
      "completionEvent": current.completionEvent,
      "elapsedMs": (ProcessInfo.processInfo.systemUptime - current.started) * 1000
    ])
  }

  private func failure(_ reason: String, _ message: String) -> [String: Any] {
    ["status": reason == "cancelled" ? "cancelled" : "error", "reason": reason,
     "message": message, "voiceId": "", "elapsedMs": 0]
  }
}

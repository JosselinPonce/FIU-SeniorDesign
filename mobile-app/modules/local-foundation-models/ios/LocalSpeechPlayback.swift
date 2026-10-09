import AVFoundation
import Foundation
import UIKit

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

  nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    Task { @MainActor in
      guard let current = self.operation, current.utterance === utterance else { return }
      self.finish(current, code: current.stopCode, message: current.stopMessage ?? "Playback completed.")
    }
  }

  nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
    Task { @MainActor in
      guard let current = self.operation, current.utterance === utterance else { return }
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
      "elapsedMs": (ProcessInfo.processInfo.systemUptime - current.started) * 1000
    ])
  }

  private func failure(_ reason: String, _ message: String) -> [String: Any] {
    ["status": reason == "cancelled" ? "cancelled" : "error", "reason": reason,
     "message": message, "voiceId": "", "elapsedMs": 0]
  }
}

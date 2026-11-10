import AVFoundation
import Foundation
import Speech
import UIKit

#if DEBUG
// BEGIN ENGLISH RESULT METADATA: presence/counts only, never text or acceptance.
private func englishRecognitionResultMetadata(_ result: SFSpeechRecognitionResult?) -> [String: Any] {
  guard let result else { return ["resultPresent": false] }
  let best = result.bestTranscription
  return ["resultPresent": true, "rawIsFinal": result.isFinal,
    "bestTrimmedPresent": !best.formattedString.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
    "bestAlphanumericPresent": best.formattedString.rangeOfCharacter(from: .alphanumerics) != nil,
    "segmentCount": best.segments.count,
    "hasNonemptySegment": best.segments.contains { !$0.substring.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty },
    "transcriptionCount": result.transcriptions.count,
    "nonemptyTranscriptionCount": result.transcriptions.reduce(0) { count, transcription in
      count + (transcription.formattedString.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0 : 1)
    }]
}
// END ENGLISH RESULT METADATA
#endif

// BEGIN LISTENING GATE: native readiness and cue completion, independent of UI scheduling.
struct VoiceListeningGate {
  enum Phase { case preparing, cue, listening, stopped }
  private(set) var phase = Phase.preparing
  private(set) var deadline: TimeInterval?
  var acceptsSpeech: Bool { phase == .listening }
  var measuresPreparation: Bool { phase == .preparing }
  mutating func nativeReady() -> Bool {
    guard phase == .preparing else { return false }
    phase = .cue
    return true
  }
  mutating func cueFinished(now: TimeInterval, seconds: Double) -> Bool {
    guard phase == .cue else { return false }
    phase = .listening; deadline = now + seconds
    return true
  }
  mutating func stop() { phase = .stopped }
}
// END LISTENING GATE

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

// BEGIN ENDPOINT STATE: pure bounded estimator, exercised by host Swift tests.
struct OfflineEndpointState {
  static let calibrationSeconds = 0.6
  private(set) var samples: [Double] = []
  private(set) var elapsed = 0.0
  private(set) var noiseFloorDb = -60.0
  private(set) var thresholdDb = -48.0
  private(set) var calibration = "collecting"
  private(set) var firstBuffer: TimeInterval?
  private(set) var lastBuffer: TimeInterval?
  private(set) var lastActivity: TimeInterval?
  private(set) var activitySeconds = 0.0
  private(set) var bufferedSeconds = 0.0
  private(set) var levelDb = -120.0
  private(set) var thresholdMinimumDb = -48.0
  private(set) var thresholdMaximumDb = -48.0

  var ready: Bool { elapsed >= Self.calibrationSeconds }

  mutating func beginListening() {
    self = OfflineEndpointState() // Calibration starts with accepted audio, never preparation or cue PCM.
  }

  mutating func receive(level: Double, duration: Double, now: TimeInterval) {
    guard level.isFinite, duration.isFinite, duration > 0 else { return }
    levelDb = level
    if firstBuffer == nil { firstBuffer = now }
    lastBuffer = now
    let calibrating = !ready
    elapsed += duration
    bufferedSeconds += duration
    if calibrating {
      // Fixed memory and fixed duration; no audio or transcript storage.
      if calibration != "speech_during_calibration", samples.count < 128 { samples.append(level) }
      if elapsed >= Self.calibrationSeconds, calibration != "speech_during_calibration" {
        let sorted = samples.sorted()
        let low = sorted[sorted.count / 10]
        let high = sorted[min(sorted.count - 1, sorted.count * 9 / 10)]
        // Loud stable input is ambiguous (steady speech can look like noise).
        // Never raise the endpoint threshold from accepted driver audio.
        calibration = high - low > 4 ? "variable_input" : high >= -48 ? "ambiguous_input" : "stable"
        if calibration == "stable" { noiseFloorDb = low }
        thresholdDb = -48
        thresholdMinimumDb = min(thresholdMinimumDb, thresholdDb)
        thresholdMaximumDb = max(thresholdMaximumDb, thresholdDb)
        samples.removeAll(keepingCapacity: false)
      }
    }
    if level >= thresholdDb {
      lastActivity = now
      activitySeconds += duration
    }
  }

  mutating func recognizedSpeech(startSeconds: Double, now: TimeInterval) {
    // Apple segment timing can arrive after calibration. Undo a contaminated
    // bootstrap even then; this evidence only protects endpointing, never consent.
    if calibration != "speech_during_calibration",
       startSeconds.isFinite, startSeconds < Self.calibrationSeconds {
      calibration = "speech_during_calibration"
      noiseFloorDb = -60 // Invalidate even a quiet, apparently stable speech estimate.
      thresholdDb = -48
      thresholdMinimumDb = min(thresholdMinimumDb, thresholdDb)
      samples.removeAll(keepingCapacity: false)
      lastActivity = now // conservative: do not end on a newly discovered utterance
    }
  }

  func endpoint(now: TimeInterval, speechRecognized: Bool, deadline: TimeInterval) -> String? {
    if ready, speechRecognized, activitySeconds >= 0.12,
       let buffer = lastBuffer, now - buffer < 0.35,
       let activity = lastActivity, now - activity >= 1.3 { return "audio_silence" }
    if speechRecognized, now >= deadline { return "capture_budget" }
    return nil
  }

  func diagnostics(now: TimeInterval) -> [String: Any] {
    ["noiseFloorDb": noiseFloorDb, "noiseCalibration": calibration,
     "calibrationWindowMs": Self.calibrationSeconds * 1000,
     "activityThresholdMinDb": thresholdMinimumDb, "activityThresholdMaxDb": thresholdMaximumDb,
     "aboveThresholdFraction": bufferedSeconds > 0 ? activitySeconds / bufferedSeconds : 0,
     "bufferedAudioMs": bufferedSeconds * 1000,
     "bufferAgeMs": lastBuffer.map { max(0, now - $0) * 1000 } as Any? ?? NSNull(),
     "audioLevelDb": levelDb, "activityThresholdDb": thresholdDb,
     "measuredActivityMs": activitySeconds * 1000,
     "silenceMs": lastActivity.map { max(0, now - $0) * 1000 } ?? 0]
  }
}
// END ENDPOINT STATE

#if DEBUG
// BEGIN ENGLISH SHADOW ENERGY: aggregates only; never endpoint or recognition evidence.
private struct ShadowEnergyDistribution {
  // Duration-weighted bins: below -90, then [-90,-84), ... [-6,0), and >=0 dB.
  static let edges = stride(from: -90.0, through: 0.0, by: 6).map { $0 }
  var bins = Array(repeating: 0.0, count: 17)
  var duration = 0.0
  var weightedPower = 0.0
  var above = 0.0
  var minimum = Double.infinity
  var maximum = -Double.infinity
  mutating func add(power: Double, duration seconds: Double) {
    guard seconds > 0 else { return }
    let level = 10 * log10(max(power, 1e-12))
    duration += seconds; weightedPower += power * seconds
    if level >= -48 { above += seconds }
    minimum = min(minimum, level); maximum = max(maximum, level)
    let index = min(16, max(0, Int(floor((level + 90) / 6)) + 1))
    bins[index] += seconds * 1000
  }
  var report: [String: Any] {
    let power = duration > 0 ? weightedPower / duration : 0
    return ["durationMs": duration * 1000, "rms": duration > 0 ? sqrt(power) as Any : NSNull(),
      "powerDb": duration > 0 ? 10 * log10(max(power, 1e-12)) as Any : NSNull(),
      "minDb": duration > 0 ? minimum as Any : NSNull(), "maxDb": duration > 0 ? maximum as Any : NSNull(),
      "aboveThresholdFraction": duration > 0 ? above / duration as Any : NSNull(), "histogramMs": bins]
  }
}
private struct ShadowEnergyGroup {
  var sampled = ShadowEnergyDistribution(), full = ShadowEnergyDistribution(), centered = ShadowEnergyDistribution()
  var duration = 0.0, weightedAbsDC = 0.0, maxAbsDC = 0.0
  mutating func add(sampled: Double, full: Double, centered: Double, dc: Double, maxDC: Double, duration: Double) {
    self.sampled.add(power: sampled, duration: duration); self.full.add(power: full, duration: duration)
    self.centered.add(power: centered, duration: duration)
    self.duration += duration; weightedAbsDC += dc * duration; maxAbsDC = max(maxAbsDC, maxDC)
  }
  var report: [String: Any] { ["sampled": sampled.report, "full": full.report, "dcCentered": centered.report,
    "meanAbsDC": duration > 0 ? weightedAbsDC / duration as Any : NSNull(), "maxAbsDC": duration > 0 ? maxAbsDC as Any : NSNull()] }
}
private struct EnglishShadowAudio {
  static let earlySeconds = 2.0
  static let maxChannels = 4
  var all = ShadowEnergyGroup(), early = ShadowEnergyGroup(), later = ShadowEnergyGroup()
  var channels = Array(repeating: ShadowEnergyGroup(), count: maxChannels)
  var elapsedAudio = 0.0
  var buffers = 0, invalidBuffers = 0, unsupportedBuffers = 0
  var minRate = Double.infinity, maxRate = 0.0, minChannels = Int.max, maxChannelsSeen = 0
  var minFrames = Int.max, maxFrames = 0
  // valueAt is used synchronously. No PCM, arrays of samples or closure is retained.
  mutating func observe(frames: Int, channelCount: Int, sampleRate: Double, existingSampledPower: Double,
                        valueAt: (Int, Int) -> Double) {
    guard frames > 0, sampleRate.isFinite, sampleRate > 0, channelCount > 0, channelCount <= 32 else {
      unsupportedBuffers += 1; return
    }
    buffers += 1; minRate = min(minRate, sampleRate); maxRate = max(maxRate, sampleRate)
    minChannels = min(minChannels, channelCount); maxChannelsSeen = max(maxChannelsSeen, channelCount)
    minFrames = min(minFrames, frames); maxFrames = max(maxFrames, frames)
    let seconds = Double(frames) / sampleRate
    let earlyDuration = min(seconds, max(0, Self.earlySeconds - elapsedAudio))
    elapsedAudio += seconds
    var fullPower = 0.0, centeredPower = 0.0, absDC = 0.0, maxDC = 0.0
    // At most four scalar channel summaries, never sample buffers.
    var summaries: [(sampled: Double, full: Double, centered: Double, dc: Double)] = []
    var valid = existingSampledPower.isFinite && existingSampledPower >= 0
    for channel in 0..<channelCount {
      var squares = 0.0, sampledSquares = 0.0, mean = 0.0, m2 = 0.0, sampledCount = 0
      for frame in 0..<frames {
        let value = valueAt(channel, frame)
        if !value.isFinite { valid = false; continue }
        squares += value * value
        if frame % 4 == 0 { sampledSquares += value * value; sampledCount += 1 }
        let delta = value - mean; mean += delta / Double(frame + 1); m2 += delta * (value - mean)
      }
      let full = squares / Double(frames), centered = max(0, m2 / Double(frames))
      fullPower += full; centeredPower += centered; absDC += abs(mean); maxDC = max(maxDC, abs(mean))
      if channel < Self.maxChannels { summaries.append((sampledSquares / Double(max(1, sampledCount)), full, centered, abs(mean))) }
    }
    guard valid, fullPower.isFinite, centeredPower.isFinite else { invalidBuffers += 1; return }
    fullPower /= Double(channelCount); centeredPower /= Double(channelCount); absDC /= Double(channelCount)
    all.add(sampled: existingSampledPower, full: fullPower, centered: centeredPower, dc: absDC, maxDC: maxDC, duration: seconds)
    early.add(sampled: existingSampledPower, full: fullPower, centered: centeredPower, dc: absDC, maxDC: maxDC, duration: earlyDuration)
    later.add(sampled: existingSampledPower, full: fullPower, centered: centeredPower, dc: absDC, maxDC: maxDC, duration: seconds - earlyDuration)
    for (index, summary) in summaries.enumerated() {
      channels[index].add(sampled: summary.sampled, full: summary.full, centered: summary.centered,
                          dc: summary.dc, maxDC: summary.dc, duration: seconds)
    }
  }
  var report: [String: Any] {
    ["version": "english-shadow-energy-v1", "thresholdDb": -48, "earlyAudioWindowMs": Self.earlySeconds * 1000,
     "windowBasis": "accepted_pcm_duration", "histogramUpperEdgesDb": ShadowEnergyDistribution.edges,
     "bufferCount": buffers, "invalidBufferCount": invalidBuffers, "unsupportedBufferCount": unsupportedBuffers,
     "sampleRateMin": buffers > 0 ? minRate as Any : NSNull(), "sampleRateMax": buffers > 0 ? maxRate as Any : NSNull(),
     "channelCountMin": buffers > 0 ? minChannels as Any : NSNull(), "channelCountMax": maxChannelsSeen,
     "frameCountMin": buffers > 0 ? minFrames as Any : NSNull(), "frameCountMax": maxFrames,
     "omittedChannelSummaries": max(0, maxChannelsSeen - Self.maxChannels),
     "all": all.report, "early": early.report, "later": later.report,
     "channels": channels.prefix(min(Self.maxChannels, maxChannelsSeen)).enumerated().map { ["index": $0.offset, "energy": $0.element.report] }]
  }
}
// END ENGLISH SHADOW ENERGY
#endif

/// Audio-thread meter and append gate; never infers silence from transcript cadence.
private final class SpeechActivityMeter: @unchecked Sendable {
  private let lock = NSLock()
  private var feeding = true
  private var gate = VoiceListeningGate()
  private var state = OfflineEndpointState()
#if DEBUG
  private var shadow = EnglishShadowAudio()
  func shadowReport() -> [String: Any] { lock.lock(); defer { lock.unlock() }; return shadow.report }
#endif
  private var firstPreparationPCM: TimeInterval?
  private var lastPreparationPCM: TimeInterval?
  func preparationPCM() -> (first: TimeInterval?, last: TimeInterval?) {
    lock.lock(); defer { lock.unlock() }; return (firstPreparationPCM, lastPreparationPCM)
  }

  func append(_ buffer: AVAudioPCMBuffer, to request: SFSpeechAudioBufferRecognitionRequest) {
    lock.lock()
    defer { lock.unlock() }
    guard feeding, gate.measuresPreparation || gate.acceptsSpeech,
          let channels = buffer.floatChannelData, buffer.frameLength > 0 else { return }
    var power = 0.0
    var count = 0
    for channel in 0..<Int(buffer.format.channelCount) {
      for frame in stride(from: 0, to: Int(buffer.frameLength), by: 4) {
        let value = Double(channels[channel][frame])
        power += value * value
        count += 1
      }
    }
    let level = 10 * log10(max(power / Double(max(count, 1)), 1e-12))
    let now = ProcessInfo.processInfo.systemUptime
    if gate.acceptsSpeech {
      state.receive(level: level, duration: Double(buffer.frameLength) / buffer.format.sampleRate, now: now)
      request.append(buffer)
#if DEBUG
      shadow.observe(frames: Int(buffer.frameLength), channelCount: Int(buffer.format.channelCount), sampleRate: buffer.format.sampleRate,
                     existingSampledPower: power / Double(max(count, 1))) { channel, frame in Double(channels[channel][frame]) }
#endif
    } else { firstPreparationPCM = firstPreparationPCM ?? now; lastPreparationPCM = now }
  }

  func prepareCue() -> Bool { lock.lock(); defer { lock.unlock() }; return gate.nativeReady() }
  func beginListening(now: TimeInterval, seconds: Double) -> Bool {
    lock.lock(); defer { lock.unlock() }
    guard feeding, gate.cueFinished(now: now, seconds: seconds) else { return false }
    state.beginListening()
#if DEBUG
    shadow = EnglishShadowAudio()
#endif
    return true
  }

  func stopFeeding() {
    lock.lock()
    feeding = false // waits for any in-flight append before endAudio is called
    gate.stop()
    lock.unlock()
  }

  func recognizedSpeech(startSeconds: Double) {
    lock.lock()
    defer { lock.unlock() }
    guard feeding else { return }
    state.recognizedSpeech(startSeconds: startSeconds, now: ProcessInfo.processInfo.systemUptime)
  }

  func snapshot() -> OfflineEndpointState {
    lock.lock()
    defer { lock.unlock() }
    return state
  }
}

/// Owns only diagnostic capture. The development launcher excludes production audio.
@MainActor
final class OfflineSpeechDiagnostic {
  static let shared = OfflineSpeechDiagnostic()

  @MainActor private final class Capture {
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
    var cueTask: Task<Void, Never>?
    var cueError: String?
    var cueVolume: Float?
    var cueRoute: [String] = []
    var timings = VoiceRecognitionTimings()
    let meter = SpeechActivityMeter()
    let progress: ([String: Any]) -> Void
    var deadline: TimeInterval
    let listeningSeconds: TimeInterval
    var phase = "preparing"
    var firstPartialAt: TimeInterval?
    var captureStopped: TimeInterval?
    var finalizationStarted: TimeInterval?
    var endpointReason = "none"
    var endpointMeasurements: [String: Any] = [:]
    var audioEnded = false
    var taskFinishRequested = false
#if DEBUG
    var debugResultMetadata: [String: [String: Any]] = [:]
    var debugRequestConfiguration: [String: Any] = [:]
    var rawAppleIsFinal: Bool?
    var finalCallbackReceivedAt: TimeInterval?
    var debugEndpointSelection: [String: Any] = [:]
    var debugEndpointChecks: [String: Bool] = [:]
    var callbackError: [String: Any] = [:]
    var taskSnapshots: [String: [String: Any]] = [:]
    func snapshotTask(_ point: String) {
      guard let task else { return }
      var value: [String: Any] = ["state": task.state.rawValue, "isCancelled": task.isCancelled, "isFinishing": task.isFinishing]
      if let error = task.error as NSError? { value["errorDomain"] = error.domain; value["errorCode"] = error.code }
      taskSnapshots[point] = value
    }
#endif
    var observers: [NSObjectProtocol] = []
    var tapInstalled = false
    var sessionOwned = false
    var previousCategory: AVAudioSession.Category?
    var previousMode: AVAudioSession.Mode?
    var previousOptions: AVAudioSession.CategoryOptions = []
    var listeningStarted: TimeInterval?
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
      self.listeningSeconds = timeoutMs / 1000
      self.deadline = ProcessInfo.processInfo.systemUptime + 5
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

  /// Validation only: no permission request, recognition task, engine or session change.
  func prevalidate(_ locale: String) throws -> SFSpeechRecognizer {
    guard let recognizer = exactRecognizer(locale), recognizer.supportsOnDeviceRecognition else {
      throw VoiceRecognitionPreparation.failure("offline_unsupported")
    }
    guard recognizer.isAvailable else { throw VoiceRecognitionPreparation.failure("recognizer_unavailable") }
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

  func listen(_ locale: String, requestId: String, timeoutMs: Double, prepared: PreparedVoiceRecognition? = nil,
              progress: @escaping ([String: Any]) -> Void) async -> [String: Any] {
    if let index = cancelledBeforeStart.firstIndex(of: requestId) {
      cancelledBeforeStart.remove(at: index)
      return immediateError(locale, "cancelled", "Capture cancelled before starting.")
    }
    guard VoiceRecognitionPreparation.shared.permitsCapture(requestId), capture == nil else { return immediateError(locale, "busy", "Diagnostic capture is already active.") }
    guard !LocalSpeechPlayback.shared.isBusy else {
      return immediateError(locale, "audio_busy", "Diagnostic speech playback is active. Capture refused.")
    }
    guard timeoutMs.isFinite, (1000...30000).contains(timeoutMs) else {
      return immediateError(locale, "invalid_timeout", "Timeout must be between 1000 and 30000 milliseconds.")
    }
    guard let recognizer = prepared?.recognizer ?? exactRecognizer(locale), recognizer.supportsOnDeviceRecognition else {
      return immediateError(locale, "offline_unsupported", "The exact locale does not support on-device recognition. No network fallback is allowed.")
    }
    guard Bundle.main.object(forInfoDictionaryKey: "NSMicrophoneUsageDescription") != nil,
          Bundle.main.object(forInfoDictionaryKey: "NSSpeechRecognitionUsageDescription") != nil else {
      return immediateError(locale, "missing_usage_description", "Microphone and speech usage descriptions are required in Info.plist.")
    }

    return await withCheckedContinuation { continuation in
      let current = Capture(id: requestId, locale: locale, timeoutMs: timeoutMs,
                            progress: progress, continuation: continuation)
      current.timings = prepared?.timings ?? current.timings
      current.timings.mark("captureActivationStarted")
      current.recognizer = recognizer
      capture = current
      publishProgress(current)
      // Preparation (including permission and first PCM calibration) is bounded
      // independently of the driver's active response window.
      current.timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: false) { [weak self] _ in
        Task { @MainActor in
          guard let self, self.capture === current, current.phase == "preparing" else { return }
          self.finish(requestId, code: "preparation_timeout", message: "Microphone preparation timed out.")
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
      current.timings.mark("audioSessionSetupStarted")
      var reused = false
#if DEBUG
      reused = VoiceCheckSessionAlignment.shared.canReuse(current.id)
#endif
      current.timings.mark(reused ? "alignedSessionReused" : "sequentialSessionSelected")
      if !reused {
        current.timings.mark("sessionCategoryStarted")
        try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetooth, .duckOthers])
        current.timings.mark("sessionCategoryCompleted")
        current.timings.mark("sessionActivationStarted")
        try session.setActive(true)
        current.timings.mark("sessionActivationCompleted")
      }
      current.timings.mark("audioSessionSetupCompleted")

      current.timings.mark("recognitionPreparationStarted")
      let request = SFSpeechAudioBufferRecognitionRequest()
      request.requiresOnDeviceRecognition = true // unconditional; never retry with false
      request.shouldReportPartialResults = true
      request.taskHint = .confirmation
#if DEBUG
      current.debugRequestConfiguration = ["requiresOnDeviceRecognition": request.requiresOnDeviceRecognition,
        "shouldReportPartialResults": request.shouldReportPartialResults, "taskHintRawValue": request.taskHint.rawValue,
        "recognizerLocale": recognizer.locale.identifier, "contextualStringCount": request.contextualStrings.count]
      if #available(iOS 16.0, *) { current.debugRequestConfiguration["addsPunctuation"] = request.addsPunctuation }
#endif
      current.request = request
      current.timings.mark("recognitionTaskStarted")
      current.task = recognizer.recognitionTask(with: request) { [weak self] result, error in
#if DEBUG
        let callbackReceivedAt = ProcessInfo.processInfo.systemUptime
        let callbackResultMetadata = englishRecognitionResultMetadata(result)
#endif
        Task { @MainActor in
          guard let self, self.capture === current else { return }
#if DEBUG
          let metadataPoint = result == nil ? "terminal" : (result?.isFinal == true ? "final" : "firstPartial")
          if current.debugResultMetadata[metadataPoint + "AtCallback"] == nil {
            current.debugResultMetadata[metadataPoint + "AtCallback"] = callbackResultMetadata
            current.debugResultMetadata[metadataPoint + "Handled"] = englishRecognitionResultMetadata(result)
          }
          current.rawAppleIsFinal = result?.isFinal
          current.snapshotTask("callback")
          if let error = error as NSError? { current.callbackError = ["domain": error.domain, "code": error.code] }
          if result?.isFinal == true {
            current.finalCallbackReceivedAt = callbackReceivedAt
            current.timings.mark("appleFinalCallbackReceived", at: callbackReceivedAt)
            current.timings.mark("appleFinalCallbackHandled")
          }
#endif
          if let result {
            if result.bestTranscription.formattedString.rangeOfCharacter(from: .alphanumerics) != nil {
              // Missing timing is ambiguous: retain the conservative original gate.
              current.meter.recognizedSpeech(startSeconds: result.bestTranscription.segments.first?.timestamp ?? 0)
            }
            if result.isFinal { current.timings.mark("finalResultReceived") }
            current.transcripts.receive(result.bestTranscription.formattedString, isFinal: result.isFinal)
            if !result.isFinal, current.transcript.rangeOfCharacter(from: .alphanumerics) != nil,
               current.firstPartialAt == nil {
              current.timings.mark("firstPartialReceived")
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
      current.timings.mark("recognitionPreparationCompleted")
      current.timings.mark("microphoneSetupStarted")
      let input = current.engine.inputNode
      let format = input.outputFormat(forBus: 0)
      guard format.sampleRate > 0, format.channelCount > 0,
            format.commonFormat == .pcmFormatFloat32, !format.isInterleaved else {
        finish(current.id, code: "invalid_audio_format", message: "Microphone audio format is unavailable."); return
      }
      let meter = current.meter
      input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in meter.append(buffer, to: request) }
      current.tapInstalled = true
      current.timings.mark("microphoneSetupCompleted")
      current.observers = [
        NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] _ in
          Task { @MainActor in self?.finish(current.id, code: "audio_interrupted", message: "Audio session interrupted; capture stopped.") }
        },
        NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
          Task { @MainActor in self?.finish(current.id, code: "backgrounded", message: "App backgrounded; capture stopped.") }
        },
        NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: current.engine, queue: .main) { [weak self] _ in
          Task { @MainActor in
            guard current.phase == "listening" ||
                  (current.phase == "preparing" && current.captureStarted != nil) else { return }
            self?.finish(current.id, code: "audio_route_changed", message: "Audio engine configuration changed; capture stopped.")
          }
        }
      ]
      current.timings.mark("engineStartRequested")
      current.timings.mark("enginePreparationStarted")
      current.engine.prepare()
      current.timings.mark("enginePreparationCompleted")
      current.timings.mark("engineHardwareStartRequested")
      try current.engine.start()
      current.timings.mark("engineStartReturned")
      current.captureStarted = ProcessInfo.processInfo.systemUptime
      // First live PCM establishes readiness. Calibration begins only after the cue.
      publishProgress(current)
      current.activityTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
        Task { @MainActor in self?.checkEndpoint(current) }
      }
    } catch {
      finish(current.id, code: "audio_setup_failed", message: error.localizedDescription)
    }
  }

  private func checkEndpoint(_ current: Capture) {
    guard capture === current, current.captureStarted != nil,
          current.phase == "preparing" || current.phase == "listening" else { return }
    let now = ProcessInfo.processInfo.systemUptime
    let audio = current.meter.snapshot()
    let preparation = current.meter.preparationPCM()
    if let first = preparation.first { current.timings.mark("firstPCMReceived", at: first) }
    if audio.ready { current.timings.mark("calibrationCompleted") }
    if current.phase == "preparing", let buffer = preparation.last, now - buffer < 0.35 {
      beginListeningCue(current)
      return
    }
    guard current.phase == "listening", current.listeningStarted != nil else { publishProgress(current); return }
    if let reason = audio.endpoint(now: now, speechRecognized: current.firstPartialAt != nil,
                                   deadline: current.deadline) {
      current.phase = "listening"
      current.endpointMeasurements = audio.diagnostics(now: now)
      beginFinalizing(current, reason: reason)
    } else {
      publishProgress(current)
    }
  }

  private func beginListeningCue(_ current: Capture) {
    guard capture === current, current.meter.prepareCue() else { return }
    guard current.engine.isRunning else {
      finish(current.id, code: "audio_interrupted", message: "Microphone stopped before readiness."); return
    }
    current.timings.mark("nativeMicrophoneReady")
    current.timer?.invalidate()
    current.phase = "listening"
    publishProgress(current) // Same native transition starts the cue and the compact indicator.
    current.cueTask = Task { @MainActor in
      current.cueVolume = AVAudioSession.sharedInstance().outputVolume
      current.cueRoute = AVAudioSession.sharedInstance().currentRoute.outputs.map { $0.portType.rawValue }
      current.timings.mark("cueStarted")
      do { try await VoiceCheckListeningCue.shared.play(current.id, preservingRecordingSession: true, timings: current.timings) }
      catch { current.cueError = error.localizedDescription }
      current.timings.mark("cueCompleted")
      guard !Task.isCancelled, capture === current else { return }
      guard current.engine.isRunning else {
        finish(current.id, code: "audio_interrupted", message: "Microphone stopped during the ready cue."); return
      }
      let now = ProcessInfo.processInfo.systemUptime
      guard current.meter.beginListening(now: now, seconds: current.listeningSeconds) else { return }
      current.phase = "listening"
      current.timings.mark("listeningGateOpened")
      current.listeningStarted = now
      current.deadline = now + current.listeningSeconds
      current.timer?.invalidate()
      current.timer = Timer.scheduledTimer(withTimeInterval: current.listeningSeconds, repeats: false) { [weak self] _ in
        Task { @MainActor in
          guard let self, self.capture === current, current.phase == "listening" else { return }
          if current.transcripts.hasPartial { self.beginFinalizing(current, reason: "capture_budget") }
          else { self.finish(current.id, code: "no_speech_timeout", message: "No speech received during the listening window.") }
        }
      }
      publishProgress(current)
    }
  }

  private func stopCapture(_ current: Capture) {
#if DEBUG
    current.timings.mark("inputStopRequested")
#endif
    current.meter.stopFeeding()
#if DEBUG
    current.timings.mark("inputStopped")
    current.timings.mark("engineTapStopRequested")
#endif
    current.engine.stop()
    if current.tapInstalled {
      current.engine.inputNode.removeTap(onBus: 0)
      current.tapInstalled = false
    }
#if DEBUG
    current.timings.mark("engineTapStopped")
#endif
    if current.captureStopped == nil { current.captureStopped = ProcessInfo.processInfo.systemUptime }
  }

  private func beginFinalizing(_ current: Capture, reason: String) {
    guard capture === current, current.phase == "listening" else { return }
#if DEBUG
    let endpointNow = ProcessInfo.processInfo.systemUptime
    let endpointAudio = current.meter.snapshot()
    current.debugEndpointSelection = endpointAudio.diagnostics(now: endpointNow)
    current.debugEndpointChecks = ["calibrationReady": endpointAudio.ready,
      "speechRecognized": current.firstPartialAt != nil,
      "minimumActivity": endpointAudio.activitySeconds >= 0.12,
      "freshPCM": endpointAudio.lastBuffer.map { endpointNow - $0 < 0.35 } ?? false,
      "silenceSatisfied": endpointAudio.lastActivity.map { endpointNow - $0 >= 1.3 } ?? false,
      "deadlineExpired": endpointNow >= current.deadline]
    if reason == "capture_budget" { current.timings.mark("captureDeadlineReached", at: endpointNow) }
#endif
    current.phase = "finalizing"
    current.timer?.invalidate()
    current.timer = nil
    current.endpointReason = reason
    current.activityTimer?.invalidate()
    current.activityTimer = nil
    current.timings.mark("finalizationStarted")
    current.finalizationStarted = ProcessInfo.processInfo.systemUptime
    stopCapture(current)
    endRequestAudio(current)
    finishRecognitionTask(current)
    // Keep recognition alive; cancelling here would prevent Apple's final callback.
    publishProgress(current)
    let grace = 2.5
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
#if DEBUG
    current.timings.mark("endAudioRequested")
#endif
    current.request?.endAudio()
#if DEBUG
    current.timings.mark("endAudioReturned")
#endif
  }

  private func finishRecognitionTask(_ current: Capture) {
    guard capture === current, current.phase == "finalizing", current.audioEnded,
          !current.taskFinishRequested, let task = current.task else { return }
    current.taskFinishRequested = true
#if DEBUG
    current.snapshotTask("beforeFinish")
    current.timings.mark("taskFinishRequested")
#endif
    task.finish() // graceful completion only; Apple's nonempty final is still required
#if DEBUG
    current.timings.mark("taskFinishReturned")
    current.snapshotTask("afterFinish")
#endif
  }

  private func publishProgress(_ current: Capture) {
    guard capture === current else { return }
    let now = ProcessInfo.processInfo.systemUptime
    let audio = current.meter.snapshot()
    current.progress([
      "requestId": current.id, "phase": current.phase == "listening" && current.listeningStarted == nil ? "ready" : current.phase, "transcript": current.transcript,
      "elapsedMs": (now - current.started) * 1000,
      "audioLevelDb": audio.levelDb, "activityThresholdDb": audio.thresholdDb,
      "silenceMs": audio.lastActivity.map { (now - $0) * 1000 } ?? 0,
      "measuredActivityMs": audio.activitySeconds * 1000,
      "endpointReason": current.endpointReason,
      "endpointDiagnostics": audio.diagnostics(now: now)
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
    if current.phase == "listening" {
      current.phase = "finalizing"
      publishProgress(current) // Hide the live indicator before potentially slow cleanup.
    }
    capture = nil // all callbacks from this capture are now stale
    current.cueTask?.cancel()
    VoiceCheckListeningCue.shared.stop(current.id)
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
#if DEBUG
    current.snapshotTask("beforeCleanupCancel")
    current.timings.mark("cleanupCancelRequested")
#endif
    current.task?.cancel()
#if DEBUG
    current.timings.mark("cleanupCancelReturned")
    current.snapshotTask("afterCleanupCancel")
#endif
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
    current.timings.mark("captureCleanupCompleted")
    var report: [String: Any] = [
      "nativeTimingMs": current.timings.events,
      "status": status,
      "locale": current.locale, "requiresOnDeviceRecognition": true,
      "transcript": current.transcript, "isFinal": isFinal,
      "partialTranscript": current.transcripts.partialTranscript,
      "finalTranscript": current.transcripts.finalTranscript,
      "finalResultReceived": current.transcripts.finalResultReceived,
      "hasFinalTranscript": current.transcripts.hasFinalTranscript,
      "reason": code ?? (cleanupErrors.isEmpty ? "complete" : "audio_cleanup_failed"),
      "message": cleanupMessage, "totalTimeMs": (now - current.started) * 1000,
      "preparationTimeMs": ((current.listeningStarted ?? now) - current.started) * 1000,
      "listeningCueError": current.cueError as Any? ?? NSNull(),
      "nativeRevision": "ready-cue-completion-v4",
      "audioOutputVolume": current.cueVolume as Any? ?? NSNull(),
      "audioOutputRoute": current.cueRoute,
      "recognitionTimeMs": current.captureStarted.map { (now - $0) * 1000 } ?? 0,
      "listeningTimeMs": current.listeningStarted.map { ((current.captureStopped ?? now) - $0) * 1000 } ?? 0,
      "finalizationTimeMs": current.finalizationStarted.map { (now - $0) * 1000 } ?? 0,
      "firstPartialTimeMs": current.firstPartialAt.map { ($0 - current.started) * 1000 } as Any? ?? NSNull(),
      "endpointReason": current.endpointReason,
      "endpointDiagnostics": activity.diagnostics(now: now),
      "endpointSelectionMeasurements": current.endpointMeasurements,
      "audioLevelDb": activity.levelDb, "activityThresholdDb": activity.thresholdDb,
      "measuredActivityMs": activity.activitySeconds * 1000,
      "silenceMs": activity.lastActivity.map { (now - $0) * 1000 } ?? 0,
      "silenceTargetMs": 1300, "finalizationGraceMs": 2500
    ]
#if DEBUG
    report["englishFinalizationDebug"] = [
      "captureId": current.id,
      "resultMetadataRevision": "english-result-metadata-v1",
      "requestConfiguration": current.debugRequestConfiguration, "resultSnapshots": current.debugResultMetadata,
      "rawAppleIsFinal": current.rawAppleIsFinal as Any? ?? NSNull(),
      "applicationFinalizationStarted": current.finalizationStarted != nil,
      "completionOrigin": current.transcripts.finalResultReceived
        ? ((current.finalizationStarted != nil && (current.finalCallbackReceivedAt ?? now) >= current.finalizationStarted!) ? "final_after_application_endpoint" : "apple_final_before_application_endpoint")
        : "terminal_without_final",
      "callbackError": current.callbackError, "taskSnapshots": current.taskSnapshots,
      "endpointAtCompletion": activity.diagnostics(now: now),
      "endpointAtSelection": current.debugEndpointSelection, "endpointSelectionChecks": current.debugEndpointChecks,
      "endpointReady": activity.ready, "hadPartial": current.transcripts.hasPartial,
      "deadlineRemainingMs": (current.deadline - now) * 1000,
      "shadowAudio": current.meter.shadowReport()
    ]
#endif
    current.continuation.resume(returning: report)
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

#if DEBUG
// BEGIN SESSION ALIGNMENT: opt-in Debug session only; never creates or starts an engine.
@MainActor
final class VoiceCheckSessionAlignment {
  static let shared = VoiceCheckSessionAlignment()
  private(set) var id: String?
  private var generation = UUID()
  private var category: AVAudioSession.Category?
  private var mode: AVAudioSession.Mode?
  private var options: AVAudioSession.CategoryOptions = []
  private var valid = false
  private var observers: [NSObjectProtocol] = []
  private var cancelled: [String] = []
  private var report: [String: Any] = [:]
  private var history: [String: [String: Any]] = [:]
  private var historyOrder: [String] = []
  private var started = ProcessInfo.processInfo.systemUptime
  private let required: AVAudioSession.CategoryOptions = [.defaultToSpeaker, .allowBluetoothHFP, .duckOthers]

  // Capture state at notification delivery, before an asynchronous actor hop can hide route loss.
  private nonisolated static func sessionState() -> [String: Any] {
    let session = AVAudioSession.sharedInstance()
    let outputs = session.currentRoute.outputs
    let inputs = session.currentRoute.inputs
    return ["category": session.category.rawValue, "mode": session.mode.rawValue,
      "categoryOptionsRawValue": session.categoryOptions.rawValue,
      "inputPorts": inputs.map { $0.portType.rawValue }, "outputPorts": outputs.map { $0.portType.rawValue },
      "inputAvailable": session.isInputAvailable, "inputPresent": !inputs.isEmpty,
      "microphonePermissionGranted": session.recordPermission == .granted,
      "builtInRoute": !outputs.isEmpty && outputs.allSatisfy { $0.portType == .builtInSpeaker || $0.portType == .builtInReceiver }
        && inputs.allSatisfy { $0.portType == .builtInMic },
      "categoryMatches": session.category == .playAndRecord, "modeMatches": session.mode == .default,
      "optionsMatch": session.categoryOptions == [.defaultToSpeaker, .allowBluetoothHFP, .duckOthers]]
  }
  private func compatible(_ state: [String: Any]) -> Bool {
    ["builtInRoute", "inputPresent", "inputAvailable", "microphonePermissionGranted", "categoryMatches", "modeMatches", "optionsMatch"].allSatisfy { state[$0] as? Bool == true }
  }
  private func remember(_ requestId: String, _ value: [String: Any]) {
    history[requestId] = value
    historyOrder.removeAll { $0 == requestId }; historyOrder.append(requestId)
    if historyOrder.count > 8 { history.removeValue(forKey: historyOrder.removeFirst()) }
  }
  private func handleEvent(owner: String, token: UUID, name: Notification.Name, reason: UInt?, receivedAt: TimeInterval, receivedState: [String: Any]) {
    // Both checks matter: a queued callback cannot target a new capture or a later generation.
    guard id == owner, generation == token else { return }
    let currentState = Self.sessionState()
    let configurationOnly = name == AVAudioSession.routeChangeNotification && (reason == 3 || reason == 8)
    let active = UIApplication.shared.applicationState == .active
    let benign = configurationOnly && valid && active && !cancelled.contains(owner)
      && compatible(receivedState) && compatible(currentState)
    var event: [String: Any] = ["source": name.rawValue, "captureOwner": owner, "ownerGeneration": token.uuidString,
      "elapsedMs": max(0, receivedAt - started) * 1000,
      "routeReasonRawValue": reason as Any? ?? NSNull(),
      "sessionAtNotification": receivedState, "sessionAtHandling": currentState,
      "appActive": active, "invalidated": !benign,
      "phase": report["reuseDecision"] == nil ? "before_reuse_decision" : "after_reuse_decision"]
    event["disposition"] = benign ? "compatible_configuration_change" : "alignment_invalidated"
    var events = report["events"] as? [[String: Any]] ?? []
    if events.count < 32 { events.append(event); report["events"] = events }
    if !benign {
      valid = false // Sticky: later compatible routes never undo a real invalidation.
      if report["firstInvalidatingEvent"] == nil { report["firstInvalidatingEvent"] = event }
    }
  }
  func prepare(_ requestId: String) throws -> [String: Any] {
    guard id == nil else { throw VoiceRecognitionPreparation.failure("aligned_session_busy") }
    let session = AVAudioSession.sharedInstance()
    guard !cancelled.contains(requestId), UIApplication.shared.applicationState == .active,
          session.recordPermission == .granted, Self.sessionState()["builtInRoute"] as? Bool == true else {
      return ["aligned": false, "reason": "sequential_route_or_permission"]
    }
    id = requestId; generation = UUID(); started = ProcessInfo.processInfo.systemUptime
    category = session.category; mode = session.mode; options = session.categoryOptions
    report = ["diagnosticRevision": "aligned-session-reuse-v2", "alignmentRequested": true, "captureOwner": requestId, "ownerGeneration": generation.uuidString, "events": [[String: Any]]()]
    let timings = VoiceRecognitionTimings()
    do {
      timings.mark("sessionCategoryStarted")
      try session.setCategory(.playAndRecord, mode: .default, options: required)
      timings.mark("sessionCategoryCompleted")
      timings.mark("sessionActivationStarted")
      try session.setActive(true)
      timings.mark("sessionActivationCompleted")
      guard compatible(Self.sessionState()) else { throw VoiceRecognitionPreparation.failure("aligned_route_unavailable") }
      valid = true
      let token = generation
      observers = [AVAudioSession.routeChangeNotification, AVAudioSession.interruptionNotification, UIApplication.didEnterBackgroundNotification].map { name in
        NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] notification in
          let state = Self.sessionState()
          let receivedAt = ProcessInfo.processInfo.systemUptime
          let reason = (notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? NSNumber)?.uintValue
          Task { @MainActor in self?.handleEvent(owner: requestId, token: token, name: name, reason: reason, receivedAt: receivedAt, receivedState: state) }
        }
      }
      report.merge(["aligned": true, "reason": "debug_opt_in", "timingMs": timings.events, "sessionAfterAlignment": Self.sessionState()]) { _, new in new }
      return report
    } catch {
      report.merge(["aligned": false, "reason": "sequential_setup_fallback", "timingMs": timings.events]) { _, new in new }
      let errors = restore(requestId)
      if !errors.isEmpty { throw VoiceRecognitionPreparation.failure("audio_cleanup_failed") }
      return history[requestId] ?? ["aligned": false, "reason": "sequential_setup_fallback"]
    }
  }
  func canReuse(_ requestId: String) -> Bool {
    let state = Self.sessionState()
    var predicates = ["ownerMatches": id == requestId, "alignmentValid": valid,
      "notCancelled": !cancelled.contains(requestId), "appActive": UIApplication.shared.applicationState == .active]
    for name in ["builtInRoute", "inputPresent", "inputAvailable", "microphonePermissionGranted", "categoryMatches", "modeMatches", "optionsMatch"] {
      predicates[name] = state[name] as? Bool == true
    }
    let failed = predicates.keys.filter { predicates[$0] == false }.sorted()
    let reused = failed.isEmpty
    let decision: [String: Any] = ["diagnosticRevision": "aligned-session-reuse-v2", "requestedCaptureId": requestId, "captureOwner": id as Any? ?? NSNull(),
      "ownerGeneration": id == nil ? NSNull() : generation.uuidString as Any,
      "reuseDecision": reused ? "reused" : "sequential_fallback", "reusePredicates": predicates,
      "failedReusePredicates": failed, "sessionAtReuse": state,
      "reuseDecisionElapsedMs": id == requestId ? max(0, ProcessInfo.processInfo.systemUptime - started) * 1000 as Any : NSNull()]
    if id == requestId { report.merge(decision) { _, new in new } }
    else {
      var detached = history[requestId] ?? ["alignmentRequested": false]
      detached.merge(decision) { _, new in new }; remember(requestId, detached)
    }
    return reused
  }
  func diagnostics(_ requestId: String) -> [String: Any]? {
    var value = id == requestId ? report : history[requestId]
    if value != nil, value?["firstInvalidatingEvent"] == nil { value?["firstInvalidatingEvent"] = NSNull() }
    return value
  }
  func restore(_ requestId: String, source: String = "capture_cleanup") -> [String] {
    if source == "cancelled", id == requestId {
      handleEvent(owner: requestId, token: generation, name: Notification.Name("alignment.cancelled"), reason: nil,
                  receivedAt: ProcessInfo.processInfo.systemUptime, receivedState: Self.sessionState())
    }
    cancelled.append(requestId); if cancelled.count > 32 { cancelled.removeFirst() }
    guard id == requestId else { return [] }
    valid = false
    observers.forEach(NotificationCenter.default.removeObserver); observers = []
    do {
      if let category, let mode { try AVAudioSession.sharedInstance().setCategory(category, mode: mode, options: options) }
      report["restoration"] = ["status": "restored", "sessionAfterRestore": Self.sessionState()]
      remember(requestId, report)
      id = nil; category = nil; mode = nil; report = [:]
      return []
    } catch {
      report["restoration"] = ["status": "failed", "sessionAfterRestore": Self.sessionState()]
      return ["Restore aligned session: \(error.localizedDescription)"]
    }
  }
}
// END SESSION ALIGNMENT
#endif

// BEGIN VOICE RECOGNITION PREPARATION
/// Monotonic offsets within one native capture. Never compare these with JS clock values.
@MainActor
final class VoiceRecognitionTimings {
  let origin = ProcessInfo.processInfo.systemUptime
  private(set) var events: [String: Double] = [:]
  func mark(_ name: String, at time: TimeInterval = ProcessInfo.processInfo.systemUptime) { if events[name] == nil { events[name] = (time - origin) * 1000 } }
}

@MainActor
class PreparedVoiceRecognition {
  let locale: String
  let timings: VoiceRecognitionTimings
  var recognizer: SFSpeechRecognizer?
  init(locale: String, timings: VoiceRecognitionTimings) { self.locale = locale; self.timings = timings }
  func dispose() async -> [String] { [] }
}

@available(iOS 26.0, *)
@MainActor
final class PreparedSpanishRecognition: PreparedVoiceRecognition {
  var resolvedLocale: Locale?
  var transcriber: SpeechTranscriber?
  var analyzer: SpeechAnalyzer?
  var format: AVAudioFormat?
  var introducedReservation = false
  var details: [String: Any] = [:]
  private var disposal: Task<[String], Never>?
  override func dispose() async -> [String] {
    if let disposal { return await disposal.value }
    let disposal = Task { @MainActor in
      if let analyzer { await analyzer.cancelAndFinishNow() }
      if introducedReservation, let resolvedLocale {
        let released = await AssetInventory.release(reservedLocale: resolvedLocale)
        details["reservationReleased"] = released
        if !released { return ["Prepared Spanish locale reservation could not be released."] }
      }
      return [] as [String]
    }
    self.disposal = disposal
    return await disposal.value
  }
  static func build(timings: VoiceRecognitionTimings) async throws -> PreparedSpanishRecognition {
    let value = PreparedSpanishRecognition(locale: "es-US", timings: timings)
    do {
      guard SpeechTranscriber.isAvailable else { throw VoiceRecognitionPreparation.failure("offline_unsupported") }
      timings.mark("localeResolutionStarted")
      guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: "es-US")),
            locale.language.languageCode?.identifier == "es" else { throw VoiceRecognitionPreparation.failure("unsupported_locale") }
      value.resolvedLocale = locale
      timings.mark("localeResolutionCompleted")
      try Task.checkCancellation()
      let before = await AssetInventory.reservedLocales
      value.details["reservationsBefore"] = before.map { $0.identifier(.bcp47) }
      let transcriber = SpeechTranscriber(locale: locale, preset: .progressiveTranscription)
      value.transcriber = transcriber
      timings.mark("assetVerificationStarted")
      value.details["assetStatusBefore"] = String(describing: await AssetInventory.status(forModules: [transcriber]))
      timings.mark("reservationStarted")
      if !before.contains(where: { $0.identifier(.bcp47) == locale.identifier(.bcp47) }) {
        do {
          guard try await AssetInventory.reserve(locale: locale) else { throw VoiceRecognitionPreparation.failure("reservation_failed") }
          value.introducedReservation = true
        } catch { throw VoiceRecognitionPreparation.failure("reservation_failed") }
      }
      timings.mark("reservationCompleted")
      try Task.checkCancellation()
      let after = await AssetInventory.status(forModules: [transcriber])
      value.details["assetStatusAfter"] = String(describing: after)
      value.details["introducedReservation"] = value.introducedReservation
      guard after == .installed else { throw VoiceRecognitionPreparation.failure("offline_assets_unavailable") }
      timings.mark("assetVerificationCompleted")
      let analyzer = SpeechAnalyzer(modules: [transcriber])
      value.analyzer = analyzer
      guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
        throw VoiceRecognitionPreparation.failure("offline_format_unavailable")
      }
      value.format = format
      try Task.checkCancellation()
      timings.mark("analyzerPreparationStarted")
      do { try await analyzer.prepareToAnalyze(in: format) }
      catch { throw VoiceRecognitionPreparation.failure("offline_preparation_failed") }
      try Task.checkCancellation()
      timings.mark("analyzerPreparationCompleted")
      return value
    } catch {
      let errors = await value.dispose()
      if !errors.isEmpty { throw VoiceRecognitionPreparation.failure("audio_cleanup_failed") }
      throw error
    }
  }
}

/// Microphone-free work only: no session mutation, engine, tap, permissions or recognition task.
/// A single owner also prevents concurrent app-specific Spanish reservation release races.
@MainActor
final class VoiceRecognitionPreparation {
  static let shared = VoiceRecognitionPreparation()
  static func failure(_ reason: String) -> NSError {
    NSError(domain: "VoiceRecognitionPreparation", code: 1, userInfo: [NSLocalizedDescriptionKey: reason])
  }
  @MainActor private final class Entry {
    let id: String
    let locale: String
    let timings = VoiceRecognitionTimings()
    var task: Task<Void, Never>?
    var timer: Task<Void, Never>?
    var result: Result<PreparedVoiceRecognition, Error>?
    var waiter: CheckedContinuation<PreparedVoiceRecognition, Error>?
    var observers: [NSObjectProtocol] = []
    var cancelled = false
    var consuming = false
    var cleanupFailed = false
    var handedOff = false
    var cleanup: Task<[String], Never>?
    init(_ id: String, _ locale: String) { self.id = id; self.locale = locale }
  }
  private var entry: Entry?
  private var cancelledIDs: [String] = []
  var isBusy: Bool { entry != nil }
  func permitsCapture(_ id: String) -> Bool { entry == nil || (entry?.id == id && entry?.handedOff == true) }
  func finish(_ id: String) {
    if let item = entry, item.id == id, item.handedOff {
      cancelledIDs.append(id); if cancelledIDs.count > 32 { cancelledIDs.removeFirst() }
      detach(item); entry = nil
    }
  }

  func prepare(_ locale: String, id: String) -> [String: Any] {
    guard !cancelledIDs.contains(id), UIApplication.shared.applicationState == .active else { return ["status": "cancelled"] }
    guard entry == nil, !OfflineSpeechDiagnostic.shared.isBusy, !LocalSpeechPlayback.shared.isBusy else { return ["status": "error", "reason": "audio_busy"] }
    if #available(iOS 26.0, *), SpanishOfflineRecognition.shared.isBusy { return ["status": "error", "reason": "audio_busy"] }
    let item = Entry(id, locale)
    entry = item
    item.timings.mark("prewarmStarted")
    item.observers = [UIApplication.didEnterBackgroundNotification, AVAudioSession.interruptionNotification, AVAudioSession.routeChangeNotification].map { name in
      NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self, weak item] notification in
        // TTS intentionally selects its playback category after prewarming starts.
        // That category-only notification does not invalidate microphone-free resources.
        if name == AVAudioSession.routeChangeNotification,
           let reason = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
           reason == AVAudioSession.RouteChangeReason.categoryChange.rawValue { return }
        Task { @MainActor in if let item { self?.invalidate(item, reason: "preparation_interrupted") } }
      }
    }
    item.task = Task { @MainActor in
      do {
        let value: PreparedVoiceRecognition
        if locale == "es-US" {
          if #available(iOS 26.0, *) { value = try await PreparedSpanishRecognition.build(timings: item.timings) }
          else { throw Self.failure("requires_ios_26") }
        } else {
          item.timings.mark("recognizerValidationStarted")
          value = PreparedVoiceRecognition(locale: locale, timings: item.timings)
          value.recognizer = try OfflineSpeechDiagnostic.shared.prevalidate(locale)
          item.timings.mark("recognizerValidationCompleted")
        }
        if item.cancelled {
          item.cleanup = Task { await value.dispose() }
          _ = await item.cleanup?.value
          return
        }
        item.timings.mark("prewarmCompleted")
        item.result = .success(value)
        item.waiter?.resume(returning: value); item.waiter = nil
      } catch {
        if (error as NSError).localizedDescription == "audio_cleanup_failed" { item.cleanupFailed = true }
        if !item.cancelled { item.result = .failure(error); item.waiter?.resume(throwing: error); item.waiter = nil }
      }
    }
    item.timer = Task {
      do { try await Task.sleep(nanoseconds: 20_000_000_000) } catch { return }
      self.invalidate(item, reason: "preparation_expired")
    }
    return ["status": "started"]
  }

  func consume(_ locale: String, id: String) async throws -> PreparedVoiceRecognition? {
    guard !cancelledIDs.contains(id) else { throw Self.failure("cancelled") }
    guard let item = entry else { return nil } // Existing diagnostics and older JS callers remain supported.
    guard item.id == id, item.locale == locale, !item.consuming else { throw Self.failure("stale_preparation") }
    item.consuming = true
    item.timings.mark("activationRequested") // JS calls this only after successful TTS completion.
    item.timer?.cancel()
    item.timer = Task {
      do { try await Task.sleep(nanoseconds: 5_000_000_000) } catch { return }
      self.invalidate(item, reason: "preparation_timeout")
    }
    do {
      let value: PreparedVoiceRecognition
      if let result = item.result { value = try result.get() }
      else { value = try await withCheckedThrowingContinuation { item.waiter = $0 } }
      guard entry === item, !item.cancelled, UIApplication.shared.applicationState == .active else { throw Self.failure("preparation_interrupted") }
      detach(item); item.handedOff = true
      value.timings.mark("prewarmConsumed")
      return value
    } catch {
      invalidate(item, reason: (error as NSError).localizedDescription)
      throw NSError(domain: "VoiceRecognitionPreparation", code: 1, userInfo: [NSLocalizedDescriptionKey: (error as NSError).localizedDescription, "nativeTimingMs": item.timings.events])
    }
  }
  private func detach(_ item: Entry) {
    item.timer?.cancel()
    item.observers.forEach(NotificationCenter.default.removeObserver); item.observers = []
  }
  private func invalidate(_ item: Entry, reason: String) {
    guard !item.cancelled, !item.handedOff else { return }
    cancelledIDs.append(item.id); if cancelledIDs.count > 32 { cancelledIDs.removeFirst() }
    item.cancelled = true; item.task?.cancel(); detach(item)
    let error = Self.failure(reason)
    if case .success(let value) = item.result { item.cleanup = Task { await value.dispose() } }
    item.result = .failure(error)
    item.waiter?.resume(throwing: error); item.waiter = nil
    // Retain the owner until cleanup settles, preventing a new reservation racing the old release.
    Task { @MainActor in
      await item.task?.value
      let errors = await item.cleanup?.value ?? []
      if errors.isEmpty, !item.cleanupFailed, self.entry === item { self.entry = nil }
    }
  }
  func cancel(_ id: String) async {
    cancelledIDs.append(id); if cancelledIDs.count > 32 { cancelledIDs.removeFirst() }
    guard let item = entry, item.id == id, !item.handedOff else { return }
    invalidate(item, reason: "cancelled")
    await item.task?.value
    let errors = await item.cleanup?.value ?? []
    if errors.isEmpty, !item.cleanupFailed, entry === item { entry = nil }
  }
  func cancelAll() { if let item = entry { invalidate(item, reason: "cancelled") } }
}

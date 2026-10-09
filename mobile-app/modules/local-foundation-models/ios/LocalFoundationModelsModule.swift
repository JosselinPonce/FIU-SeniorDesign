import ExpoModulesCore
#if canImport(FoundationModels)
import FoundationModels
#endif

public final class LocalFoundationModelsModule: Module {
  private let interpreter = DriverResponseInterpreter()

  public func definition() -> ModuleDefinition {
    Name("LocalFoundationModels")
    Events("offlineSpeechProgress")

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
      await OfflineSpeechDiagnostic.shared.capability(locale)
    }

    AsyncFunction("listenOffline") { (locale: String, requestId: String, timeoutMs: Double) async -> [String: Any] in
      await OfflineSpeechDiagnostic.shared.listen(locale, requestId: requestId, timeoutMs: timeoutMs) { progress in
        self.sendEvent("offlineSpeechProgress", progress)
      }
    }

    AsyncFunction("cancelOfflineListening") { (requestId: String) async in
      await OfflineSpeechDiagnostic.shared.cancel(requestId)
    }

    AsyncFunction("interpretDriverResponse") { (text: String, requestId: String) async -> [String: Any] in
      let response = await self.interpreter.interpret(text, requestId: requestId)
      return response.dictionary
    }

    AsyncFunction("interpretConversation") { (text: String, context: String, requestId: String) async -> [String: Any] in
      let response = await self.interpreter.interpret(text, context: context, requestId: requestId)
      return response.dictionary
    }

    AsyncFunction("cancelInterpretation") { (requestId: String) async in
      await self.interpreter.cancel(requestId: requestId)
    }

    OnDestroy {
      let interpreter = self.interpreter
      Task { await interpreter.cancelAll() }
      Task { @MainActor in OfflineSpeechDiagnostic.shared.cancelAll() }
      Task { @MainActor in LocalSpeechPlayback.shared.cancelAll() }
    }

    AsyncFunction("checkAvailability") { () -> [String: Any] in
      guard #available(iOS 26.0, *) else {
        return self.status(false, "unsupported_os", "Requires iOS 26 or later.")
      }

      #if canImport(FoundationModels)
      switch SystemLanguageModel.default.availability {
      case .available:
        return self.status(true, "available", "The on-device system language model is available.")
      case .unavailable(let reason):
        switch reason {
        case .deviceNotEligible:
          return self.status(false, "device_not_eligible", "This device does not support Apple Intelligence.")
        case .appleIntelligenceNotEnabled:
          return self.status(false, "apple_intelligence_not_enabled", "Enable Apple Intelligence in Settings.")
        case .modelNotReady:
          return self.status(false, "model_not_ready", "The system model is not ready; check again later.")
        @unknown default:
          return self.status(false, "unknown_unavailable", String(describing: reason))
        }
      @unknown default:
        return self.status(false, "unknown_availability", "The SDK returned an unrecognized availability state.")
      }
      #else
      return self.status(false, "framework_not_in_build", "Rebuild with an SDK that includes FoundationModels (Xcode 26 or later).")
      #endif
    }
  }

  private func status(_ available: Bool, _ reason: String, _ message: String) -> [String: Any] {
    return ["available": available, "reason": reason, "message": message]
  }
}

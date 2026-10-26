import ExpoModulesCore
public final class LocalFoundationModelsModule: Module {

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

    OnDestroy {
      Task { @MainActor in OfflineSpeechDiagnostic.shared.cancelAll() }
      Task { @MainActor in LocalSpeechPlayback.shared.cancelAll() }
    }
  }
}

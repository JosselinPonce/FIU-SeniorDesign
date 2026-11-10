# Phase 2C — English VoiceCheck failure investigation

## Finding

The reported iOS 26.6.2 observation establishes successful question playback followed by unavailable recognition. It does **not** identify the native cause. No new physical-device reproduction was performed. No production or diagnostic source changes are needed before collecting the existing Debug timing snapshot from the same rehearsal. This report is the only Phase 2C file added.

## Exact production path

1. `components/SettingsView.tsx`: Health & Safety → Try the voice check calls `d.rehearseVoice()` (disabled during an active drive).
2. `lib/hooks/useDriveSession.ts`: `rehearseVoice` conditionally calls `prepareVoice()` if the cached permission flag is absent/false, resets the voice cache, then calls `safety.rehearse()`. `prepareVoice` uses Expo permission/readiness APIs; its cached `onDevice` value is not the authoritative native capture result.
3. `lib/analysis/safetyController.ts`: `rehearse()` creates a synthetic warning episode and calls the real `runCheck(..., 'rehearsal')`. The configured IO is `phoneSensiVoiceIO`. Rehearsal preserves simulated handoff and does not authorize live dialing. The wrapper records playback completion separately from recognition progress.
4. `lib/voice/voiceCheck.ts`: `ask()` creates a question-specific capture ID, registers prewarming, awaits question playback, and only after successful playback invokes `listen`. Buttons/typed input race the voice operation; accepting them cancels voice work. Failed playback follows a separate visible/button fallback path.
5. `lib/voice/speechIO.ts`: `prepareRecognition` registers only locale/capture metadata. `speak` acquires safety audio ownership, launches `prepareOfflineRecognition('en-US', captureId)` concurrently with TTS, selects the saved installed voice, configures the existing prompt session, and awaits Expo TTS completion. Debug aligned-session mode is optional and **must remain disabled for the baseline reproduction**.
6. Native `VoiceRecognitionPreparation.prepare` in `ios/OfflineSpeechDiagnostic.swift` owns a microphone-free preparation entry. English calls `prevalidate`: exact `en-US` SFSpeechRecognizer, on-device support, and current availability. It does not request permissions, start a recognition task, open the microphone, or mutate the audio session. Its asynchronous validation result is consumed later; the immediate `started` acknowledgment is not proof that validation succeeded. Background/interruption/non-category-only route changes invalidate preparation. Unused preparation expires after 20 seconds.
7. After TTS completes, `speechIO.listen` reacquires/checks ownership, checks the prepared ID/language, awaits the bridge preparation acknowledgment, subscribes to request-filtered progress, and calls `listenOffline`. A local cancellation epoch and native capture ID prevent stale publication.
8. `LocalFoundationModelsModule.swift` consumes the native preparation (activation preparation has a five-second bound). For English it calls `OfflineSpeechDiagnostic.listen`, not SpeechTranscriber. The bridge returns preparation failures as native `status`/`reason`/timing data.
9. Native `listen` checks pending cancellation, preparation/capture ownership, diagnostic playback ownership, timeout validity, on-device support, and usage-description keys. It requests/checks speech authorization, then microphone permission under a five-second preparation timer. Immediately before capture it checks foreground state and recognizer availability again.
10. Native capture preserves its existing sequential `.playAndRecord` session setup, on-device SFSpeechAudioBufferRecognitionRequest, recognition task, input-format validation, input tap, engine preparation/start, live-PCM readiness, and ready cue. The active answer window begins after readiness/cue handling, not at prewarm. Finalization and cleanup precede the returned result. No cloud recognition fallback is enabled.
11. `speechIO` converts the returned result to final-evidence metadata, verifies locale/on-device flags, and rejects stale epochs. `VoiceCheck` accepts only successful, genuine final evidence. Native errors/incomplete recognition retain the manual response window. Interpretation, mandatory guidance, acknowledgment eligibility, consent, and simulated handoff remain downstream deterministic controls.

## Every route to the displayed status

`responseUnavailable` in the safety-controller IO wrapper publishes `phase: 'response_unavailable'`. Only two calls in `VoiceCheck.ask` invoke it:

- `io.listen` throws while the question is still current and uncancelled. Audio ownership/acquisition failures can reach this branch because acquisition occurs outside the iOS adapter's inner catch.
- `io.listen` returns evidence with `status: 'error'` or `'incomplete'`. This includes native failures, incomplete finalization, the adapter's generic `native_adapter_failed`, and locale/on-device contract mismatch.

`SensiSafetyConversation.tsx` and `DriveView.tsx` render that phase as “Voice unavailable — use buttons or type a response.” Playback status is independent: “Playback completed” proves the question's playback promise completed, not that prewarming, permission checks, session transition, or microphone capture succeeded. Plain timeout, cancellation, stale evidence, and empty/no result do not directly select this phase, although errors during associated setup/cleanup can.

## Existing diagnostic coverage and limits

The opt-in `ResponsivenessDiagnostics` panel records bounded RAM-only warning-lane events from the **real** phone VoiceCheck. It persists no transcript, audio, reply, profile, or contact information. It is Debug-only. It already records prewarm registration/acknowledgment, TTS callbacks, capture activation, native return status/reason/revision, native monotonic milestones, timing durations, and available cue route/volume information.

| Failure category | Existing evidence | Limits |
| --- | --- | --- |
| Microphone authorization | `microphone_permission_denied`; read-only capability permission field | Invalid/unavailable input format is a separate `invalid_audio_format`; successful permission does not prove working input. |
| Speech authorization | `speech_permission_denied`; native capability permission field | Denied/restricted/not-authorized outcomes are not individually encoded by capture's boolean permission helper. |
| Offline recognition | `offline_unsupported`, `unsupported_locale` in capability, `recognizer_unavailable` | Prewarm `started` is only registration. Availability may change before capture. |
| Session/route/engine | `audio_setup_failed`, `audio_interrupted`, `audio_route_changed`, `invalid_audio_format`; category/activation/engine milestones | Ordinary sequential capture groups thrown session and engine errors under `audio_setup_failed`. Snapshot omits raw NSError/domain/code and localized message. Route/volume may be absent before cue. |
| Ownership conflict | Native `busy`/`audio_busy`; last JS milestone before ownership acquisition | JS ownership exceptions are not recorded with their exact message. Missing acquired milestone alone is not proof of a conflict. |
| Preparation | Native `reason`, including validation errors, `preparation_timeout`, interruption/expiry where propagated | Invalidated IDs can later return `cancelled`, losing the earlier invalidation reason. The prewarm acknowledgment can still be `started` when asynchronous validation fails. |
| Timeout/cancellation | Returned status/reason (`no_speech_timeout`, `finalization_incomplete`, `cancelled`, etc.) and timings | No guarantee every invalidation retains its original cause; user input may cancel the operation before its final diagnostic return is observed. |
| Invalid/stale session | Native `stale_preparation` or `cancelled`; capture IDs; guarded progress | JS stale-preparation exceptions and bridge rejection are collapsed to `native_adapter_failed`, which currently has no diagnostic catch event. Stale epoch conversion happens after the native-result timing event. |

The capability API is read-only and exposes English support, availability, speech permission, and microphone permission. Settings' production advisory status summarizes it rather than showing every field. The existing developer support buttons specifically query Spanish; they must not be used as evidence about English. A debugger can inspect `OfflineSpeechDiagnostic.shared.capability("en-US")` at a MainActor breakpoint without starting capture.

The separate “Sensi voice fixture → Test prompt then microphone (offline)” can test a direct English native capture, but it uses a different playback/prewarm path. Its success or failure cannot establish the cause of this real-rehearsal failure. Do not substitute the Spanish microphone diagnostic or enable aligned-session experiments for this investigation.

## Phase 2B relationship

The new capability bridge branches only when locale equals `es-US`; `en-US` continues to `OfflineSpeechDiagnostic.shared.capability`. The English rehearsal does not consult the new Spanish helper at all. The Settings advisory check is read-only and neither acquires audio ownership nor changes session state. Phase 2B did not change production English capture, prewarm, session policy, or timing. Source inspection therefore shows no direct Spanish-capability dependency explaining this failure; it cannot rule out unrelated device/runtime issues or a stale installed binary.

## Smallest reproduction and retrieval procedure

1. Use a physical-iPhone **Debug development build**, preferably the same native/JS revision that failed. Record iOS version, app build/revision, foreground state, route (speaker/headphones/Bluetooth), and connectivity. Keep the first reproduction's route/connectivity unchanged; do not alter permissions or reinstall first, since that can erase the failing condition. Park, stop sensor monitoring/recording/other audio tests, and select the test driver's English VoiceCheck language. Do not share driver/profile data.
2. Settings → Advanced Settings → Developer responsiveness comparison: ensure the button says **Enable Debug aligned VoiceCheck session**, meaning alignment is OFF. Leave it off. Press **Start timing capture**. If already recording, press **Clear timing snapshot** instead. Do not press Stop: it clears the evidence. This capture remains enabled when navigating away from the panel.
3. Return to Settings → Health & Safety → **Try the voice check**. Let the full question play. Speak a simple synthetic “yes” after the readiness cue if it occurs. Note whether “Preparing microphone,” readiness cue/listening, or “Voice unavailable” appears. Do not use a personal symptom/transcript for this diagnostic.
4. When the failure appears, note it, then finish/cancel safely with the existing controls so cleanup completes. The rehearsal is simulated; do not switch to live emergency testing. Immediately return to Advanced Settings and press **Refresh timing snapshot**. Do not restart the app, clear capture, or switch capture off first.
5. Copy the selectable JSON (or take screenshots of the JSON) before clearing. Retrieve all related `warning` records: `capture preparation`, `playback`, `recognition`, and `release audio`. Preserve `captureId`, operation/event names, status/reason, native revision, native timing dictionary, and available route data. Match `native capture activation requested` with the native return. The first wellness question should precede any later retry/contact capture; inspect its failure rather than only the last record.
6. Interpret **`native recognition completed.details.reason`** first. For example, `offline_unsupported` identifies rejected offline support, while `audio_setup_failed` requires inspecting the last native milestone to separate category/activation from engine start. A `native prewarm acknowledged` error with `audio_busy` can explain failure before capture. A `started` acknowledgment alone cannot prove successful prewarm. Missing events mean unknown, not success or zero duration.
7. After saving the evidence, stop timing capture to clear RAM. Share only the diagnostic JSON and nonpersonal build/device observations. This procedure does not need a new diagnostic feature or a production fix.

### If the snapshot lacks the necessary detail

Use the existing Debug build attached to Xcode; reproduce once **without stepping through the timed path**. Set source breakpoints at the relevant failure branch and inspect only failure metadata:

- `OfflineSpeechDiagnostic.start`'s `catch`: inspect `error` NSError domain/code and the failed operation for `audio_setup_failed`.
- Its recognition-task error branch: inspect NSError domain/code for `recognition_failed`.
- `VoiceRecognitionPreparation` task/consume catch and `invalidate`: inspect the symbolic failure reason, capture ID, and locale. This distinguishes an original interruption/expiry from a later generic `cancelled`.
- `OfflineSpeechDiagnostic.finish`: inspect `code` and native timings for permissions, input format, and timeout failures.

For generic adapter failures, use the React Native debugger at `speechIO.listen`'s inner catch, or pause on caught exceptions around native preparation/listening. For missing ownership acquisition, inspect rejection from `acquire`/`AudioOwnership.acquire` and pending cleanup. An older/missing native bridge also throws here. Never dump whole recognition results, transcripts, profile objects, or request/audio buffers. Debugger pauses affect deadlines; do not report breakpoint-run timing as performance evidence. A Release failure requires reproduction in Debug (or debugger access to an appropriate development-signed build); Release intentionally has no timing recorder.

Only if this existing capture/debugger path proves insufficient should narrowly scoped Debug-only sanitized error instrumentation be added. No such instrumentation was necessary before the first evidence collection, and none was added speculatively.

## Checks

- Relevant automated suite: **69 passed, 0 failed, 0 skipped**. Files: `voiceCheck`, `recognitionPrewarming`, `voiceCheckResponsiveness`, `responsivenessDiagnostics`, `offlineTranscriptState`, `safetyVoice`, `spanishCapability`, and `listeningCueCompletion` tests.
- `tsc --noEmit`: passed.
- `git diff --check`: passed.
- Native helper tests use mocked platform facilities; these results are not physical microphone, iOS 26.6.2 capture, or recognition validation. No recognition/audio production changes, Gemma changes, new build configuration, dependency installation, commits, or pushes were made. Existing uncommitted work was preserved.

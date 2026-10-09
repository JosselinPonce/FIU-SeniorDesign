# DriveSense Driver Assistant integration

The main app now opens the existing dashboard flow. After selecting a driver,
use **Driver Assistant** on the Drive tab; no active drive or Pi connection is
required for a conversation. Diagnostics remain available in Debug builds from
**Local AI diagnostics** before selecting a driver (finish onboarding first).
The historical phase notes below describe the earlier diagnostic-only setup.

The runtime assistant supports iOS 26+ with Foundation Models available and
strictly on-device recognition for exact en-US. Android, missing native modules,
unsupported OS/devices, unavailable model/recognizer, and Spanish profiles show
an unavailable message; existing monitoring and safety UI remain available.
Native recognition/playback are now runtime APIs, while the diagnostic screens
remain development-only. Native source and autolinking stay in this local module.

Conversations are limited to four driver turns and a 180-second overall budget.
Each bridge stage has a 30-second deadline; capture has its own 15-second native
deadline including permissions/finalization. Only successful final offline
transcripts enter inference or consent. Partial and final text are kept separately;
an empty final after partial speech reports `incomplete / empty_final_after_partial`,
not silence. The assistant preserves the result envelope and native timing before
applying the final-only gate. Each response permits one fresh listening retry after
incomplete recognition (including a timeout with partial speech). It explains that
the response was not confirmed and repeats the current question/contact offer;
only the new successful final response can authorize anything. Both attempts are
shown with status, accepted finality, final callback/nonempty-final flags, separate
partial/final text, endpoint, timing, and Debug energy diagnostics. Recognition
limits and activity thresholds remain unchanged. Context consists of up to three previous
turns, capped at 2,400 characters, kept only in memory. Generated responses pass
shape/advisory, length, allowed-vocabulary, and forbidden-construction validation;
invalid responses use visible safety fallbacks. This is conservative validation,
not a semantic guarantee of model correctness or medical advice.

Bounded first-person prefixes such as "No, I'm a little dizzy, can you call my mom?"
are handled by deterministic rules. Refusals, uncertainty, hypotheticals, reported/
quoted speech, and emergency-service destinations remain excluded. Direct contact requests bypass AI and use the existing deterministic request
parser and SafetyController contact/ownership guards. Contextual yes requires a
specific spoken contact offer. Ambiguity, refusal, incomplete capture, cancellation,
and emergency-service mentions never authorize handoff. A standalone conversation
does not create incidents, resolve vital alerts, or affect thresholds. Opening
`tel:` is reported as phone-interface opening, never a completed call. Stop cannot
undo a phone interface handoff that has already been initiated.

The assistant reads the existing `voice:en` preference; Zoe Premium is retained
when that exact identifier is exposed for en-US. Missing preferences fail visibly
without substitution. Automatic selection uses Apple's enumerated quality ordering.
Production voice checks and previews share audio ownership with the assistant;
safety checks cancel optional audio and wait for native completion/cleanup before
speaking. Stop, closing the overlay, backgrounding, and driver/session changes
invalidate pending results. Inference cancellation is cooperative; the native actor
keeps its lock until generation unwinds, so another request may report busy.

## Physical iPhone test procedure

1. Use Xcode 26+ and iOS 26+; finish Apple Intelligence and voice downloads.
   Connect the unlocked trusted phone, with Developer Mode enabled.
2. A native rebuild is necessary for `interpretConversation` and runtime speech
   changes. Open the existing `mobile-app/ios/SmartWheel.xcworkspace`, choose the
   SmartWheel scheme, physical iPhone, and Debug configuration, and Run using
   your existing signing. Do not regenerate native projects or install pods unless
   separately authorized. If linking fails, report the error before changing setup.
3. Start Metro with `npm start` in `mobile-app`, finish onboarding/select a driver,
   then choose Settings → Voice → the installed Zoe Premium entry. Return to Drive,
   open Driver Assistant, and verify the displayed name/quality. An unavailable
   saved voice must report an error without changing the preference.
4. Start a conversation; answer only after playback, during listening. Try “I'm
   fine”, then refer to your previous answer. Check follow-ups, finalization, timing,
   and displayed fallback markers. Try silence and Stop during every stage.
5. With a saved consenting test contact, try “No, I'm feeling dizzy, please call
   Mom”. Expect one phone-interface handoff without another confirmation; complete
   or cancel any call yourself there. Try “maybe call Mom”, “do not call Mom”, and
   bare “yes” outside an offer: none should directly hand off. Test missing/invalid
   contacts and “call 911”: no automatic emergency-service dialing.
6. Close/background during playback, capture, and inference. Switch/end a drive
   and test safety-check interruption while conversing. Verify no overlapping or
   continuing audio, stale replies, or duplicate handoffs. Confirm buttons remain
   available in the original safety modal.
7. Verify Pi/ESP32 telemetry, reconnect, monitoring, local records, and Supabase
   sync normally while the assistant is open. No hardware-level behavior is verified
   by static tests. Test existing voice-check/rehearsal/demo paths separately.
8. While the loaded app remains running, enable Airplane Mode and explicitly turn
   Wi-Fi off. Repeat the full sequence without a Metro reload. Test BLE/telemetry
   separately with Bluetooth enabled; reconnect networking for Supabase testing.
   Record OS, selected voice identifier, transcripts and timing before claiming
   end-to-end offline operation. No on-device verification was performed here.

App display-name and permission text changes in app.json will not automatically
update an existing generated native project. Native branding/permission propagation
is deferred until an authorized configuration regeneration; project/bundle IDs stay
unchanged. Swift syntax parsing does not validate SDK types/macros or native linking.

---

# Phases 1–3B: Local AI and offline speech diagnostics

This local Expo module checks `SystemLanguageModel.default.availability` and
interprets a typed answer with a fresh, on-device `LanguageModelSession` using
`@Generable` structured output. It has no connection to the
driver assistant, production speech pipeline, calling, BLE, storage, or network services. A temporary
`Local AI Test` entry in `App.tsx` renders only when `__DEV__` is true, before
SmartWheel mounts. `Open SmartWheel` leaves the launcher for the production app;
restart the Debug app to return to diagnostics. This prevents concurrent
production audio without changing its pipeline. Checking runs only when its button is
tapped; missing modules and rejected calls are displayed in the modal.
Native sources live here rather than in the generated
`mobile-app/ios` project, so they survive clean prebuilds.

Expo SDK 54's autolinker discovers `mobile-app/modules` by default. The pod
depends only on the existing ExpoModulesCore dependency. The deployment target
remains iOS 15.1. Runtime use is guarded for iOS 26+, and `canImport` provides a
fallback for older SDKs. Native compilation and weak linkage on older iOS still
require verification; TypeScript checks do not validate Swift framework APIs.

## Test on an iPhone 16 Pro Max

1. Use iOS 26 or later and enable Apple Intelligence in Settings → Apple
   Intelligence & Siri. Allow the system model download/setup to finish.
2. Select Xcode 26 or later with an iOS 26+ SDK. Connect the unlocked phone,
   trust the Mac, enable Developer Mode, and configure signing for SmartWheel.
3. After explicit approval for dependency installation/native building, run
   `pod install` from `mobile-app/ios` to link the local module, then from
   `mobile-app` run `npx expo run:ios --device` and select the phone. If the
   generated iOS project is absent, obtaining approval for prebuild is also
   required. Use a Debug build (the default for this command); the CI Release
   IPA hides the diagnostic. Expo Go and existing binaries do not contain the
   new native module.
4. Open the Debug app, tap `Local AI Test` in the launcher, then `Check availability`.
   No onboarding completion, selected driver, drive, or Pi connection is needed.
   Read `available`, `reason`, and `message` on screen. Close returns to the app.
   An existing Debug binary can load the new JavaScript via Metro and display
   `native_module_missing`, but needs native rebuilding to check the real model.
5. Expect `{ available: true, reason: 'available', message: ... }` once ready.
   Disabled Apple Intelligence and an unfinished model return structured
   reasons. Recheck after changing Settings; the result is not cached.
   An older-SDK build returns `framework_not_in_build` even on an eligible phone.
   Validate `unsupported_os` separately on an older-iOS device before release.

There are no changes to app permissions, the global deployment target, or
existing production flows. Unexpected native errors reject the promise rather
than being misreported as model unavailability. Future unknown Apple statuses
return an explicit unknown reason (and a description when supplied).

## Phase 2: typed interpretation

After a separately approved native rebuild, open `Local AI Test`, enter an answer
to “Are you feeling okay?”, and tap `Test Interpretation`. A Phase 1 binary must
be rebuilt to provide the new methods; missing methods produce a visible error.
The screen displays the complete success/error envelope, native processing time,
and total bridge time. Try `I'm fine`, `I'm feeling dizzy, please call my mom`,
`Maybe call my mom`, `Don't call anyone`, `yes`, and `Call 911`.

Success fields are `wellness` (`ok`/`not_ok`/`uncertain`),
`requestsSavedEmergencyContact`, `explicitContactRequest`, and `suggestedReply`.
Both contact fields are model assessments, including the explicit-request field;
neither executes or authorizes a call. `advisoryOnly: true` and
`callAuthorized: false` are native constants, never generated by the model.
Existing deterministic consent rules remain authoritative and are not imported
or changed. The input has no prior call-offer context or saved profile attached.

Input is limited to 500 characters. Replies are prompted as one sentence under
20 words and additionally truncated to 240 characters. Each request rechecks
availability; errors include invalid input, unavailability, busy, cancellation,
invalid output, and generation failures (with SDK error detail). Medical-looking
inputs may be refused by Apple's guardrails. No fallback cloud service is used.

JavaScript and a native actor both prevent concurrent inference. Cancel and Close
request cancellation by request ID; closing/unmounting invalidates late results.
The native lock is held until a cancelled inference unwinds, so cancellation is
cooperative and may not stop immediately. Cancelled output is discarded. Module
destruction also cancels native work. Inputs/results stay in component/session
memory only; no persistence or logging is added. No inference timeout is imposed.

Typecheck, syntax parsing, and autolinking discovery do not validate the iOS
FoundationModels API/macros or model quality. Swift typechecking, physical-device
generation, cancellation behavior, and older-iOS weak linkage require a future
approved native build. Guided generation guarantees a schema, not correct meaning
or safe advice. This diagnostic is advisory and must remain isolated.

## Phase 3A: strictly on-device speech diagnostic

`Offline Speech Test · en-US` is separate from AI interpretation and speech
playback. Tap `Check en-US offline support` to inspect the exact locale without
requesting permissions or capturing audio. Tap `Test Offline Transcription` to
recheck support, request microphone/speech permissions, and capture one answer.
There is no fallback, saved audio, AI call, speech playback, or emergency action.
The transcript remains in UI memory only. The final structured result includes
locale, required-offline flag, final/partial status, error reason/message,
recognition time, and total time (including permissions/setup/cleanup).

The native implementation constructs `SFSpeechRecognizer(locale:)`, checks both
the supported-locale list and actual recognizer locale, and requires
`supportsOnDeviceRecognition` plus current recognizer availability before capture.
It sets `SFSpeechAudioBufferRecognitionRequest.requiresOnDeviceRecognition = true`
unconditionally; failures never retry with network recognition. Native methods
are disabled outside Debug builds. Apple Speech support alone is not proof that
offline operation works on this device or that its assets are ready.

Capture has a 15-second overall deadline (including permission dialogs and
finalization). After a meaningful partial transcript, microphone PCM RMS levels
are checked every 100 ms for 1.3 seconds below an adaptive activity threshold.
At least 120 ms of measured activity and fresh audio buffers are required;
transcript update timing is not used as a silence signal. A stalled audio tap is
not considered silence. The threshold is bounded to -48…-30 dBFS and uses a quiet
noise-floor estimate with a 12 dB margin.

An endpoint stops feeding buffers and microphone capture, then calls `endAudio()`
without cancelling recognition. `finalizing` allows up to 2.5 seconds for Apple's
final result, bounded by the overall deadline. If silence is not detected but a
partial exists, capture ends near the deadline minus 2.5 seconds to reserve
finalization time (`endpointReason: capture_budget`). The original overall timer
remains active; no extra time is added. An empty transcript at the overall deadline
returns `status: timeout`, `reason: no_speech_timeout`.

Results distinguish `success`, `incomplete` (finalization grace expired), `timeout`,
`cancelled`, and `error` (including recognizer and cleanup errors). Only Apple's
actual `isFinal` callback can mark a transcript final. Partials remain nonfinal
even after silence or endAudio; no synthetic finalization occurs. The screen shows
live preparing/listening/finalizing states, partial text, RMS/threshold/activity
metrics, first-partial timing, listening time, finalization time, and total time.
Retry after allowing permissions if the first run times out. Stop/Cancel, modal
dismissal, component unmount, backgrounding, interruptions, audio-engine changes,
and module destruction stop capture. Late callbacks/results are ignored. System
permission dialogs cannot be dismissed programmatically; cancelled requests never
start capture when those dialogs eventually resolve.

Audio resources are confined to the development launcher. SmartWheel is not
mounted there, and `Open SmartWheel` stays disabled until capture cleanup finishes.
Read-only checks also refuse capture when existing Expo speech/recognition is
active. The diagnostic saves audio category/mode/options, uses playAndRecord with
speaker/Bluetooth routing and ducking, then removes its tap, stops the engine,
cancels recognition, deactivates with notification, and restores those settings.
Cleanup failures are reported. No automatic resumption after interruption occurs.
AVAudioSession does not expose prior activation state; the diagnostic restores
configuration but deliberately leaves the session inactive. Test route restoration
on-device. Calls outside this isolated launcher must not share production audio.

Registration still uses the existing `expo-module.config.json` and the podspec's
Swift source glob. Speech/AVFoundation/UIKit frameworks are linked by the local
pod. Sources remain under `modules`, outside generated app `ios/`. Existing
`expo-speech-recognition` configuration already supplies both Info.plist usage
descriptions across prebuilds; no permission/config change is needed. The new
Swift listener does not use the library's unreliable installed-locale report.

### Physical iPhone test (not yet performed)

1. After explicit approval, run `pod install` in `mobile-app/ios`, then
   `npx expo run:ios --device` from `mobile-app`, selecting the iPhone and Debug
   configuration. Xcode 26+ is needed for the existing Foundation Models prototype;
   this Speech diagnostic itself preserves the iOS 15.1 deployment target.
2. Load the app JavaScript while online. Stay in the diagnostic launcher, open
   `Local AI Test`, check en-US support, and allow speech/microphone permissions
   when starting transcription. Verify the ordinary online test and Stop/Close.
3. To verify offline behavior, keep the already-loaded Debug app running, unplug
   USB to remove any tethered network path, enable Airplane Mode, and explicitly
   disable Wi-Fi and Bluetooth in Settings. Confirm cellular data is unavailable.
   Do not reload the Debug app: it normally obtains JavaScript from Metro, which
   is inaccessible with all network paths disabled. Return to the app and repeat
   both the locale check and transcription, saying “I'm feeling fine today.”
4. Verify a final transcript with `requiresOnDeviceRecognition: true` and
   `status: success`. Record device/OS/locale and results. If unavailable or any
   error occurs, capture the displayed reason; do not enable fallback.
5. Test silence/timeout, cancellation, closing while listening, backgrounding,
   and a second transcription afterward. Re-enable connectivity and separately
   test Bluetooth/audio interruption behavior. Relaunch to return to the launcher
   after selecting `Open SmartWheel`.

User testing confirmed en-US on-device capability and partial transcription on
the iPhone, but the earlier lifecycle reached its 15-second timeout without a
final result. This revised finalization lifecycle has not been tested on-device.
No iOS Swift typecheck has been obtained. Static
syntax checks and module discovery do not prove offline capture, runtime linking,
audio cleanup, or asset readiness. Unsupported locale/device/permissions fail
explicitly. The revised full conversation described below also requires device testing.

RMS is an acoustic activity heuristic, not a semantic voice-activity model.
Background noise/music can delay silence detection; very quiet speech or long
mid-sentence pauses can affect endpoints. The meaningful-transcript gate reduces
false triggers but cannot eliminate them. Validate in quiet conditions first,
then test soft speech, 1-second versus 2-second pauses, long speech, background
noise, silence, and Stop/Close during both listening and finalizing. Inspect
`endpointReason` and timing to distinguish silence-driven endpoints from budget
cutoffs. A native rebuild is required for this Swift/event change, after approval.
Repeat with all network paths disabled before claiming offline final transcription.

## Phase 3B: isolated voice conversation

`Local Voice Conversation Test` preserves the separate availability, typed-answer,
and offline-transcription diagnostics. All diagnostic operations share a synchronous
UI lease; the production SmartWheel screen is still unmounted in the launcher.
The native playback and offline capture owners also refuse overlapping operations.
No production VoiceIO, consent rules, profiles, incidents, or call actions are used.

The voice list comes directly from `AVSpeechSynthesisVoice.speechVoices()`, filtered
to Apple identifiers and exact en-US. Quality uses Apple's actual `quality` enum,
not identifier heuristics. Premium/Enhanced sort first only if enumerated; otherwise
a listed Standard voice is selected. Select any listed voice and preview it. Refresh
after installing voices; Accessibility settings alone do not establish availability
to this app. A disappeared selection fails visibly rather than silently substituting
a different voice. Selection is diagnostic-local memory, not production settings.

`Start Voice Test` checks model availability, exact-locale offline support, and
existing Expo playback/recognition inactivity before asking the fixed question:
“Are you feeling okay? Please tell me how you feel.” Native AVSpeechSynthesizer
`didFinish` plus session cleanup must complete before the offline listener starts.
The listener's preparing/listening/finalizing events update the screen. Only
`status: success`, `isFinal: true`, required-offline en-US text passes to the existing
Foundation Models interpreter; incomplete, timed-out, cancelled, and error results
stop the conversation. Recognition output and the full model result are displayed.

The model's raw suggestion is advisory and is not blindly spoken. A separate
prototype-only reply policy selects a short allowlisted response matching wellness
or a contact/call topic. Explicit contact requests get “I heard your request.
This test does not place calls.” Negative or ambiguous call mentions use a neutral
no-calls acknowledgment. Diagnoses, echoed commands, and promises of dispatched
help cannot enter playback. Both model contact flags remain advisory, never call
authorization. No production deterministic consent code is imported or changed.

Native TTS uses the shared audio session in playback/voicePrompt with ducking,
restores category/mode/options, and deactivates before resolving. Only the real
didFinish delegate callback reports completed playback. Cancellation uses
stopSpeaking(.immediate); didCancel or confirmed stopped state resolves cleanup.
A 30-second playback watchdog cancels rather than reporting success. The lease
remains held while native stop or cooperative model cancellation unwinds. No
capture can begin while playback is active, and results after Stop/dismissal or
backgrounding are discarded. Stage timings include question playback, listening,
finalization, inference (native and bridge), response playback, and total interaction.

Apple TTS has no additional network service configured here, but **end-to-end
offline operation remains unverified until Airplane Mode testing**. Voice asset
availability, completion callbacks, actual audio routing, and final recognition
still need an approved native build and device verification. If a synthesizer fails
to acknowledge stopping and continues reporting active, the diagnostic stays locked
rather than starting another audio owner. Existing inference has no hard timeout.

### Physical iPhone steps for Phase 3B

1. After approval, run `pod install` from `mobile-app/ios` to include the new Swift
   file, then `npx expo run:ios --device` from `mobile-app` with Xcode 26+, selecting
   the iPhone and Debug configuration. No build/install was run during implementation.
2. Launch into `Local AI Test`. Check availability and the standalone offline
   transcription diagnostic first. Refresh voices, select a listed en-US voice,
   and preview it. Verify the voice quality shown matches the enumerated entry.
3. Tap `Start Voice Test`. Wait for the question to finish and the listening state
   before answering. Try “I'm fine,” “I feel dizzy,” and “Please call my mom.”
   Verify final transcript, structured result, safe spoken reply, and stage timings.
   Silence or incomplete recognition must show an error without running inference.
4. Test Stop and modal dismissal during question playback, capture/finalizing,
   inference, response playback, and preview. Verify no audio continues, no late
   reply appears, and another diagnostic can run only after cleanup. Background the
   app during playback/capture too. Verify all original diagnostics still work.
5. Keep the loaded Debug app running, unplug USB, enable Airplane Mode, and explicitly
   disable Wi-Fi/Bluetooth. Do not reload from Metro. Repeat preview and the entire
   question → final transcription → interpretation → response sequence. Record OS,
   voice identifier/quality, transcript, and timings before asserting offline success.
   Re-enable connectivity afterward; test Bluetooth routing separately.

# Phase 2A — VoiceCheck integration and startup inspection

Scope: inspected the current working tree, including existing uncommitted work.
Only a regression test file and this report were added. No production runtime,
recognition, prompt, thresholds, consent/call behavior, onboarding, Supabase or IPA
configuration was changed. Proposed production fixes below require approval.

## Exact production execution path

1. `lib/hooks/useDriveSession.ts` forwards received sensor frames to
   `SafetyController.onFrame()`. Foreground/supported-screen/connection state,
   continuity, finger/contact and signal quality gate accepted readings.
2. `lib/analysis/flagEngine.ts::feed()` computes notice/warning/emergency states
   deterministically from thresholds and sustained accepted readings. A confirmed
   emergency owns an episode. Gemma is absent from this classification.
3. `SafetyController.handle()` calls `runCheck(ep, 'live')`, capturing generation,
   driver identity, original recording identity, and a snapshot of the validated
   saved contact. `useDriveSession` injects `phoneSensiVoiceIO` and
   `phoneSafetyAcknowledgment`. Recording is optional for monitoring.
4. `VoiceCheck.ask()` creates a new capture/question scope and exposes manual
   controls before playback. `prepareRecognition()` registers microphone-free
   work. The phone adapter acquires the safety audio lease, starts native
   preparation and speaks the fixed question using the saved installed voice.
5. Capture starts only after prompt playback completes. On iOS, `listenOffline`
   consumes preparation. English uses strictly on-device `SFSpeechRecognizer`;
   `es-US` uses iOS 26 `SpeechAnalyzer`/`SpeechTranscriber`, including equivalent
   Spanish locale resolution. Fresh PCM readiness and cue completion gate accepted
   audio; cue/preparation PCM is discarded and the six-second window starts after
   the cue. Failed cleanup downgrades the result rather than accepting partial text.
6. `recognitionEvidence`/`successfulFinal` require the current capture ID,
   successful status, final-result receipt, nonempty final transcript and matching
   transcript/final text. Typed input and buttons are explicit manual evidence,
   not fabricated speech finals. `intent.ts::understand()` uses deterministic
   rules plus fixed logistic-regression weights; urgent/negation rules override
   the classifier. Gemma is not the driver interpreter.
7. On NOT OK, optional empathy is requested only for nonurgent cases proceeding
   to a valid saved-contact offer, excluding direct requests and emergency-service
   mentions. `canGenerateAcknowledgment()` additionally requires an eligible whole
   first-person report. Omitted statements and buttons skip native inference.
8. `VoiceCheck` immediately invokes mandatory guidance playback. It does not await
   Gemma. The acknowledgment factory schedules verification/load/inference/release
   asynchronously during that utterance. This proves no logical inference wait;
   actual time-to-audible-guidance and CPU/memory contention need device testing.
9. `phoneSafetyAcknowledgment()` uses the shared verified Gemma controller, with
   a 1.5-second inference deadline and a five-second readiness budget including
   load and release. Its promise resolves only after disposal. At guidance
   completion, `get()` reads once without waiting, freezes the choice and aborts
   remaining work. Late results cannot append speech. A result that became ready
   within five seconds can remain cached until guidance ends: this is a readiness
   deadline, not a five-second maximum age for already-ready text.
10. Ready validated empathy prefixes the existing deterministic contact-offer
    utterance; no extra speech turn is inserted. Failure/unavailable/invalid/late
    output uses fixed localized empathy. Failed guidance playback cancels unused
    inference and omits empathy. Urgent/direct-request paths skip empathy. New
    contact-question scope and final evidence rules apply to the answer.
11. `VoiceCheck.authorizesContact()` checks scoped proof and cancellation. The
    controller checks ownership again after persistence, uses its captured contact,
    and requires live monitoring for live handoff. `openAuthorizedPhoneInterface`
    finally requires live provenance, a nonsimulated episode, active supported
    foreground, connection and fresh sensor data before `Linking.openURL(tel:)`.
    Opening the system confirmation is not proof of a connected call.

Relevant files: [hook](../lib/hooks/useDriveSession.ts),
[controller](../lib/analysis/safetyController.ts), [VoiceCheck](../lib/voice/voiceCheck.ts),
[phone speech adapter](../lib/voice/speechIO.ts), [recognition evidence](../lib/voice/coreRecognition.ts),
[Gemma adapter](../modules/gemma-poc/phone.ts), [acknowledgment policy](../lib/assistant/safetyAcknowledgment.ts),
[final phone boundary](../lib/voice/phoneHandoff.ts).

## Confirmed issues and their severity

| Priority | Finding | Evidence and impact |
| --- | --- | --- |
| P1 | Returning startup depends on model availability | Valid completed onboarding still awaits verify/load/release. Missing/corrupt/uninitializable model blocks the dashboard and therefore normally blocks access to deterministic monitoring. |
| P1 | Spanish capability checks the wrong engine | The production capability bridge delegates every locale to the legacy SFSpeechRecognizer probe, while actual Spanish capture/prewarming uses SpeechTranscriber. It can report either false availability or false unavailability. |
| P2 | Failed release does not make the optional provider unavailable | The controller retains a context after failed release, but the phone provider can return valid text and clears its ownership flag. A later request can reuse that retained context without a successful cleanup first. Native behavior after such a failure is unverified. |
| P2 | Readiness labels and lifecycle costs need separation | Generic voice readiness is not selected-locale Spanish readiness. Model `modelReady` records successful setup, while the native context has already been released. Startup adds a load/release cycle before event-time loading. |

The release issue is reproduced by a new mock-native characterization regression:
valid empathy is currently selected even though native release throws and
`gemmaPoc.state.loaded` remains true. It does not change consent or guidance in
that test. No real device release failure or unauthorized phone action is claimed.
The conservative follow-up is to fall back and refuse native reuse until cleanup
succeeds, without blocking deterministic safety or force-unlocking ownership.

No P0 authorization bypass was found in the inspected path. This is not a formal
safety proof or a replacement for physical audio testing. Gemma's limited use only
in a nonurgent contact-offer branch is intentional: it avoids adding a new utterance
or delaying direct/urgent handoff logic.

## Cold-start dependencies and failure behavior

`App.tsx` mounts language/theme/information providers, then `DemoStartup`, then
`SmartWheelScreen`. The optional Debug demo-admission flag requires online Auth
validation if enabled; Release bypasses this Debug gate. Making Gemma optional
would not make an enabled demo sign-in work offline.

`SmartWheelScreen` loads local profiles and invokes the process-wide
`SensiSetup.boot()` when there is no ongoing safety/recording lifecycle. The
onboarding screen is selected when booted but not ready. Its supported-screen gate
also prevents hosting new safety interactions behind setup. Existing ongoing
activity has a separate protection against interruption by setup.

`SensiSetup.boot()` validates saved notice/terms versions, artifact identity and
completion, then calls `prepare(false, true)` for a returning user. That method:

- verifies/reuses the model receipt, writes required model notices and initializes;
- requires installed and loaded state, then releases the model;
- marks `modelReady` and returning-user `ready` only after successful cleanup.

Consequences:

- Download does **not** silently start on returning boot. A missing offline model
  still leaves the app on recovery page 4. Initialization/hash/native-module/storage
  errors have the same blocking effect. A stalled native initialization cannot be
  forcibly killed by the JS deadline; cleanup can prolong the gate.
- Fresh setup requires persisted notices/terms, successful provisioning and runtime
  validation, and explicit completion. Missing weights need a network download.
  Failed download/hash/initialization cannot complete setup; cancellation and
  retries retain the existing file ownership/integrity protections.
- The ready flag is latched after successful setup. A later runtime failure does
  not reopen onboarding during that app session; the safety workflow can fall back.
  The new tests demonstrate that the controller works without the model even while
  the startup gate would prevent reaching that controller through the normal UI.
- The native model is unloaded after setup and again after each eligible event.
  There is no drive-wide retained context. Receipt reuse avoids rehashing unchanged
  files, but does not avoid native initialization.
- Sensi standby accurately says file presence is not integrity/runtime readiness.
  `modelReady` is historical successful validation, not a claim of a loaded context.
  The generic voice message can overstate selected Spanish readiness.

See [setup](../lib/onboarding/setup.ts), [shell](../components/SmartWheelScreen.tsx),
[standby feedback](../lib/assistant/sensiStandby.ts), and [demo gate](../components/DemoStartup.tsx).

## Smallest proposed startup correction — not implemented

For a returning user with a valid completed onboarding/notice/terms/artifact record,
restore dashboard admission without loading Gemma. Keep model status separate as
not checked/missing/available/error and use existing lazy event-time verification,
loading and deterministic fallback. Avoid automatic background warm-up that could
compete with safety audio or contend for the single model owner.

Preserve first-time onboarding, legal consent, explicit downloads, artifact pinning,
SHA-256 verification before inference, and current provisioning cleanup. Do not
remove the entire onboarding gate or treat file presence as verified readiness.

A crucial dependency: a simple removal of the startup await is insufficient for
Release recovery. `prepare()` currently refuses work once `ready` is true, review
onboarding disables provisioning controls, and the advanced Gemma diagnostic is
Debug-only. Add a small Release-accessible model-management/retry action reusing
existing provisioning with current terms, foreground and idle/safety-ownership
checks, without revoking dashboard admission. Its cancel/error paths must not
reset app admission. Keep model status independent of consent and download progress.

This minimal scope makes runtime Gemma availability optional for **returning**
users while preserving existing fresh-install requirements. Supporting first-ever
launch offline without model installation requires a separate approved policy
change separating onboarding completion from provisioning; it must not be silently
included in this fix.

Likely future files: `lib/onboarding/setup.ts`, onboarding/model-status presentation,
`SettingsView.tsx` for explicit maintenance, and their tests. The hook's deterministic
safety classification and handoff code need no change. Keep per-event unloading
until device memory/recovery measurements justify a different lifecycle.

## Spanish readiness mismatch and smallest correction — not implemented

`LocalFoundationModelsModule.swift::checkOfflineSpeechCapability` calls
`OfflineSpeechDiagnostic.shared.capability(locale)` unconditionally. That helper
creates an exact-locale `SFSpeechRecognizer` and reads
`supportsOnDeviceRecognition`/`isAvailable`.

Actual `es-US` preparation instead checks iOS 26, `SpeechTranscriber.isAvailable`,
equivalent Spanish locale resolution and assets for `.progressiveTranscription`,
then reserves the locale, prepares SpeechAnalyzer and releases introduced
reservations on cleanup. Capture uses `SpanishOfflineRecognition`. English remains
on SFSpeechRecognizer. The capability mismatch is not evidence that working Spanish
capture itself is broken; this probe is not the live VoiceCheck interpreter/gate.

Proposed correction: route only Spanish capability to an iOS-26-aware read-only
probe of the same SpeechTranscriber hardware, equivalent locale, preset and asset
inventory. Report resolved locale, installed/unknown asset status and permission
state explicitly, including `requires_ios_26` below iOS 26. Leave English unchanged.
Do not start analysis, reserve/install assets, request permissions or acquire audio
just to answer a capability query. Inventory alone is not proof of capture readiness;
preparation can change reservation/availability and must remain authoritative.

The dashboard's generic `prepareVoice()` additionally uses the Expo recognizer's
aggregate on-device flag, not this locale-specific bridge. Follow up by presenting
the selected language's probe status (or unknown), rather than claiming Spanish
is operational from that aggregate flag. Never disable typed/button responses or
block a safety check on an advisory readiness probe.

Likely future files: the native module's capability branch, the TypeScript status
shape if metadata is added, `speechIO.ts`/voice-readiness presentation, and tests.
Preserve existing recognition, locale routing, prewarming, cue gates and cleanup.

## Protections to keep untouched

- Deterministic sensor continuity/quality/threshold classification and existing
  deterministic learning from a genuine driver OK response; Gemma influences none.
- Final capture-scoped evidence, manual answer scopes and first-winner semantics.
- Saved contact snapshot, contact syntax checks, refusal/uncertainty handling,
  emergency-service exclusion, ownership rechecks and native phone confirmation.
- Rehearsal/demo never resolve live episodes, persist incidents, learn thresholds
  or invoke the saved-contact dialer. The separate fictional-number dialer demo
  requires a fresh explicit confirmation and is not a simulation handoff bypass.
- `AudioOwnership` safety priority over optional previews, no second safety owner,
  and retained ownership after failed cleanup. No duplex/barge-in is present.
- Microphone-free prewarming, TTS completion before capture, fresh PCM/cue gating,
  and unconditional offline recognition. Debug session alignment remains a
  separate opt-in experiment; keep it off for the production-path comparison.

## Regression coverage added in this inspection

`tests/phase2aIntegration.test.ts` uses the real phone adapter (transpiled in a test
VM), Gemma controller, verifier/receipt policy, provisioner, SafetyController,
VoiceCheck, acknowledgment policy and startup controller. Native llama completions,
filesystem, audio, network and platform services are mocked. It does not operate
on a real profile/database, microphone or phone.

The 16 cases cover English/Spanish integration and sequencing, model unavailable,
invalid/ineligible fallback, delayed release, failed guidance playback,
cancellation/late output, the failed-release characterization, returning startup
with installed versus missing/offline weights, native/overall deadlines, both
manual channels in both languages, scoped consent and simulation/platform isolation.

Existing suites additionally cover intent/flag engines, live ownership/handoff,
stale and partial recognition, audio leases, native prewarm/cue/endpoint harnesses,
localization, model integrity, provisioning failures and onboarding errors. Tests
are not a physical measurement of speech accuracy, timing or audio ownership.

## Physical-iPhone verification procedure

1. Use the existing Debug app on a parked device with a configured test driver and
   valid saved test contact. Leave Debug aligned-session experimentation off.
   Confirm the approved installed model; do not change thresholds or bypass setup.
2. Use Settings → Health & Safety → Try the voice check, or Safety Testing →
   Demo — trigger a warning. Both run the real VoiceCheck policy in simulation.
   Confirm no recording/incident/threshold changes and no saved-contact phone UI.
3. In English, answer after the cue with `I'm dizzy`; in Spanish, use
   `Me siento mareada`. Mandatory pull-over guidance must start before empathy.
   Observe the Debug acknowledgment source; the first offer should include the
   correct contextual acknowledgment only if ready, otherwise fixed empathy.
4. Repeat with typed responses and buttons. A NOT OK button should use fixed
   empathy without inference. Decline and accept the simulated contact offer in
   separate trials; both must stay simulated, with no phone handoff.
5. Exercise an ineligible phrase, OK, silence, direct contact request and urgent
   emergency-service mention. Check correct fixed guidance and no unnecessary
   Gemma inference. Do not make actual emergency calls for verification.
6. Cancel during guidance and during the offer; background separately. Ensure no
   late speech/handoff and a subsequent check recovers. Check speaker and intended
   Bluetooth routes, unavailable selected voice, cue/listening phases and final
   short English/Spanish responses. Recognition starts after TTS/cue, not over it.
7. Existing Debug timing capture can measure audio/prewarm milestones. Compare
   audible guidance start and Gemma availability/source; the Phase 1D GGUF-only
   acceptance run did not exercise this real speech workflow or its five-second
   availability window.
8. Test cold launch offline with verified installed weights. Missing/corrupt-model
   startup should be exercised on a disposable test installation/container, not by
   deleting the primary verified model. Current expected behavior is blocked setup
   with recovery, not the proposed optional-startup behavior. Record launch-to-main
   UI time separately from native model load/inference/release durations.

No new physical-device results are asserted by Phase 2A. The prior Phase 1D artifact
verified isolated GGUF English/Spanish outputs; it does not establish VoiceCheck,
startup, microphone or Spanish-readiness end-to-end success. Live saved-contact
handoff remains covered by automated guards; any physical live-path confirmation
requires a separately controlled consented test rather than weakening simulation.

## Files added and checks

- `tests/phase2aIntegration.test.ts`
- `docs/phase2a-voicecheck-startup-audit.md`

- Targeted new regressions: 16 passed.
- TypeScript (`tsc --noEmit --incremental false`): passed.
- Full automated suite: 617 passed, 0 failed, 0 skipped.
- `git diff --check`: passed.

The new tests intentionally characterize current startup blocking and failed-release
behavior. They must be updated alongside approved corrective production changes;
their passing status does not mean those findings have been fixed.

# Phase 2E — Native English finalization metadata

Diagnostic extension only. No recognition fix or physical-device result is claimed.

## Fields and interpretation

The existing `recognition / native recognition completed` Debug event now includes `endpointReason` and a capture-matched `englishFinalization` object. The native bridge field is named `englishFinalizationDebug`; it is compiled only in Debug and optional for older binaries. The JS adapter forwards it only in Debug and only when its native capture ID matches the requested capture. It does not participate in recognition acceptance or consent.

The payload contains:

- `captureId`: the existing request/capture ID, never a driver/profile ID.
- `rawAppleIsFinal`: the callback result's raw Apple flag, or null for a callback without a result. Existing accepted `isFinal` and `finalResultReceived` fields retain their original meaning.
- `applicationFinalizationStarted`: whether the application entered endpoint finalization.
- `completionOrigin`: `apple_final_before_application_endpoint`, `final_after_application_endpoint`, or `terminal_without_final`. Ordering uses the callback's arrival time and application finalization time; arrival before application endpointing is distinguishable even if MainActor handling was queued. “After” expresses observed order, not proof that the application caused an empty final.
- `callbackError`: public NSError domain/code only; no description, userInfo, result text, or audio.
- `taskSnapshots`: at fixed points `callback`, `beforeFinish`, `afterFinish`, `beforeCleanupCancel`, and `afterCleanupCancel`. Each stores public raw task state, `isCancelled`, `isFinishing`, and task error domain/code if present. Repeated callback snapshots overwrite the same slot, so storage is bounded. Values reflect observation time on MainActor, not necessarily the task state at callback arrival.
- `endpointAtSelection` and `endpointAtCompletion`: fixed-size numeric/calibration metrics—noise floor, calibration classification/window, threshold range, above-threshold fraction, buffered duration, buffer age, level/threshold, measured activity duration, and silence duration. The selection snapshot is captured for both timer-driven and polling-driven endpointing; older selection measurements could be empty when the timer fired first.
- `endpointSelectionChecks`: calibration readiness, recognized speech, minimum measured activity, fresh PCM, silence interval satisfied, and deadline expired. These observe the existing thresholds without changing them.
- `endpointReady`, `hadPartial`, `deadlineRemainingMs`: completion-time observations. Selection checks should be used to evaluate the endpoint decision; completion measurements also include elapsed cleanup time.

The existing native timing dictionary gains first-occurrence monotonic offsets:

- `captureDeadlineReached` when application finalization selects capture_budget.
- `inputStopRequested`, `inputStopped` around the existing input-feed stop/lock.
- `engineTapStopRequested`, `engineTapStopped` around existing engine stop/tap removal.
- `endAudioRequested`, `endAudioReturned` around the existing request endAudio.
- `taskFinishRequested`, `taskFinishReturned` around the existing once-only task finish.
- `appleFinalCallbackReceived` at native callback entry, and `appleFinalCallbackHandled` after the existing capture-identity guard on MainActor.
- `cleanupCancelRequested`, `cleanupCancelReturned` around existing terminal cleanup cancellation.

Existing `finalizationStarted`, `finalResultReceived`, `listeningGateOpened` and cleanup milestones remain. All offsets within a native capture share the existing native timing origin. Compare those offsets with each other; do not subtract them from JS operation-local elapsed times. First-occurrence recording means a second idempotent cleanup call does not replace the original stop/end milestone.

Task cancellation **after cleanup** is expected and is not evidence that cancellation caused the earlier empty final. Likewise, application accepted isFinal=false with rawAppleIsFinal=true means an unusable final was delivered, not that Apple failed to mark it final. Task states are Apple's raw enum values, not app outcome codes.

## Safety and ownership

No new tasks, timers, waits, audio requests, retries, appends, or callbacks were introduced. Existing recognition call order, capture guards, deadlines, input locking, final validation, partial retention, cleanup, and serialized ownership are unchanged. Instrumentation adds synchronous Debug observation overhead; it does not intentionally delay capture or schedule operations differently. Native snapshots are capture-lifetime RAM metadata; JS storage uses the existing opt-in, bounded and deduplicated recorder. No transcript content, raw samples, contact/profile data, arbitrary error messages, disk logging, or upload is added.

English production decisions and Spanish SpeechTranscriber, prewarming, TTS, session setup, Gemma, guidance, consent and dialer authorization are unchanged. Early preparation failures that never create an English capture do not have this payload; their existing status/reason remains authoritative.

## Exact files changed

- `modules/local-foundation-models/ios/OfflineSpeechDiagnostic.swift`: Debug-gated capture metadata and milestones; existing return dictionary assembled before resuming so Debug metadata can be attached. Release outcomes and native operation order remain unchanged.
- `modules/local-foundation-models/index.ts`: optional typed Debug payload.
- `lib/voice/responsivenessDiagnostics.ts`: typed payload field; deduplication/buffer behavior unchanged.
- `lib/voice/speechIO.ts`: Debug-only endpoint/payload forwarding with capture-ID matching; no acceptance change.
- `tests/englishFinalizationDiagnostics.test.ts` (new): native Release exclusion, unchanged sequencing/deadline, extracted actual snapshot-helper execution, bounded snapshots and error privacy.
- `tests/safetyVoice.test.ts`: explicit development flag in the harness and Debug/capture-mismatch/Release payload regressions.
- `docs/phase2c-core-1-2.md`: extraction allowlist extended to retain `englishFinalization`.
- This report.

Existing uncommitted work was preserved. No dependencies installed, configuration changed, commits created, or pushes performed.

## Validation

- Relevant native transcript/finalization, adapter and recorder regressions: **45 passed, 0 failed**.
- Full automated suite: **662 passed, 0 failed, 0 skipped**.
- TypeScript (`tsc --noEmit`): passed.
- `git diff --check`: passed.
- **Full Debug iOS app build passed**, using workspace SmartWheel.xcworkspace, scheme SmartWheel, generic iOS device, signing disabled, and an isolated temporary DerivedData directory. The native object is newer than the final edited Swift source. No install, signing, IPA distribution, or microphone test was performed.
- Release iPhoneOS implementation object compilation passed for the actual speech implementation and dependencies. Inspection found the new payload/milestone markers present in the Debug native object and absent from the Release object. This Release check is scoped native compilation, not a complete Release app archive.
- Production Release iOS/Hermes Expo export passed; the new native Debug payload access is absent from its JavaScript bundle. Runtime tests also prove Release forwarding is disabled even when a mock bridge supplies the payload.
- Host Swift tests execute actual extracted helper/transcript code with mocked task/platform state. They do not establish Apple recognition accuracy or device timing.

## Physical-iPhone comparison

1. Rebuild/install the **updated native Debug app**. A Metro JavaScript reload alone cannot add the native fields. Retain the existing route/connectivity and keep aligned-session experiments OFF. Test parked, outside recording/monitoring, using synthetic statements only.
2. Advanced Settings → start/clear timing capture → Health & Safety → Try the voice check. Capture a single rehearsal, then refresh and copy the timing JSON before stopping/resetting/restarting. Use the revised capture filter in `phase2c-core-1-2.md` with the actual new core capture ID. Stop capture after saving.
3. Compare shorter successful and approximately six-second failed captures under the same conditions. For each, collect endpointReason, endpoint selection checks/metrics, final-presence flags, rawAppleIsFinal, completionOrigin, task/error snapshots, the native timing dictionary, adapter acceptance, VoiceCheck channel and same-ID UI commit.
4. For deadline failures, confirm capture_budget/deadlineExpired and inspect why silence checks were false. Compare callback arrival/handling against input stop, endAudio and finish milestones. For shorter successes, distinguish audio_silence/application endpointing from an Apple final arriving before application endpointing. An empty selection object can be expected for an Apple final with no application endpoint decision.
5. Verify empty finals still produce incomplete/unusable evidence and manual fallback; no partial decision or consent is allowed. Verify cancellation and a subsequent capture do not mix IDs, typed/buttons still work, and rehearsal consent never opens a live phone interface.

Only after these traces identify a specific failing boundary should any recognition change be proposed. Timing association alone is not a root-cause diagnosis.

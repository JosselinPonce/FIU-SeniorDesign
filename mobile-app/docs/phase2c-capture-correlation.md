# Phase 2C — End-to-end capture correlation

## Finding

Repeated Listening → Voice unavailable is a real end-to-end failure, but the five aggregate native results do not identify which capture produced that UI. Existing timing data stopped before adapter filtering, VoiceCheck acceptance, and React commits. This change closes that diagnostic gap; it does not change recognition, timing, audio policy, interpretation, fallback, or authorization.

Confirmed by code: native `incomplete/empty_final_after_partial` maps to the unavailable UI while preserving manual input. It originates from an Apple final callback with no usable alphanumeric final text after a usable partial. Grace expiry instead yields `finalization_incomplete`. Native `cancelled` does not directly request unavailable. Successful capture with valid final evidence goes to deterministic interpretation; ambiguous words trigger retry rather than unavailable. A later retry/contact capture can fail independently. Sequential fallback is expected with alignment disabled. Bluetooth, permissions, endpoint timing, and stale state are not established causes of the reported repeated failure.

## Trace implementation

The existing opt-in Debug `responsivenessProbe` recorder is reused. No new recorder, persistence, network upload, native bridge, permissions, or diagnostic audio operation was introduced. Release probes remain no-ops. The existing 80-record/24-event bounds, clear-on-stop, capture epochs, and first-event-only behavior remain.

Every new observation contains capture ID and fixed metadata, not driver text:

1. `recognition / native recognition completed`: native status/reason, transcript/final-text presence, final flags, locale/on-device contract booleans, existing native timings.
2. `recognition / adapter outcome`: post-adapter status, current cancellation epoch, final-evidence usability and trimmed transcript equality. Exceptions record only a fixed reason and stage (`preparation_identity`, `preparation_acknowledgment`, `progress_subscription`, `native_capture`, or `result_mapping`), never exception text. Ownership rejection and missing native results have separate observations.
3. `VoiceCheck controller capture`: registration and settlement, episode/profile-current predicate, question/capture match, and recognition-epoch cancellation. This observes the existing guards without changing them.
4. `VoiceCheck decision`: question opened, received status/usability, settled/cancelled/capture-match flags, unavailable request, winning response channel, and question closure. Late result observations retain their original capture ID.
5. `VoiceCheck interpretation`: deterministic wellness intent enum and text-presence boolean only. No new classification is performed.
6. `VoiceCheck UI publication`: controller check phase, question, fallback-copy presence; clearing retains the previous capture ID and reports `cleared`.
7. `VoiceCheck UI commit`: post-React-commit phase and source (`conversation` or `drive`), capture/question and fallback-copy presence. `drive` is the shell-mounted `VoiceCheckModal` in DriveView.tsx, so it also observes a CORE rehearsal on the Settings tab; it is suppressed when the conversation view owns presentation. Conversation observations require a matching episode. This observes React state committed by the view; a matching screenshot establishes what was visible on the physical screen. It is not a native pixel-visibility guarantee. A cleared check is recorded at controller publication; component commit observations require an active check object.

UI phase `response_unavailable` with no fallback-copy override corresponds to the reported message. `speaking` with fallback copy is the separate playback failure path. A listening/finalizing progress callback does not count as an accepted answer. Native return is observed after bridge cleanup; bridge cleanup failure can override raw capture success before the adapter sees it.

## Files in this change

- `lib/voice/responsivenessDiagnostics.ts`: metadata fields and shared post-commit helper.
- `lib/voice/speechIO.ts`: native-result and adapter/ownership stage observations.
- `lib/voice/voiceCheck.ts`: capture-scoped decision and wellness interpretation observations.
- `lib/analysis/safetyController.ts`: current-generation settlement and UI publication observations.
- `components/SensiSafetyConversation.tsx`, `components/DriveView.tsx`: post-commit observations; no rendering/recognition decisions changed.
- `tests/safetyVoice.test.ts`: status/metadata matrix, privacy checks, existing Spanish metadata expectation updated.
- `tests/voiceCheck.test.ts`: incomplete-to-manual-winner correlation and transcript exclusion.
- `tests/responsivenessDiagnostics.test.ts`: UI capture correlation, opt-in and Release no-op/privacy regression.
- `tests/safetyConversationUI.test.ts`: diagnostic helper mock for existing view harness.
- This report.

All other pre-existing uncommitted changes were preserved. No native file, model, speech capture configuration, safety threshold, consent rule, emergency authorization, or dialer behavior was changed.

## Physical-device procedure

1. Run the updated JavaScript in a physical-iPhone Debug development build with the existing matching native module. These changes require no new native speech method. Record app/JS revision, iOS version, current route, and connectivity. Preserve the failing route for the baseline; do not reset permissions or assume Bluetooth is responsible. Stop recording/monitoring and other diagnostic audio activities. Select English.
2. Settings → Advanced Settings → Developer responsiveness comparison. Keep aligned-session mode OFF: the action should say **Enable Debug aligned VoiceCheck session**. Press **Start timing capture**, or **Clear timing snapshot** if already enabled. Do not enable any session experiment or run a separate fixture concurrently.
3. Settings → Health & Safety → **Try the voice check**. Let playback complete, then say a synthetic “yes, I am okay” after Listening/readiness. Capture a screenshot when unavailable appears and note which prompt was active. Do not use personal symptoms or names. Use the existing manual/cancel controls to end the simulated rehearsal safely; never switch to live call testing.
4. Immediately return to Advanced Settings → **Refresh timing snapshot**. Copy the selectable JSON before stopping/clearing/restarting; stopping clears it. Capture one failing rehearsal at a time so bounded history does not evict it. Then stop capture to clear RAM.
5. Join records by the exact `core-…` capture ID, preserving wellness vs contact-offer question and order of opened/closed questions. Include native status/reason, presence/final flags, adapter result, current/match flags, unavailable request, state publication, and UI commit. Share this metadata and screenshot without driver profile or transcript data.

## How the trace resolves the failure

| Evidence chain | Conclusion supported |
| --- | --- |
| Native incomplete/empty-final → adapter incomplete → unavailable requested → same-ID unavailable commit | The incomplete final caused this UI; not a post-native-success mapping failure. Investigate final callback versus endpoint ordering separately. |
| Native success → locale/on-device contract false → adapter error → same-ID unavailable | Concrete native/adapter contract mismatch; inspect the actual installed bridge/revision before fixing. |
| Native success → unusable final metadata/equality → no unavailable request | Final evidence was rejected. Look for the next question's result or another error to explain unavailable; rejection alone does not select that phase. |
| Acquisition rejected or adapter fixed error/stage → unavailable | Identifies the boundary where recognition failed without exposing arbitrary error text. Existing debugger/native reasons can then narrow it. |
| Epoch/current/capture mismatch; original question already closed | Late/stale capture. Verify whether it was suppressed or actually published into a different question before proposing an ownership fix. |
| Earlier success ID followed by later incomplete/error ID and unavailable commit | Later question failure; earlier recognition success remains genuine. |
| Same-ID valid usable success and accepted answer, yet same-ID unavailable commit | Unexpected path requiring controller/publication ordering investigation; no claim of this bug is made before capture. |

A fix is confirmed only after the trace identifies the failing boundary, a regression reproduces that boundary, and repeated physical rehearsals show the intended final-evidence/interpretation/UI chain on the formerly failing setup. Also verify typed/buttons, cancellation, retry/contact question separation, and rehearsal call isolation. Automated mocks do not establish physical recognition success. Do not promote partials, relax consent evidence, extend timers, or change routes merely to make a test pass.

## Validation

- Full automated suite: **639 passed, 0 failed** (eight new diagnostic regressions over the 631-test baseline).
- TypeScript: `tsc --noEmit` passed.
- `git diff --check` passed.
- New coverage checks success, missing final metadata, wrong locale, incomplete empty-final, cancellation, bridge rejection, capture IDs, fixed error stages, transcript exclusion, manual fallback correlation, and UI-probe opt-in/Release no-op behavior. Existing Spanish, ownership, late inference, consent and rehearsal isolation coverage remains in the full suite.
- No new physical-device result is claimed. No native code changed; no full native build or IPA validation was performed for this diagnostic-only change. No dependency installation, commit, or push.

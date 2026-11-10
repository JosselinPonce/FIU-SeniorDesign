# VoiceCheck responsiveness Phase 1

The recording-compatible session is an explicit Debug-only, RAM-only opt-in in
Settings → Advanced Settings → Developer responsiveness comparison. It defaults
off at launch. Release contains neither the native setup bridge nor session owner;
its prompt keeps the existing playback/voicePrompt configuration.

When enabled, the existing safety lease establishes playAndRecord/default before
Expo TTS. No engine, input tap or recognition task starts during TTS. Exact saved
voices, text, rate 0.95, volume 1.0 and Expo completion callbacks are unchanged.
Only the built-in iPhone route and previously granted microphone permission are
eligible. Unsupported routes/permissions, unavailable bridges and recoverable
setup failures use the sequential session path. Native capture skips redundant
session setup only if its capture ID, route and configuration still match and no
route change, interruption or background event has invalidated reuse. A failed
restoration is an error, not permission to continue; audio ownership stays guarded
by the existing cleanup path. The pre-prompt category/mode/options are restored on
capture completion or cancellation. iOS has no public general active-state getter;
the existing app lifecycle still deactivates the safety session when releasing it.

Nonblocking calibration applies to Debug and Release, with either session path.
First fresh microphone PCM establishes readiness. Preparation and cue PCM are
neither retained nor submitted to recognition. The unchanged chime and 40 ms tail
complete before the native gate opens and the six-second deadline begins. The
existing 600 ms endpoint calibration now measures accepted listening audio.
Recognition evidence does not prematurely complete that 600 ms window. Stable
loud audio is ambiguous; it cannot raise the activity threshold or be installed as
a noise-floor estimate. Variable audio likewise keeps the conservative -48 dB
threshold. Recognized early speech invalidates the initial estimate, including
late Apple evidence. Quiet apparently stable samples may be measured, but never
raise the operational threshold. Endpointing remains gated on calibration, actual
recognized speech, minimum measured activity and fresh audio. In loud noise or
very quiet speech this may use the full six-second budget. Final Apple results
remain mandatory; partial or empty finals are never upgraded to successful evidence.

No pre-cue audio buffer, speech interruption detector, extra microphone engine,
asset downloads, new recognition routing or emergency-consent changes are included.
A response beginning before first PCM or overlapping the cue can still be lost.

## Device procedure

1. Rebuild ios/SmartWheel.xcworkspace, scheme SmartWheel, Debug, on the physical
   iPhone. Start Metro with `npx expo start --dev-client` if needed. No prebuild,
   reinstall, dependency update or model redownload is required.
2. Park, disconnect external routes, use the built-in speaker/microphone, and
   select the existing English premium voice. Enable timing capture. Leave Debug
   aligned session off initially.
3. Run Safety Testing → Demo — Trigger a Warning twice. After the cue, answer
   “Yes, I'm okay” and then a short “No.” Save each refreshed timing snapshot
   before clearing/stopping timing capture (stopping clears timings).
4. Enable Debug aligned VoiceCheck session and repeat. Confirm the exact selected
   voice, rate, loudness, speaker route, completion semantics and cue are intact.
   If any playback is silent/changed or setup fails, disable the opt-in and retest
   the sequential path; never substitute another voice to pass the test.
5. Repeat with Spanish, using “Sí, estoy bien” and “No.” Verify both with Airplane
   Mode and Wi-Fi off. Compare first and repeated captures.
6. Exercise immediate post-TTS answers, answers immediately after the cue, silence,
   quiet speech and steady background noise. Record whether final words are complete;
   no words can be recovered before first PCM or guaranteed during cue exclusion.
   Incomplete results must preserve typed/button controls and never authorize a call.
7. Cancel during TTS, cue, listening and finalization; background the app and change
   route in separate trials. Confirm capture stops and subsequent English/Spanish
   checks recover. Start on an external route to verify sequential fallback; do not
   expect the aligned experiment to support Bluetooth.
8. No call should be initiated for testing. Use existing simulation isolation and
   verify real contact consent only through the existing guarded test coverage.

## Timing interpretation

Within nativeTimingMs, compare sessionCategoryStarted/Completed,
sessionActivationStarted/Completed, recognitionPreparationStarted/Completed,
microphoneSetupStarted/Completed, enginePreparationStarted/Completed,
engineHardwareStartRequested/engineStartReturned and firstPCMReceived.
Spanish additionally separates microphoneTapSetupStarted/Completed.
alignedSessionReused means capture skipped category/activation; absent category
intervals are skipped work, not a zero-duration measurement.

The pre-prompt session setup has its own timing origin: the capture-preparation
record's “preprompt session setup returned” includes sessionAlignment.timingMs.
Do not subtract that map from nativeTimingMs or JS timestamps. JS record absolute
offsets are startedMs + event.elapsedMs within the same JS recorder epoch.

nativeMicrophoneReady, cueStarted, cuePlayerPreparationStarted/Returned,
cuePlayerPlayReturned, cuePlaybackCompletionObserved, cueAcousticTailCompleted,
cueCompleted and listeningGateOpened separate first-PCM readiness from audible
cue completion and actual acceptance. calibrationCompleted should now follow
listeningGateOpened by approximately 600 ms of PCM plus polling. If a final result
ends capture before calibration completes, that milestone is absent, not zero.

Suggested device goals: materially reduce the previous ~500 ms post-TTS session
cost, remove the 600 ms calibration wait from readiness, keep the full six-second
no-response budget, and preserve finalized short-response accuracy. Aim for median
TTS-to-gate below 500 ms on the built-in route, but report measured outliers rather
than claiming an API latency guarantee. Session alignment must remain Debug-only
until physical-device compatibility and cleanup checks pass.

## Alignment reuse diagnostics v2

This correction changes only the opt-in Debug alignment owner and its diagnostics.
`sessionAlignment.diagnosticRevision` is `aligned-session-reuse-v2`. It does not
start the microphone earlier, buffer PCM, or change calibration/cue/deadline logic.

`aligned: true` remains the historical setup result. Always inspect
`reuseDecision` (`reused` or `sequential_fallback`), `failedReusePredicates`, and
`reusePredicates` for the capture-time decision. `requestedCaptureId`,
`captureOwner`, and `ownerGeneration` identify ownership. Predicates separately
check ownership, validity, cancellation, app activity, built-in route, input
presence/availability, microphone permission, category, mode and exact options.

`firstInvalidatingEvent` is null if no invalidating event was observed. A predicate
can still reject reuse without a notification. Events include source, capture
owner/generation, elapsed milliseconds, raw route reason, disposition, whether
invalidation occurred, and session snapshots at delivery and handling. Their phase
says whether they preceded the reuse decision; an event after reuse does not
explain an earlier rejection. `sessionAtReuse` records the actual decision state.
Snapshot booleans and raw category/mode/options/port names contain no audio,
transcripts, contacts or route identifiers. iOS has no public active-session getter;
reuse requires the successful activation plus an unbroken valid alignment lifetime.

Route reasons 3 (category change) and 8 (route configuration change) may continue
only if both snapshots remain compatible and the owner is active and not cancelled.
Input loss, external routes, incompatible session state, other/unknown route
reasons, interruptions and backgrounding invalidate alignment. Invalidations are
sticky. Neither a recovered route nor an interruption-ended event resurrects it.
Callbacks carry both capture ID and generation; stale callbacks are discarded.
The existing separate microphone-free prewarming interruption policy is unchanged;
preparation can fail before a reuse decision, in which case check its native reason
and any attached alignment event instead of assuming reuse was evaluated.

`restoration` reports restored/failed and the final session snapshot. Capture
metadata survives cleanup in a bounded eight-entry RAM history; notification events
are capped at 32 with the first invalidation retained separately. Cancellation is
recorded as `alignment.cancelled` when the alignment owner is still present.
Restoration failure still retains ownership and reports an error.

### Aligned versus sequential device comparison

1. Rebuild the existing SmartWheel Debug scheme on the physical iPhone. Use the
   same saved premium voice, hardware volume, built-in speaker and microphone;
   park and disconnect AirPods/Bluetooth. No project regeneration is needed.
2. In Advanced Settings enable timing capture and leave Debug aligned session off.
   Run a warning simulation, wait for the cue, and say a fixed full phrase. Refresh
   and save the JSON snapshot before clearing. Repeat once, then do Spanish trials.
3. Enable Debug aligned VoiceCheck session. Clear only the timing snapshot. Repeat
   English twice and Spanish twice under the same conditions. Check revision v2.
4. Successful reuse has `reuseDecision=reused`, empty failed predicates, and native
   milestone `alignedSessionReused`. Category/activation intervals at capture are
   absent because they were skipped. Benign events have `invalidated=false` and
   disposition `compatible_configuration_change`; their raw reason is 3 or 8.
5. A fallback has `reuseDecision=sequential_fallback` and explicit failed predicates.
   Inspect the first invalidating event, its phase and both snapshots. With alignment
   disabled, owner/validity failures and sequential setup are expected. A preparation
   failure before this point can have no reuse decision; report its reason as well.
6. Compare first-PCM and gate timing against each trial's TTS-completed JS callback.
   Use JS startedMs+elapsedMs within the same epoch and native intervals only within
   their own timing map. Do not subtract native and JS clock values directly.
7. Test route changes/backgrounding/cancellation separately: expect cancellation or
   sequential fallback, never unconditional reuse. Starting with AirPods connected
   must retain sequential fallback. Confirm microphone cleanup and a subsequent
   built-in English/Spanish check still works. Do not make a real phone call.
8. Finally test immediate post-TTS phrases, including negation, while noting this
   change cannot recover speech before first PCM or during cue exclusion. Compare
   complete finalized words (for example “Sí, estoy bien”, “No, no estoy bien”,
   “Yes, I'm okay”, “No, I'm not okay”), not only native success status.

Save each snapshot before stopping timing capture, which clears it. Disable the
opt-in if exact voice, loudness or routing changes. Release remains sequential.

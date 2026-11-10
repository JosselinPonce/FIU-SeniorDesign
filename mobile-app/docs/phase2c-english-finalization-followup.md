# Phase 2C follow-up — English finalization

## Evidence and conclusion

User-supplied physical diagnostics: five English captures, three `success/complete`, one `cancelled/cancelled`, one `incomplete/empty_final_after_partial`; all received PCM and partial recognition, microphone permission was granted, playback succeeded. Output changed from Bluetooth A2DP before capture to HFP during capture. Alignment was disabled. These observations demonstrate that English capture works on this device and that the incomplete capture reached recognition; they do not establish a general permission, microphone-acquisition, or offline-support failure. They do not identify which question/capture produced the observed UI without capture correlation.

No new device run was performed. No production bug warranting a recognition/timing/route change was established. This document is the only file added for this follow-up.

## Native result provenance

In `modules/local-foundation-models/ios/OfflineSpeechDiagnostic.swift`, the SFSpeechRecognizer callback first checks identity (`capture === current`), then feeds `bestTranscription.formattedString` and `isFinal` into `OfflineRecognitionTranscripts`. A partial is retained only when it contains an alphanumeric character. A final is trimmed and stored separately; an empty final never replaces the partial with fabricated final evidence. `hasFinalTranscript` requires both a real final callback and an alphanumeric final string.

If a callback carries an error, the result is `recognition_failed` even if it also carries text. Otherwise a final callback immediately finishes capture:

- Usable final → `success/complete` if cleanup succeeds.
- No usable final but a previous usable partial → `incomplete/empty_final_after_partial`.
- No usable partial/final → `error/no_speech`.

“Empty” here includes whitespace-only or punctuation-only final text, not just a zero-length string. No transcript from the device was inspected, so these cannot be distinguished for this occurrence. The partial remains available for presentation but cannot authorize consent or become a final driver answer.

At silence endpoint (1.3 seconds with existing calibration/activity/fresh-buffer guards) or capture budget, `beginFinalizing` stops feeding input, stops capture, calls request `endAudio`, and invokes task `finish()` once. The recognition task remains alive for Apple's final callback. A 2.5-second grace timer yields **`finalization_incomplete`**, not `empty_final_after_partial`, if no final arrives. Cleanup invalidates capture identity before task cancellation; callbacks from that cancelled/completed capture cannot change the result or a replacement capture.

Consequently the observed reason confirms a real unusable final callback, rather than merely expiration of the grace timer. It does not show whether that callback arrived before or after application-driven endpointing. Ordinary partial-to-final revision by the recognition service is compatible with this evidence; this is not proof of a normal/expected frequency or proof that the app caused the revision. An early endpoint cutting off speech, input degradation, or route effects remain hypotheses. Increasing the final grace period would not help a final callback that already arrived empty and was accepted as terminal. Promoting the partial would weaken final-evidence/consent protections and is not an appropriate fix.

## Route interpretation

`sequential_fallback` with aligned reuse disabled is expected, not a recognition failure. The sequential capture configures the existing `.playAndRecord` session with Bluetooth support; A2DP before capture and HFP during capture is compatible with switching to a Bluetooth microphone-capable route. This comparison alone does not prove an unexpected interruption, engine failure, or lost speech. PCM and partials establish that audio reached recognition, but do not prove the whole utterance remained intelligible or untruncated.

The capture observes audio interruptions and engine configuration changes; applicable failures report `audio_interrupted` or `audio_route_changed`. There is a phase-dependent guard: not every configuration notification before active capture produces a failure. The preparation owner separately invalidates non-category route changes before handoff. Thus absence of a route-error code does not rule out all route influence. The observed incomplete reason is not itself a route-error diagnosis.

## JavaScript and UI mapping

`lib/voice/speechIO.ts` logs the bridge-returned status/reason, then checks exact locale (`en-US`) and `requiresOnDeviceRecognition === true`, and wraps the result with a cancellation epoch. `coreRecognition.successfulFinal` requires the current capture ID, success status, no cancellation, real final flags, nonempty trimmed final text, and equality of trimmed display/final transcripts.

`VoiceCheck.ask` maps results as follows:

| Result | Behavior |
| --- | --- |
| Current valid `success` | Use the genuine final. Deterministic interpretation either recognizes a wellness answer or retries; ambiguous words do not directly produce “Voice unavailable.” |
| `incomplete` or `error` | Publish `response_unavailable`; retain the manual answer window. Partial speech is not accepted as final evidence. |
| `cancelled`, `timeout`, or stale evidence | Not usable final evidence; these do not directly call `responseUnavailable`. Explicit check cancellation exits; a native-only cancelled result can otherwise proceed to retry/no-response handling. |
| Listen rejection while still current | Publish `response_unavailable` and preserve manual input. |

The native return's `success/complete` is logged before JS contract filtering. A malformed/mismatched locale or missing on-device flag can therefore turn a logged native success into JS `error` and show unavailable. Inspection of the current English native success report shows both required fields correctly populated. This is a possible diagnostic distinction, not an established defect in this run.

Missing final flags, unequal transcript fields, or a stale epoch make a nominal success unusable, but **do not directly display unavailable**. Native success uses the same stored final for display/final transcript, making a filtering mismatch unlikely on the inspected path. Ownership acquisition can throw before a native capture starts; it cannot retroactively turn that same completed capture into an ownership error. A later question can independently fail, so three successful captures do not establish that every displayed question succeeded.

The safety-controller wrapper filters progress by pending state, recognition epoch, current episode/profile, capture ID, voice instance, and awaiting-response state. `VoiceCheck.ask` also checks settled/cancelled/current capture before processing the result. `responseUnavailable` uses the current question's state. No code path was found in which ordinary successful final text or semantic interpretation alone sets that phase. A UI race is not established from aggregate results; capture-by-capture event correlation is required before proposing a state-ownership fix.

The native bridge can override raw capture success on prepared-resource or session cleanup failure, but this occurs **before** the JS `native recognition completed` event. The logged status would then be `error/audio_cleanup_failed`, not `success/complete`.

## Smallest next evidence collection

Reuse the existing Debug timing recorder, with alignment OFF and no duplex changes. Preserve the failing route for the first reproduction, use only synthetic answers, and record which wellness/contact/retry prompt was active. Collect complete related records, not just the five aggregate statuses.

For the incomplete capture, inspect `finalResultReceived`, `finalizationStarted`, `captureCleanupCompleted`, `listeningGateOpened`, and capture-activation timestamps in `nativeTimingMs`. If `finalizationStarted` is absent, application endpoint finalization did not precede that final callback. If present, compare its time to `finalResultReceived`; a final arriving after endpointing establishes order, not causation. The existing recorder does not retain the full endpoint selection measurements or detailed sequential route-notification chronology, so do not infer them from output route alone.

If needed, inspect existing native report fields (`endpointReason`, endpoint diagnostics/selection measurements, final flags) at a debugger breakpoint without dumping transcript/audio/profile objects. Breakpoint pauses perturb timeouts and cannot serve as latency evidence. Only after capturing the baseline should a controlled built-in-speaker run be compared with the same synthetic utterance and Bluetooth route. A changed success rate would motivate investigation, not prove a route-policy fix.

If a successful capture is suspected of showing unavailable, correlate its capture ID and prompt with the UI, verify the adapter contract flags, and check for a subsequent incomplete/error capture. The current snapshot omits some post-adapter evidence flags; a narrowly scoped Debug-only metadata probe would be the next step only if correlation remains insufficient. No speculative production change or timing adjustment is recommended now.

Existing regression tests exercise actual extracted Swift transcript/finalization state with mocked recognition tasks, including partial followed by empty final, once-only graceful finish, and stale capture rejection. JavaScript tests cover final-evidence rejection, incomplete/error manual fallback, cancellation, and stale progress. These protect the current safety contract; they cannot reproduce Apple recognition output or Bluetooth hardware behavior.

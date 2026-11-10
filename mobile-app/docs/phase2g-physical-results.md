# Phase 2G — Physical-iPhone observations

Source: user-reported physical-device diagnostics in this session. These results were not independently reproduced by the coding agent. Full raw exports, latest capture IDs and per-field distributions were not supplied with the latest summary. Run labels below distinguish separate testing sessions; capture IDs can repeat across app launches.

## Recorded results

| Run | Reported observations | Evidence limit |
| --- | --- | --- |
| Test A silence baseline | Approximately -50.1 dB during intentional silence | No capture count, endpoint outcome or full distribution supplied here; do not infer them |
| Earlier Test B, core-2-1 | Wellness success; audio_silence after approximately 2.8 seconds of PCM; 1305 ms silence; 1000 ms activity; valid Apple final; later-window above-threshold fraction 0% | Historical successful comparison within the earlier failing run |
| Earlier Test B, core-2-2 | Contact offer incomplete/empty_final_after_partial; capture_budget after approximately 6 seconds; 1219 ms silence; 2600 ms activity; later-window activity approximately 40% | Silence interval was short of 1300 ms; this alone does not explain the empty final |
| Earlier Test B, core-2-3 | Contact-offer retry incomplete/empty_final_after_partial; audio_silence after approximately 5.9 seconds; 1302 ms silence; 2400 ms activity; later-window activity approximately 36% | Empty final occurred despite qualifying silence endpointing |
| Latest Phase 2G Test B | Three successful English VoiceCheck captures, all audio_silence endpoints with valid nonempty Apple finals; finalization approximately 139–171 ms | Latest capture IDs and individual timelines were not supplied; do not assign historical IDs to these successes |
| Latest Test B wellness energy | Early energy approximately -26.9 dB, followed by quiet audio approximately -49.8 dB; sampled, full-buffer and DC-centered measurements closely agree | Aggregate values are not every buffer's level or a speech classifier |
| Latest Test B calibration | All three captures reported speech_during_calibration; fixed -48 dB threshold successfully detected post-speech silence | Demonstrates that this calibration label is compatible with success, not that it guarantees success |

In the earlier Test B run, all three captures reportedly received valid 48 kHz mono PCM, raw Apple final callbacks, and no pre-callback cancellation. Partial text was retained and rejected as final evidence in the two failures. These earlier failures remain part of the record; the latest successful run does not erase or explain them.

Test C has not been reported here.

## Supported interpretation

- The current endpoint and finalization sequence can produce valid, rapid final results. Latest finalization times are well within the unchanged 2.5-second limit. There is no evidence-supported reason to alter production recognition configuration, ordering or deadlines based on this successful run.
- The latest wellness energy drops approximately 22.9 dB from early input to later quiet. Its quiet aggregate is approximately 0.3 dB above the Test A baseline, supporting a consistent quiet-input comparison.
- The quiet aggregates are only about 1.8–2.1 dB below the fixed -48 threshold. Individual intermittent buffers could cross it even when an aggregate remains below it. This is a reason to retain distributions and reset timing, not a reason to change the threshold.
- Agreement of sampled/full/DC-centered results provides no evidence of a material sampling or DC bias in this successful run. It does not rule out such effects in another route/environment/run.
- speech_during_calibration is not itself a failure condition. It invalidates the floor estimate and retains the fixed threshold; this run shows that qualifying silence can still follow.
- Earlier capture-budget failure and silence-endpoint failure must be distinguished. Successful endpointing is not a guarantee that Apple's final text will be usable.

## Best evidence if Test C fails

First preserve the complete existing capture chain; no additional production change is indicated. Use one capture's exact ID and keep:

1. Endpoint selection reason, all selection-check booleans, silence/activity durations, fresh-buffer age and calibration state. Compare selection-time metrics with selection-time metrics, not completion-time values affected by cleanup.
2. Shadow early/later/all sampled, full and DC-centered fractions, min/max and histograms, DC magnitude, format and invalid-buffer counters. Include durations: a short successful capture has a shorter later window. Mono-versus-multichannel and sample-rate differences are potential confounds, not diagnoses.
3. Native ordering milestones: input stop, engine/tap stop, endAudio, task.finish, Apple final arrival/handling and cleanup cancellation. Retain public task state/error domain/code before cleanup; cancellation after cleanup is expected and does not explain an earlier empty final.
4. `finalAtCallback` versus `finalHandled`, best trimmed/alphanumeric presence, segment and nonempty-transcription counts, accepted-final flags and adapter usability. Verify `resultMetadataRevision=english-result-metadata-v1`; if absent, the newer native Debug metadata requires rebuilding/installing the Debug app, not just reloading JavaScript. Do not dump result text, segment substrings or alternative transcripts.
5. Same-ID VoiceCheck response channel and controller/React UI records. Keep coarse route, environment and microphone-position notes consistent with the comparison; do not include device identifiers or driver information.

The existing histograms do not preserve the temporal order of bursts. If Test C still leaves that specific question unresolved, the most useful **additional proposed Debug-only observation** is a fixed-size energy timeline (for example, 24 × 250 ms buckets across the existing six-second window), plus the source/time of the last activity-clock reset (`energy` versus the one-time calibration invalidation). Each bucket would contain only bounded energy/above-threshold aggregates for the three shadow variants. It would not classify speech, retain PCM, extend time, or drive endpointing. This is a proposal only; no instrumentation was added in recording these results.

Interpretation of a future failure:

- Repeated late energy bursts resetting the clock support an acoustic/energy explanation for delayed endpointing; their source remains unknown without controlled environmental comparisons.
- An early, qualifying silence endpoint followed by an already-empty best final at callback entry supports final-result failure beyond endpoint delay; it does not by itself establish an Apple framework bug.
- Usable best text at callback entry but absent at handling supports investigation of the result handoff boundary.
- Empty best with nonempty segments/candidates is a result inconsistency to investigate, not permission to select another candidate or promote a partial.

## Scope

Documentation only. Production endpointing, thresholds, recognition configuration, finalization, partial rejection, manual fallback, Spanish, safety authorization and consent are unchanged. No new code, dependency installation, commits or pushes. No recognition-fix claim. Existing uncommitted work preserved.

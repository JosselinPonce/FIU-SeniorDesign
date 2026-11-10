# English VoiceCheck — final-result boundary investigation

## Decision

No concrete production recognition defect was established from the current source and reported Test B metadata. Implemented only the missing Debug result-boundary/configuration metadata. This is not a recognition fix, and no new physical-device success is claimed.

## Source findings

English creates an exact-locale SFSpeechRecognizer task with an audio-buffer request, explicit on-device recognition, partial reporting, and confirmation task hint. The request receives the full original Float32 buffers through the existing locked feed gate. Shadow sampling does not resample or modify recognition input. Gate closure waits for any in-flight append; no later accepted append crosses endAudio.

The callback's existing Task/MainActor handoff checks capture identity before handling results. It stores bestTranscription text in distinct partial/final state. Genuine nonempty alphanumeric final text is required; partials and other hypotheses cannot establish final decisions or consent. Callback errors remain authoritative over a simultaneous result. No source path was found that deliberately clears retained partial text or accepts a stale final.

Application endpointing stops input, stops engine/removes tap, calls endAudio and once-only task.finish, then permits up to 2.5 seconds for a final. Cleanup cancellation occurs after terminal selection and capture invalidation. Apple documents finish as processing already accepted audio and explicitly describes its use for buffer recognition: [Apple finish documentation](https://developer.apple.com/documentation/speech/sfspeechrecognitiontask/finish()). Removing it or changing its order is not a documented correction for empty finals. Request hint changes likewise lack supporting device evidence. No request configuration or finalization sequence was changed.

Intermittent above-threshold energy can independently postpone silence endpointing; Test B's audio_silence failure demonstrates that deadline expiration alone is not sufficient to explain empty finals. A valid partial remains a hypothesis that Apple may revise. Neither an audio-silence endpoint nor a task-completed state guarantees nonempty final words. Choosing another final alternative or reconstructing text from segments could conflict with the recognizer's best result and requires a separately justified safety design; it was not implemented.

Existing trace fields did not distinguish the best-transcription metadata at callback entry from that observed after MainActor handoff, or expose whether the final result contained segments/other nonempty candidates. This is now observable without saving text or selecting those candidates.

## Exact changes

- `modules/local-foundation-models/ios/OfflineSpeechDiagnostic.swift`: Debug-only result-summary helper, callback-entry and MainActor summaries, actual request-configuration snapshot, attached to the existing capture-owned finalization payload.
- `modules/local-foundation-models/index.ts`: optional metadata types; existing forwarding needs no runtime change.
- `tests/englishRecognitionResultMetadata.test.ts` (new): actual extracted helper/transcript-state tests with synthetic platform stubs, plus Release/ownership/boundedness checks.
- This report.

No recognition configuration, PCM append, deadline, actor dispatch, audio setup, prewarming, Spanish implementation, guidance, Gemma, manual fallback, consent or emergency authorization was changed. Existing uncommitted work was preserved. No commits, pushes, resets or dependency installation.

## Newly exposed metadata

Inside the existing Debug `englishFinalization` object:

- `resultMetadataRevision=english-result-metadata-v1`.
- `requestConfiguration`: actual requiresOnDeviceRecognition, shouldReportPartialResults, taskHint raw value, recognizer locale, contextual-string count, and addsPunctuation when publicly available. No contextual strings, profile data or identifying request metadata is included.
- `resultSnapshots`: at most six fixed slots—firstPartialAtCallback/firstPartialHandled, finalAtCallback/finalHandled, terminalAtCallback/terminalHandled. “First partial” means first nonfinal result callback, not necessarily the first usable partial. A terminal snapshot covers callbacks with no result. Each slot is written once.
- Each result summary contains resultPresent, rawIsFinal, bestTrimmedPresent, bestAlphanumericPresent, segmentCount, hasNonemptySegment, transcriptionCount and nonemptyTranscriptionCount. The transcription count includes the best result when Apple includes it in the array; no candidate text or segment substring is retained.

Callback-entry summaries are computed synchronously before the existing MainActor dispatch. Only value metadata is added; publication occurs after the existing current-capture guard. No task state is accessed off MainActor. Existing public task snapshots/error metadata remain available to compare with these new fields. Observations add Debug computation overhead, not a new timer, task, wait, lifecycle operation or acceptance rule. Metadata compiles out of native Release; JS recording remains the existing opt-in bounded RAM path.

## Validation

- Relevant result/transcript/finalization/adapter/VoiceCheck regressions: **71 passed, 0 failed**.
- Full suite: **666 passed, 0 failed, 0 skipped**.
- `tsc --noEmit` and `git diff --check`: passed.
- Full unsigned Debug iOS app build: passed; native object newer than the final edited Swift source.
- Release iPhoneOS speech implementation object compilation: passed. New metadata markers are present in Debug and absent in Release. This is scoped Release compilation, not a full signed app archive.
- Host tests cover nil result, genuine final flag with whitespace-only best result, punctuation-only text, segment/text inconsistency, nonempty alternatives with empty best, retained partial rejection, and metadata privacy. A mutable stub demonstrates detection of a callback/handling difference; it does not claim that Apple's result objects actually mutate.

## Next physical-iPhone check

1. Install a freshly rebuilt native Debug app; verify resultMetadataRevision in the exported capture. Keep the route and audio policy unchanged and aligned-session experiments off. Use the Settings rehearsal, outside a drive.
2. Start/clear the existing timing recorder, reproduce one synthetic wellness/contact sequence, then immediately refresh/copy JSON before stopping capture. Use the existing capture-ID filter; the new fields are nested within the already-allowed englishFinalization object. Retain endpoint, shadow energy, task/error, adapter and UI records for the same ID.
3. Compare finalAtCallback, finalHandled and accepted-final fields:

| Trace | Supported next action |
| --- | --- |
| Best absent at callback and handling; no nonempty candidates/segments | Empty final already present at the boundary. Do not change JS interpretation or promote a partial. Investigate request/service/input effects with controlled evidence. |
| Best usable at entry, absent/changed by handling | A handoff-boundary discrepancy is supported. The smallest candidate production correction would be to snapshot immutable genuine-final text/flags at callback entry and process those under unchanged ownership/error checks. Implement only after this occurs on device. |
| Empty best but nonempty segments/other candidates | A final-result formatting/selection inconsistency is supported. Do not automatically use another candidate or reconstruct consent words. |
| Best alphanumeric and raw-final flags valid at entry/handling, but accepted final false | Inspect stored final/evidence mapping for the same capture before changing finalization. Punctuation-only text remains correctly rejected. |
| Unexpected request flags, task cancellation or public error state | Check the actual installed build and the specific configuration/lifecycle boundary identified. |

Physical confirmation requires repeated final-evidence acceptance on the previously failing wellness/contact paths, plus refusal, cancellation, manual fallback and rehearsal isolation. This metadata extension alone does not establish improved recognition reliability.

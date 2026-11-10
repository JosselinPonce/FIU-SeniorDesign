# Phase 2G — Debug English shadow audio measurements

Diagnostic extension only. The current energy detector remains authoritative; no recognition failure is claimed fixed and no physical-device result is claimed.

Subsequent user-reported Test A/Test B observations, including successful and earlier failed captures, are recorded separately in [Phase 2G physical observations](phase2g-physical-results.md). The implementation validation below remains automated/build evidence.

## Implementation and fields

The Debug English `SpeechActivityMeter` observes accepted PCM synchronously after the existing `state.receive` and recognition-request append. It neither alters nor replaces the samples passed to recognition. Preparation/cue audio is excluded by the existing listening gate. Reset follows that same gate. The helper and all integration points compile out of Release. Spanish and the shared `OfflineEndpointState` are unchanged.

The existing capture-matched `englishFinalization` completion payload gains `shadowAudio` (native path `englishFinalizationDebug.shadowAudio`). The existing JS Debug/capture-ID forwarding, opt-in recorder, publication deduplication and extraction allowlist already carry this nested field; no new progress events or per-buffer records were added. Older native binaries may omit the field.

Fields:

- `version=english-shadow-energy-v1`, `thresholdDb=-48`.
- `all`, `early`, `later`: each has `sampled`, `full`, and `dcCentered` energy distributions plus DC summaries.
- Each distribution contains `durationMs`, duration-weighted power expressed as `rms` and `powerDb`, `minDb`, `maxDb`, `aboveThresholdFraction`, and a fixed 17-bin duration histogram (`histogramMs`). Empty distributions use null measurement values. The dB floor is -120. This is a normalized-PCM energy proxy, not calibrated acoustic SPL or a speech probability.
- `sampled` uses the original meter's already-computed every-fourth-sample mean power. `full` measures every sample across channels. `dcCentered` uses per-channel online mean/variance, then averages the channel variances; it does not average channels together and cancel opposite-phase signals. Every variant uses the existing -48 dB comparison solely for shadow statistics.
- `meanAbsDC` is the duration-weighted mean of absolute per-buffer channel means; `maxAbsDC` is the largest absolute channel mean. These are normalized sample magnitudes, not waveform samples or DC-correction instructions.
- `channels`: at most four indexed channel summaries with the same three energy variants and DC metrics. Aggregate energy still includes all supported input channels, up to 32. `omittedChannelSummaries` identifies channels beyond the four detailed slots; unsupported configurations are counted without affecting recognition.
- Format and coverage fields: sample-rate/channel-count/frame-count minima and maxima, buffer count, invalid/nonfinite-buffer count and unsupported-buffer count. Invalid data is excluded from energy summaries, never silently converted into “silence.”
- `histogramUpperEdgesDb`: -90 through 0 in 6 dB increments. Bins are below -90, then [-90,-84) through [-6,0), then >=0. Values are accumulated duration, not saved levels over time.

`earlyAudioWindowMs=2000` and `windowBasis=accepted_pcm_duration` define the first two seconds of accepted PCM versus the remaining accepted PCM. They are **not** automatic speech/silence labels and need not match two seconds of wall time if input stalls. One boundary-crossing buffer contributes its duration proportionally to both windows using its buffer-level energy, so the boundary has buffer-duration resolution. Format/frame coverage is provided to assess this limitation.

The helper keeps fixed-size statistics, up to four scalar per-buffer channel summaries, and no history of samples/levels. No PCM buffer, sample array, transcript, callback closure, contact or profile is retained. Per-channel histograms are whole-capture summaries; early/later summaries are pooled across channels. DC centering can remove real low-frequency signal components, so it is diagnostic comparison only, not a proposed production filter.

No new task, timer, wait, microphone operation, audio-session request, threshold, silence duration, six-second budget, 2.5-second grace or finalization ordering is introduced. Extra Debug computation has observation overhead; it does not intentionally change scheduling or capture policy. Stopped/cancelled captures retain their existing ownership guards. Partial transcripts remain unusable for final decisions or consent.

## Exact files changed

- `modules/local-foundation-models/ios/OfflineSpeechDiagnostic.swift`: Debug-only aggregate helper, English meter observation/reset/snapshot, nested completion payload.
- `modules/local-foundation-models/index.ts`: optional typed shadow payload; no runtime adapter change.
- `tests/englishShadowAudio.test.ts` (new): execution of the actual extracted helper with synthetic PCM and Release/authority isolation checks.
- This report.

Existing uncommitted work was preserved. No dependencies installed, project/audio configuration changed, commits created, resets performed, or pushes made.

## Validation results

- Relevant shadow, native finalization/transcript, adapter and recorder tests: **47 passed, 0 failed**.
- Full automated suite: **664 passed, 0 failed, 0 skipped**.
- `tsc --noEmit`: passed.
- `git diff --check`: passed.
- Full unsigned Debug iOS app build: passed (SmartWheel workspace/scheme, generic iOS device). The compiled native object is newer than the final Swift source. No device installation or microphone validation was performed.
- Release iPhoneOS speech implementation object compilation: passed. New shadow payload/algorithm markers were present in the Debug object and absent from the Release object. This is scoped Release native compilation, not a signed Release app archive.
- Release iOS/Hermes JavaScript export: passed. Runtime forwarding remains the existing Debug-only capture-matched path.
- Synthetic checks cover zero input, constant DC offset, quarter-sample-rate tones with positive and negative stride-sampling bias, single-noisy-channel stereo, opposite-phase channels, early active/later quiet input, format changes, channel caps, invalid data and bounded serialized size after 10,000 buffers. They execute the actual Swift aggregate code with invented signals, not physical recordings. The original endpoint and Spanish code are unchanged.

## Physical-iPhone tests A, B and C

Rebuild/install the updated **native Debug app**; a Metro reload cannot supply the new Swift helper. Keep aligned-session experiments disabled. Park, stop monitoring/recording and other audio tests, and use Settings → Health & Safety → Try the voice check so live phone authorization remains isolated. Keep route, device position/microphone distance, volume and connectivity consistent between baseline tests.

Before each rehearsal, Advanced Settings → start/clear timing capture. After each, finish/cancel safely, return immediately, refresh and copy the JSON **before stopping capture** (Stop clears RAM). Use the existing metadata-only extraction procedure in `phase2c-core-1-2.md` with the actual new capture ID. Preserve `native recognition completed.details.englishFinalization.shadowAudio`, endpoint measurements/checks, native timing milestones, adapter outcome and selected channel. Confirm the payload version exists before collecting multiple runs. No personal symptom/name/phone transcript is needed.

**A — Remain silent:** Stay silent throughout the listening window after the readiness cue. A timeout/manual fallback is an expected possible outcome; never accept hallucinated/partial text as a decision. The rehearsal may ask a second wellness question; retain the two capture IDs separately. Finish the rehearsal or cancel safely after the tested window. This establishes the energy baseline for an intentionally nonspeaking interval; do not assume the microphone signal itself is silent.

**B — Short answer, then quiet:** Give the same short synthetic answer (for example, “I'm okay”) promptly after Listening/readiness, ideally completing within the first two seconds, then remain quiet. Retain the whole capture regardless of success/failure. Early/later periods are fixed PCM windows; manually note if the answer crossed the boundary without saving its transcript. For a successful short capture, the later window may contain less than four seconds; compare durations along with fractions.

**C — Repeat B somewhere quieter:** Keep the same route, device position/distance and speaking style; change the ambient environment. Repeat the same synthetic answer, then remain quiet. Do not simultaneously change Bluetooth or audio policy, which would confound the environment comparison. Run each condition more than once; capture IDs are per-run, not permanent labels.

Interpretation:

- Sampled high, full lower: evidence of a sampling-dependent energy difference; quantify it before proposing a meter correction.
- Full high, centered lower, substantial DC magnitude: evidence that per-buffer DC/very-low-frequency content contributes materially; not proof that a production high-pass filter is safe.
- All three remain high during intended quiet: persistent AC input energy is supported, but speech/noise/source is still unknown.
- One channel dominates: investigate channel/route configuration without automatically changing channel selection.
- A quieter environment changes the later full/centered distributions: evidence for an environmental contribution, subject to consistent setup and repeated runs.

None of these observations authorizes a threshold change, transcript promotion, deadline extension or recognition fix by itself. Preserve the final-evidence and manual fallback requirements during all comparisons.

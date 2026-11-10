# Physical-iPhone contextual acknowledgment evaluation (Phase 1C contract)

This Debug-only screen evaluates the installed approved GGUF through the existing
`gemmaPoc.load()` → `generateSafetyAcknowledgment()` → `dispose()` controller and
production eligibility filter, prompt and exact-match validator. Phase 1C refines
the prompt and narrows permitted outputs to one sentence. Model parameters,
production safety wiring and speech code remain unchanged. The fixed fixture suite
is still `contextual-ack-v1`; reports identify `outputContract: single-sentence-v2`
and `promptRevision: spanish-grounded-example-v3`. Phase 1D changes only the Spanish
prompt; the output contract and English prompts are unchanged.

## Run on an iPhone

1. Unload Gemma, stop the app and load the updated JavaScript using the same
   physical-iPhone **Debug** binary from Phase 1B. Phase 1C has no native changes.
   If that binary predates the Phase 1B memory bridge, rebuild the existing
   SmartWheel Debug scheme; no dependency installation or prebuild is needed.
2. Complete existing onboarding and reuse the installed verified model. End any
   recording and safety test. Open Settings → Advanced Settings → Gemma diagnostics.
   The existing screen is unavailable during a drive or safety check.
3. If already initialized, choose **Unload model safely**. Choose **Run contextual
   English + Spanish suite**. It runs 12 fixed synthetic statements, six per
   language: three recognized first-person reports, one ambiguous statement, one
   negated symptom and one instruction-like unsupported statement.
4. The six eligible cases start unloaded, verify/reuse the approved receipt, load,
   generate with the production 1.5-second deadline, validate and release. The six
   omitted/unsupported cases use deterministic fallback without loading or inference;
   their reason is `ineligible_statement` and `inferenceSkipped` is true. No microphone, TTS, driver profile, consent or phone API is invoked.
   The synthetic NOT OK outcome is fixed; this does not test intent classification.
5. Copy the selectable JSON report before leaving. Results live only in RAM; there
   is no automatic file storage, logging, upload or clipboard write. Rerunning
   replaces the report. Record external test notes such as airplane mode, thermal
   state and first versus repeated run separately; do not enter driver data.
6. Repeat in airplane mode after installation. Separately exercise Cancel during
   load and inference, backgrounding, and leaving the diagnostic. Cleanup must
   settle before reuse. Never force-unlock a hung native operation. If release
   fails, the suite stops and the existing explicit unload/restart recovery remains.

The screen can still run without the new memory bridge; it reports
`rebuild_debug_native_bridge` rather than pretending memory was measured.

## Report fields

The report identifies the suite version, artifact revision/hash, OS version and
run start and output-contract revision. Each row contains only a fixed fixture, sanitized production context,
selected language, whether the statement was omitted, raw returned output,
validated text or null, validator acceptance, fallback text/reason, release status,
operation timings and memory snapshots. A timed-out/cancelled native result is
intentionally discarded by the production controller and reported as null; the
diagnostic does not bypass that protection to recover partial/late text.

- `initializationMs`: existing controller measurement around successful native
  initialization; excludes file verification. Null if initialization did not
  successfully finish. It is not a zero-duration measurement.
- `loadOperationMs`: elapsed controller load call, including verification/receipt
  and associated file operations, initialization and any cancellation cleanup.
- `inferenceMs`: existing controller measurement around native generation,
  including its completion/stop response. Not time-to-first-token or tokens/sec.
- `inferenceOperationMs`: elapsed generation controller call, including stop cleanup.
- `releaseOperationMs`: elapsed dispose call after generation has settled, including
  controller overhead; failure is identified by `releaseSucceeded: false`.
  `releaseHadContext` distinguishes a real loaded-context release from a no-op
  disposal. Cancelled initialization may release internally within the load call;
  its separate native release duration is unavailable, not measured as zero.
- `operationSumMs`: load + inference-operation + release-operation call durations.
  Memory sampling between operations is excluded. This is not an end-to-end
  VoiceCheck timing or proof of meeting the five-second presentation window.

Initialization/inference use the controller's existing JS clock; wrapper durations
use monotonic `performance.now()`. Compare durations, not timestamps across clocks.
A model/context reload is not proof that iOS file caches are cold. Debug/attached
Xcode overhead and the four memory probes may perturb subsequent measurements.

Memory is sampled before load, after load, after inference and after release:

- `devicePhysicalBytes`: total device RAM, **not free memory**.
- `availableToProcessBytes`: OS estimate of memory available to this process,
  **not system-wide free RAM** and not an allocation guarantee.
- `residentBytes`, `physicalFootprintBytes`: whole-app process snapshots from
  `task_info`; null if that query fails. They include more than Gemma and do not
  identify allocations attributable to Metal or the model.
- `uptimeMs`: native sample time. `peakNativeMemoryMeasured` is always false.

Sparse snapshots cannot establish peak native/model/GPU memory or absence of leaks.
Use Instruments separately when peak allocation attribution is required.

## Interpret acceptance rates

The display shows accepted/attempted separately for English and Spanish and for
grounded reports. The planned suite is six cases per language, with three eligible grounded
reports and three skipped cases per language. Acceptance uses only attempted
inferences as its denominator (three per language on a completed run). Skipped
cases are not counted as accepted or rejected model completions; their timings
are null and no release is attempted. Cancellation or fatal load/release failure produces a partial
report; do not compare its denominator with a completed suite as if both finished.
`completedOutput` counts returned text, including an empty completion. Review raw
outputs and rejection/fallback reasons, not just the aggregate fraction.

- Grounded acceptance means the exact-match validator accepted a single sentence grounded
  in that eligible report. It does not establish naturalness or general fluency.
- Ambiguous and unsupported statements are intentionally omitted and skip the
  model entirely. Verify `ineligible_statement` for all six; no meaning should be
  inferred from them. The same six cases previously ran unnecessary inference.
- `validator_rejected` can mean harmless formatting/grammar variation, wrong
  language or unsafe text. Inspect the recorded raw output; do not relax production
  validation just to increase this metric.
- `empty_output`, `inference_timeout`, `inference_error`, `initialization_error`,
  `runtime_owned`, `cancelled` and `release_error` distinguish availability/lifecycle
  failures from validator rejection. A release error can coexist with valid text;
  validator acceptance alone is not a successful production lifecycle.

No physical-iPhone GGUF results are supplied by automated tests. The new tests use
mocked native completions while exercising the real production controller and
validator. The user-reported Phase 1B baseline completed 12 inferences with 0 accepted
outputs, ~349 ms average inference, ~609 ms combined operations and 12 releases.
The user subsequently reported Phase 1C English acceptance 3/3, Spanish 0/3
(all three copied the Spanish placeholder), with six correct inference skips and
successful attempted load/release operations. The Phase 1D physical rerun then accepted English 3/3 and Spanish 3/3, with six
correct skips and six successful attempted load/release operations. This is one
small controlled run, not a general bilingual-quality guarantee. See
[SPANISH_PROMPT_REFINEMENT.md](./SPANISH_PROMPT_REFINEMENT.md) for the current change.
See [PROMPT_REFINEMENT.md](./PROMPT_REFINEMENT.md) for evidence and limits. Existing isolated VoiceCheck simulations
remain the separate integration check for playback/prewarming/manual fallbacks and
five-second result availability; do not bypass their dialer isolation.

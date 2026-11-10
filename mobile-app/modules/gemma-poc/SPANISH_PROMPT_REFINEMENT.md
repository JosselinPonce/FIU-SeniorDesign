# Phase 1D: remove Spanish placeholder copying

## Observed cause and fix

The user-reported physical-iPhone single-sentence-v2 run accepted English 3/3 and
Spanish 0/3. All Spanish outputs were exactly `Lamento que te sientas SENSACIÓN.`.
All six ineligible cases skipped inference, and attempted loads/releases succeeded.

The production Spanish prompt contained that exact unresolved sentence and asked
Gemma to replace its uppercase placeholder. The observed model copied the example
instead of carrying out the replacement instruction. This establishes the failing
prompt interaction; it does not establish an internal training/tokenization cause
or a native runtime fault. The validator correctly rejected the unresolved text.

The Spanish-only prompt now shows one complete example drawn from the existing
approved candidate builder for the eligible reported feeling. For `Me siento
mareada`, the example is `Lamento que te sientas mareada.`. For `Estoy cansado`, it
is `Lamento que te sientas cansado.`. The prompt keeps the speaker/recipient,
single-sentence, language and safety restrictions, with no replacement task or
unresolved placeholder. Reported gender is preserved directly; profile data is not
used to guess gender. Existing canonical accent normalization remains unchanged.

The example is constructed BEFORE inference from the existing constrained
candidate set. Returned model text is still passed unchanged to the same strict
validator. There is no substitution into generated text, quote removal, symptom
repair, newly accepted phrasing, or fallback override.

English prompt strings are byte-for-byte unchanged for all three control cases.
The validator, eligibility filter, generation settings, model, deadlines, native
speech, recognition, onboarding, IPA configuration, safety classification,
authorization, mandatory instructions and emergency handoffs are unchanged.
Cancellation, serialized model ownership and the six inference skips remain.

## Automated checks versus physical results

`tests/spanishGemmaPrompt.test.ts` tests literal placeholder rejection without
repair, complete grounded Spanish examples, masculine/feminine forms, accents,
invented/incorrect symptoms, role imitation, wrong language, extra prose, exact
English prompt preservation, all six ineligible skips, and timeout/cancellation.
These tests use mocked completions. They are not new physical GGUF observations.

The same physical-iPhone suite was subsequently rerun successfully; results appear below.
A small model can still copy instruction text or produce other invalid output;
strict rejection and deterministic fallback remain necessary.

## Rerun the same physical-iPhone suite

1. Unload any initialized model, stop the app and load the updated JavaScript in
   the existing Phase 1B/1C Debug binary. No native change or model download is
   required for this prompt revision.
2. On the same physical iPhone, open Settings → Advanced Settings → Gemma
   diagnostics → Run contextual English + Spanish suite.
3. Copy the RAM-only JSON and verify `suite: contextual-ack-v1`,
   `outputContract: single-sentence-v2`, and
   `promptRevision: spanish-grounded-example-v3`.
4. Expect the same 12 rows: three English and three Spanish inference attempts,
   six `ineligible_statement` skips, and six successful releases if all eligible
   cases finish. Review the raw Spanish outputs and validator results. An unresolved
   placeholder must remain rejected. Recheck English as the unchanged control.
5. Repeat cancellation/background and the existing isolated safety simulation;
   never bypass consent or simulation phone protections for model evaluation.

A physical rerun requires access to the paired iPhone and its running Debug app.
Local automated tests, simulator execution and desktop inference cannot substitute
for those measurements.

## Phase 1D file manifest

- `lib/assistant/safetyAcknowledgment.ts`: Spanish prompt only; English/validator unchanged.
- `modules/gemma-poc/contextualDiagnostic.ts`: diagnostic prompt-revision metadata only.
- `tests/gemmaPromptContract.test.ts`: expect a complete Spanish example rather than a placeholder.
- `tests/spanishGemmaPrompt.test.ts`: new regressions.
- `modules/gemma-poc/CONTEXTUAL_DIAGNOSTIC.md`: current revision and rerun instructions.
- `modules/gemma-poc/PROMPT_REFINEMENT.md`: link the historical Phase 1C report to Phase 1D.
- `modules/gemma-poc/SPANISH_PROMPT_REFINEMENT.md`: this report.
- `docs/gemma-phase1d-physical-results.json`: actual synthetic physical-run artifact.

## Validation results for this change

- TypeScript (`tsc --noEmit --incremental false`): passed.
- Full automated suite: 601 passed, 0 failed, 0 skipped.
- `git diff --check`: passed.
- Connected-device inspection found a paired iPhone and running DriveSense Debug
  app. Its loaded Spanish prompt was verified to contain the complete grounded
  example and no unresolved placeholder.
- The app initially displayed onboarding, which was not bypassed or changed. The
  operator opened the existing Gemma diagnostic and confirmed readiness. Its
  existing guarded run button then executed the physical suite through the real
  installed GGUF/native controller and unchanged validator.
- Actual rerun: 12 rows; English 3/3 accepted; Spanish 3/3 accepted; six ineligible
  cases skipped; all six attempted loads and releases succeeded.
- Spanish raw completions (each had a trailing newline, accepted by the existing
  outer-whitespace trim): `Lamento que te sientas mareada.`,
  `Lamento que te sientas cansado.`, `Lamento que te sientas mal.`.
- English raw completions remained correct for dizzy, weak and unwell. No model
  output substitution or repair was performed.
- This is one six-inference physical run, not a broad bilingual-quality guarantee.
  The timing snapshots are device measurements, not peak-memory evidence.

Physical-run mean durations across the six eligible cases (ms):

- `initializationMs`: 207.83
- `loadOperationMs`: 222.33
- `inferenceMs`: 189.67
- `inferenceOperationMs`: 189.76
- `releaseOperationMs`: 9.71
- `operationSumMs`: 421.80

The report contains only fixed synthetic fixtures, generated acknowledgments and
runtime metrics. It contains no personal driver transcripts or profile data.
The complete raw artifact is [gemma-phase1d-physical-results.json](../../docs/gemma-phase1d-physical-results.json).

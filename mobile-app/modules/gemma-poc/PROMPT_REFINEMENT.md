# Phase 1C: single-sentence contract refinement

## Evidence and attribution

The user reports Phase 1B physical-iPhone results: 12/12 completed inferences,
0/12 validated outputs, approximately 349 ms average inference, approximately
609 ms average load + inference + release, and 12/12 successful releases. The
reported patterns are quoted comma-separated alternatives in English, occasional
Spanish driver-role imitation, and unrelated/long output for omitted statements.
Exact raw reports were not supplied in this turn. Regression strings reproduce
those patterns; they are not claimed to be verbatim model completions.

Inspected production prompt before refinement:

- English instructions for both languages, followed by JSON context containing a
  first-person driver statement and a JSON array of quoted permitted sentences.
- A final instruction allowed one sentence plus an optional second sentence.
- Null/omitted statements still received a generic generation task.

These establish prompt/contract problems, not a proven account of model internals:

| Observation | Code-supported explanation | Attribution limit |
| --- | --- | --- |
| Quoted alternatives | The prompt ends in exactly that format: an array of quoted alternatives. Copying that surface form is a plausible cause. | Requires a controlled rerun to establish improvement. |
| Spanish driver-role text | First-person report text appears inside English instructions, without a localized explicit speaker/recipient contrast. | A role cue can contribute; model capacity/language proficiency may also matter. |
| Unrelated text for omitted statements | Inference was invoked with no eligible feeling to reflect. | There is no authorized meaning to recover from excluded text. |
| Long/multiple sentences | Optional second-sentence instruction conflicts with the new one-sentence objective; 64-token generation and turn-ending stops do not enforce sentence count. | A length cap is not an output grammar. |

## Chat and completion inspection

`phone.ts` calls `completion({ messages: [{ role: 'user', content: prompt }],
n_predict: 64, temperature: 0, stop: ['<end_of_turn>', '<eos>'] })`.
It does not concatenate manual Gemma role delimiters, override a chat template,
supply assistant history, or configure a native decoding grammar/schema.

Installed llama.rn 0.10.1 source (`src/index.ts`, `getFormattedChat`/`completion`)
formats `messages` before native completion. It uses Jinja when supported and
otherwise the built-in llama-chat formatter. Native `common/chat.cpp` reads the
GGUF's model template when there is no override; native JSI defaults the assistant
generation prompt to true. Jinja can add template-specific stops. The application
receives the completion text, then validates it; no quotation stripping or first
candidate extraction occurs.

No application-level chat-template misuse was found. The installed phone's exact
rendered template/token sequence cannot be independently established here without
its GGUF/runtime session. Do not claim that a template fault has been ruled out
experimentally. Temperature zero makes decoding greedy, not instruction-compliant;
turn/EOS stops do not prevent lists, explanations or first-person role confusion.

The model (Gemma 3 270M QAT Q4_0), pinned artifact, template selection, stops,
64-token cap, 1024-token context, sampling and deadlines remain unchanged to avoid
confounding this prompt revision.

## Changes

- Use a shorter prompt in the selected language. Explicitly distinguish Sensi from
  the driver and address the driver in second person.
- Supply only the already eligible extracted feeling, event category and fixed
  NOT OK outcome; omit the first-person report from the model prompt.
- Show one unquoted sentence form with a feeling placeholder, rather than a JSON
  list of alternatives. Require only its completed single sentence.
- Keep the validator function and its exact-match/length/format gates unchanged.
  Narrow its permitted grammar by removing two-sentence combinations. This adds
  no newly acceptable output and performs no output repair.
- Skip omitted/unsupported statements and button answers before any native load
  or generation. The same controller method also refuses ineligible generation.
- Preserve the 12 diagnostic fixtures, but mark six as deterministic skips before
  native work. Add the output-contract revision and explicit skip counts so the
  acceptance denominator remains honest.

Safety event classification, response recognition, mandatory instructions, contact
consent/handoff, profile data, prewarming and native speech are untouched. No model
output grants actions, changes severity or replaces guidance. Ownership,
nonblocking result consumption, cancellation and deterministic fallbacks remain.

## Controlled rerun and limitations

Use the same physical iPhone, installed model, Debug build, 12 fixtures and screen
button. After unloading/stopping the old run, load the updated JavaScript. No new
native build is needed if the Phase 1B memory bridge is already installed. Run
Settings → Advanced Settings → Gemma diagnostics → Run contextual English + Spanish
suite. Copy the RAM-only JSON report and confirm `outputContract: single-sentence-v2`.

Expect 12 rows: six actual inferences (three per language), six
`ineligible_statement` skips, and six successful releases if all eligible rows
complete. Skipped rows must have no generated text or model timings. Compare
acceptance and latency on the **same six grounded cases** against their Phase 1B
rows; do not compare three attempts per language with the former six as equivalent
samples. Repeat cancellation/background checks and the existing isolated safety
simulation. Never bypass simulation consent/dialer protections for this evaluation.

There are no new physical GGUF results in this implementation. The small model may
still echo placeholders, change punctuation, choose the wrong language or ignore
speaker instructions. Prompt refinement cannot guarantee correctness. Every such
output must still be rejected. Greedy sampling, a successful lifecycle and a high
acceptance rate do not prove bilingual quality, general understanding or safety.
If compliance remains poor, keep deterministic fallback and separately evaluate
constrained decoding; do not relax validation or infer excluded statement meaning.

## Files changed in Phase 1C

- `lib/assistant/safetyAcknowledgment.ts`
- `modules/gemma-poc/controller.ts`
- `modules/gemma-poc/contextualDiagnostic.ts`
- `modules/gemma-poc/GemmaDiagnostic.tsx`
- `tests/contextualAcknowledgment.test.ts`
- `tests/fixtures/safetyAcknowledgment.ts`
- `tests/sensiGemmaIntegration.test.ts`
- `tests/gemmaContextualDiagnostic.test.ts`
- `tests/gemmaPromptContract.test.ts` (new)
- `lib/assistant/SENSI_GEMMA.md`
- `modules/gemma-poc/CONTEXTUAL_DIAGNOSTIC.md`
- `modules/gemma-poc/PROMPT_REFINEMENT.md` (new)


## Subsequent Phase 1D refinement

The user-reported single-sentence-v2 physical rerun accepted all three English
cases but no Spanish cases: all Spanish outputs copied the unresolved placeholder.
The Spanish prompt now uses a complete grounded example; the English prompt and
validator remain unchanged. See [SPANISH_PROMPT_REFINEMENT.md](./SPANISH_PROMPT_REFINEMENT.md).

# Design: Gemma-primary interpretation for the safety voice check

Status: draft for approval
Branch: `samantha/local-ai-prototype`
Related docs: `docs/safety-testing-sensi-refinement.md`, `docs/phase2c-english-voicecheck-investigation.md`, `lib/assistant/SENSI_GEMMA.md`

## Intent and why

Today a driver's spoken answer to "Are you feeling okay?" is understood by three
layers: hand-written regex rules (`lib/voice/intent.ts`, `wellnessLanguage.ts`),
a ~120 KB logistic-regression model trained on template-generated phrases
(`tools/intent/phrases.py`, ~4.7k rows), and an on-device Gemma classification
that is gated almost shut (`lib/assistant/safetySemantic.ts`). Any phrasing
outside the trained vocabulary classifies as `unclear`, the question is asked a
second time, and a second unclear answer escalates as `no_response`. Probes
confirm the failure: "I am feeling a little under the weather today" → unclear
(conf 0.46); "yeah just need to stretch my legs" → unclear.

The inverse failure is dangerous: `wellnessLanguage.ts` short-circuits the model
when a positive phrase is present, and "headache" is missing from its symptom
lists, so "no I am fine but I have a headache" is accepted as OK (conf 0.90,
reason `symptom-report`) — the episode resolves OK and `learnFromOk` retrains
the driver's thresholds on a symptomatic answer.

**Transcription is not the limitation** — the offline recognizer already
transcribes any speech. The fix target is interpretation.

## Goals

1. The check understands a driver's answer regardless of phrasing, in English
   and Spanish, using the on-device Gemma runtime as the primary classifier
   for every usable final answer.
2. All existing deterministic safety properties are preserved exactly:
   urgent-keyword escalation, negation handling, quoted-speech rejection,
   emergency-services exclusion, contact-consent evidence rules, and the
   asymmetric evidence bar (OK requires more evidence than NOT_OK).
3. The false-OK class of bugs is eliminated at its root: one shared symptom
   vocabulary, consulted before any OK verdict, whoever produces it.
4. Behavior when Gemma is unavailable or times out falls back to today's
   deterministic pipeline (rules + LR model), unchanged.
5. Decision latency stays bounded and off the critical safety path: the Gemma
   budget remains abortable and its result settles before the response plan is
   composed (guidance playback is the current concurrency window).

## Non-goals

- No cloud or network interpretation. The safety path stays fully on-device.
- No changes to the contact-call authorization chain (`successfulFinal`
  evidence, captureId scoping, `authorizesContact`, `openAuthorizedPhoneInterface`).
- No changes to recognition evidence rules or the 6-second listening window
  (a separate investigation; not this design).
- No changes to Gemma provisioning/download/verification, the acknowledgment
  lane's prompt or deadline, or the standalone Sensi conversation
  (`assistantConversation.ts`). One scoped lifecycle exception is made: the
  semantic lane may load once per emergency check and keep the model warm
  until the check ends (see "Gemma operation discipline and lifecycle").
- No retraining in stages 1–2; retraining is stage 3 and must keep the
  zero-critical-error constraint (a not_ok answer classified as ok).

## Anti-goals (what would make this a failure even if it works)

- The model (Gemma or the LR model) mints an OK verdict when deterministic
  symptom evidence contradicts it.
- Model output ever reaches contact parsing, call authorization, or is treated
  as driver speech (existing invariant — stays).
- Interpreting statements containing prompt-injection phrasing ("ignore
  instructions"), reported speech, or third-person narration without the
  existing hygiene filters.
- A new over-escalation direction where hedged or negated statements
  ("maybe I'm okay", "I'm not dizzy") count as NOT_OK.

## Constraints

- Languages: `en` and `es` only ( recognizer locales `en-US`, `es-US`).
- Gemma runs via `modules/gemma-poc` (`generateSafetySemantic`), requires the
  artifact to be provisioned and loaded; the semantic task budget is 5 s with
  abort (`safetySemantic.ts:startSemantic`).
- `SENSI_MODE` is `'gemma'` today (`lib/assistant/mode.ts`). The `'core'`
  mode intentionally removes Gemma from the check; this design keeps that
  (core mode retains the deterministic path unchanged).
- The JS featurizer in `intent.ts` must stay identical to `train.py`
  (parity fixture); unless stage 3 retraining happens, `intentModel.ts`
  is untouched.
- Full test suite and `tsc --noEmit` must pass before hand-back.

## Approaches considered

- **A. Widen vocabulary only** — expand `phrases.py`, extend regex lists,
  fix the false-OK bug. Cheap and zero-risk to the safety architecture, but
  interpretation remains closed-vocabulary in principle; "any phrase" is not
  achieved. Chosen only as the stage-3 fallback work, not the primary fix.
- **B. Gemma-primary interpretation (chosen)** — every usable final answer
  goes through a structured Gemma classification with a strict JSON contract,
  combined with deterministic vetoes. Truly open vocabulary; small added
  latency on the check; needs new adversarial test coverage.
- **C. Cloud/LLM interpretation** — rejected: violates the offline-only safety
  architecture; the connected provider is deliberately frozen off in this codebase.

## Architecture (stage 2)

### Pipeline order for interpreting one usable final wellness answer

0. **Deterministic-instant decisions (no Gemma, no waiting):** the pre-filters
   below that can decide confidently resolve immediately. A rules-decidable OK
   (clean statement, no veto) or a rules-decidable not_ok (urgent keyword,
   negated-fine) settles at once. Healthy drivers never wait on the model.
1. **Deterministic pre-filters (unchanged, decision final when they fire):**
   empty/silent → silence issue; quoted speech → unclear; `URGENT` keywords
   (un-negated) → not_ok + urgent; `NEGATED_HELP` (uncomplicated) → ok;
   `NEGATED_FINE` → not_ok. `mentionsEmergencyServices` remains a side-channel
   recorded for the whole dialogue, never an interpretation.
2. **Symptom veto scan (new, single source of truth — stage 1 deliverable):**
   classify the statement against the shared symptom lexicon. This scan runs
   regardless of which classifier speaks and can veto any OK (step 5).
3. **Gemma classification (primary for the unclear band):** every statement the
   deterministic layers leave `unclear` — including hedged and borderline ones —
   runs `generateSafetySemantic` with the existing prompt/contract
   (`state/context/concern` JSON, strict `validateSemantic`). Started as soon
   as a usable final transcript exists, for **both** attempts (today it starts
   only after attempt 0 is unclear).
4. **Combiner (new module, replaces `semanticDecision` as the Gemma-side
   decision):**
   - Gemma `NOT_OK` + `concern: yes`, statement not negated/hedged
     (deterministic hedge/negation checks stay authoritative) → **not_ok**.
     Grounding by symptom vocabulary is no longer required to escalate; novel
     symptom language is the point. Over-escalation is bounded by the existing
     hedge/negation vetoes and is the safe direction of error.
   - Gemma `OK`: accepted only if the symptom veto scan (step 2) found nothing
     affirmative **and** `concern` is not `yes`. (The earlier draft's
     "LR model vetoes OK" clause is removed: in the unclear band the LR model
     has by definition P(not_ok) < 0.5, so the veto was vacuous. The symptom
     lexicon and hedge/negation checks are the OK gate.)
   - Gemma `UNCERTAIN`, timeout, abort, invalid JSON, or any disagreement with
     the deterministic hedge/negation checks → fall through to 5.
5. **Fallback (Gemma unavailable or undecided):** today's deterministic
   pipeline, unchanged: `wellnessLanguage` → LR thresholds (`OK_MIN 0.75`,
   `NOT_OK_MIN 0.5`) → `unclear`.
6. **Re-ask policy:** re-asking (the simpler second prompt) happens only when
   the decision is still `unclear`. At the moment a re-ask would fire, the
   check waits up to **2 seconds** for the attempt-0 Gemma verdict (the wait
   starts only if a Gemma task is actually running — a missing/failed model
   re-asks immediately, with no added silence). If the verdict lands, it is
   applied and the re-ask is skipped; otherwise the re-ask plays as today and
   the attempt-0 task is cancelled before attempt 1's task starts.
7. **Post-decision behavior (unchanged):** ok → reassure (+ `learnFromOk`);
   not_ok → mandatory guidance + acknowledgment + contact offer; no_response →
   classified failure message + not_ok guidance. Gemma output never touches
   the contact branch or consent.

### Gemma operation discipline and lifecycle

- **Warm during the check (decided):** when `runCheck` starts (live, rehearsal
  or demo), the controller kicks `gemmaPoc.load()` so the load hides inside the
  prompt's TTS playback; the model stays loaded until the check ends and is
  disposed by the existing `releaseAudio`/teardown path. This is the only
  change to the Gemma lifecycle; provisioning/ downloading (the provider non-
  goal) is untouched, and the model is still never resident across drives.
- **One operation at a time (hardware constraint, `GemmaPoc`):** attempt-0's
  semantic task is always consumed or cancelled before attempt-1's task
  starts; no two concurrent `eventGemma` calls are ever issued from the check.
- **Deadlines:** the semantic path's native deadline in
  `gemma-poc/controller.ts` (`generateSafetySemantic`, hard-coded 1500 ms)
  rises to **3500 ms** within the existing 5 s `startSemantic` JS budget,
  leaving room for validation and the combiner. The acknowledgment lane's
  1500 ms deadline is untouched.

### Prompt and contract

The existing single-key-set JSON contract (`state`, `context`, `concern`) is
reused unchanged — `validateSemantic` gets stricter about nothing and
`semanticPrompt` keeps its data-not-instructions framing. Elaborate
classification (e.g., severity, follow-up questions) is explicitly not added.

### Eligibility (widened — builder-check resolution)

`semanticEligible` widens so the unclear band — the population this design
exists for — actually reaches Gemma:

- Dropped: the "statement must already classify as `unclear`" requirement, the
  160-character cap (raised to 300), the letters-only charset (digits like
  "mile marker 45" are allowed).
- Kept (hard exclusions, unchanged): injection/action keywords
  (ignore/instructions/system/call/contact/llama/llames…), third-person and
  reported-speech markers, uncertainty-of-identity phrasing. Quoted speech is
  already rejected upstream of interpretation.
- Hedged statements ("maybe", "I don't know", "no sé") are now *eligible*:
  Gemma classifies them, and the combiner's hedge vetoes decide — they can
  neither escalate nor clear on their own.

### Hedge/negation authority (operational definition)

The stage-1 symptom lexicon becomes the single canonical hedge/negation
authority consumed by the combiner (today the logic is scattered across
`intent.ts`, `wellnessLanguage.ts` and `safetySemantic.ts`):

- A statement whose symptom mentions are **all negated** ("I'm not dizzy",
  "no longer dizzy since I slept") is never an escalator, and is OK-eligible
  only if the lexicon finds zero affirmative symptom tokens.
- Any affirmative symptom token → OK veto; Gemma OK may not override it.
- Hedges ("maybe", "perhaps", "not sure", "I don't know", "tal vez", "quizás"
  …), whether near a symptom or a wellness word, block both escalation and OK:
  the statement falls to the re-ask/fallback path.
- Fixtures pin this definition, including the healthy-negation case
  ("no longer dizzy" must NOT escalate) and the mixed-ambiguity case
  ("I think I'm okay, still shaken up a bit").

## Stage 1 (safety fixes — land independently, first)

Root cause of the false-OK: three hand-maintained symptom lists
(`wellnessLanguage.ts:13` discomfort list, `intent.ts` `SYMPTOM`,
`safetySemantic.ts` grounding lists) drift independently.

1. Extract a shared symptom lexicon module (`lib/voice/symptomLexicon.ts`
   or similar): categorized token sets (dizziness, fatigue, cardiovascular,
   respiratory, neural, pain, nausea…), en + es, affirmative/negated forms.
2. `wellnessLanguage` consults the lexicon: an `ok` verdict requires zero
   affirmative symptom tokens; "headache", "under the weather" and similar
   omissions are added.
3. `safetySemantic` grounding uses the same lexicon (keeps its per-context
   mapping).
4. Regression fixtures: the false-OK probe set ("no I am fine but I have a
   headache", en/es variants) and the existing ambiguous/negated set must pass.

## Stage 3 (fallback robustness — after stages 1–2 are verified)

Expand `tools/intent/phrases.py` seed vocabulary with real-world phrasings
(collected from device transcripts during testing, dialect variants, Miami
Spanish), regenerate `intentModel.ts`, keep the featurizer parity fixture and
the zero critical-error report gate. This stage only improves the Gemma-unavailable
fallback; it is not a substitute for stage 2.

## Latency and device considerations

- The semantic lane's native generation deadline (1500 ms today,
  `gemma-poc/controller.ts`) rises to 3500 ms within the 5 s `startSemantic`
  JS budget; measured single-sentence inference is ~1–3 s in the contextual
  diagnostic, so most verdicts settle.
- Cold-load (~seconds for the 270 M Q4_0 artifact) is absorbed by kicking
  `load()` at `runCheck` start and letting it finish during prompt TTS
  playback; by listen end the model is expected warm. If load has not
  completed, the fallback decides — no waiting, no retry loop at decision
  time.
- The 2 s pre-re-ask wait (re-ask policy step 6) is bounded and only paid
  when a Gemma task is actually running and the answer was unclear; all other
  decision paths are immediate.
- If Gemma is unavailable at any point (not provisioned, cleanup required,
  app inactive), behavior is byte-identical to today's deterministic path.

## Testing

- **Combiner matrix (new):** for each (Gemma state × veto scan × hedge/negation
  posture) combination, assert the decision. Including: Gemma OK with an
  affirmative symptom token → not OK; Gemma NOT_OK on a negated statement →
  re-ask path; Gemma NOT_OK on hedged statement → re-ask path.
- **Sequencing:** attempt-0 task is consumed/cancelled before attempt-1 starts
  (no concurrent Gemma events); warm-load kicked at check start and disposed
  at teardown; semantic native deadline raised to 3500 ms with the
  acknowledgment lane untouched.
- **Bounded wait:** a settled attempt-0 verdict skips the re-ask; the 2 s
  ceiling expires to the today-identical re-ask; no wait when no Gemma task
  runs.
- **Adversarial fixtures:** extension of the existing inject/negate/quote/
  third-person sets in `modules/gemma-poc/CONTEXTUAL_DIAGNOSTIC.md` style,
  plus novel-idiom fixtures from the probe set ("under the weather",
  "stretch my legs", "agotadito").
- **Stage-1 regressions:** the false-OK probe set, en + es.
- **No-network, no-Gemma:** combiner falls back and voice check behavior is
  byte-identical to today's deterministic path.
- Full suite (`npm test`) + `tsc --noEmit` green.

## Left to the builder

- File placement of the combiner module and the lexicon module (suggested:
  successor to the `safetySemantic` decision logic; lexicon in `lib/voice/`).
- Exact wording/revision bump of `semanticPrompt` if examples need updating.
- Whether the second-attempt listen window and hints change (default: unchanged).
- Dev-diagnostics surfacing of the combined decision (`responsivenessProbe`
  events) — keep the existing probe style, add `source` values
  (`gemma-primary`, `fallback-deterministic`, `lexicon-veto`, `pre-filter`).

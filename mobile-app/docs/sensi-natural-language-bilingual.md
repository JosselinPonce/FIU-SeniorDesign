# Sensi natural language, bounded Gemma assistance and bilingual sentence playback

## Inspection findings reported before implementation

The existing interpreter combines rules with a local logistic classifier; it is not purely phrase matching. The previous added symptom rule permitted only one optional intensifier. “No, I'm feeling really really tired” missed that rule and fell through to the unchanged classifier: P(OK)=0.499843, P(NOT_OK)=0.489106, P(UNCLEAR)=0.011051. Neither acceptance threshold was met (OK ≥0.75, NOT_OK ≥0.5). This explains that exact interpretation failure independently of speech capture. The Spanish repeated-intensifier example already had strong classifier support; the new deterministic handling does not assume every Spanish case was broken.

Native recognition → `speechIO` evidence adapter → controller ownership guards → `VoiceCheck.ask` → `successfulFinal` remains the entry path. Partial/incomplete/stale text is never interpreted as a final wellness answer or consent. A finalized transcript can still have unclear meaning. Existing native recognition, deadlines, prewarming, capture ownership, Spanish SpeechAnalyzer/SpeechTranscriber and English SFSpeechRecognizer are unchanged.

Fresh empathy inference was previously consumed immediately by the approved ready-only composition. That normally aborted generation before it started. Its conservative whole-statement eligibility also rejected natural intensifiers/fillers. The active conversation used the independent general interface-language context, which can translate/reverse translated presentation independently of the driver's VoiceCheck language. None of this proves the contents or finality of a historical physical capture; capture-correlated records are still required for that.

## Deterministic language improvements

`wellnessLanguage` adds bounded English/Spanish handling before the classifier fallback. Explicit current safety concerns override superficial reassurance. Exhaustion, inability to stay awake, dizziness, weakness and mixed “okay but…” statements cannot be cleared by a casual positive keyword. Clear positive reports with mild fatigue/long-day context remain OK; they do not offer a call just because fatigue is mentioned. Explicit uncertainty remains unclear and follows clarification. Existing urgent rules remain first, and the classifier weights and thresholds are unchanged.

Negation is local to the symptom phrase; another affirmed symptom still wins. Reported/historical statements are not treated as an obvious current self-report by the new rule. Spanish punctuation matters: “No, estoy cansada” differs from “No estoy cansada.” If ASR omits a meaning-bearing comma, clarification is safer than assuming a positive symptom report. The implementation does not claim unrestricted language understanding.

All requested regression examples pass. English/Spanish normalizer probabilities remain covered by the existing parity tests. Clear OK/NOT_OK answers bypass semantic inference; explicit known uncertainty also skips unnecessary semantic work.

## Bounded semantic assistance

The production `phoneSafetySemantic` uses the same installed Gemma 3 270M Q4_0 artifact, verified model path, llama.rn completion configuration and serialized maintenance/event ownership as empathy. No new provider, model, download policy or startup work was added.

Only the first eligible **finalized ambiguous** wellness answer can start semantic inference. It runs during the existing clarification TTS and capture opportunity; it is never awaited by VoiceCheck. At the end of clarification, a clear human answer wins. Otherwise, a ready candidate may be consumed once. Unavailable/late/invalid results preserve the existing conservative clarification/escalation path. Cancellation aborts the task; stale output cannot enter another episode.

Input is event category, selected language and a bounded finalized statement (≤160 characters). Contact commands, instruction-like input, identifiers containing digits/email syntax and reported-person inputs are excluded. No profile/contact information is supplied. Prompts and transcripts are not added to diagnostics or persistence.

The output must be one JSON object, ≤180 characters, with exactly:

- `state`: `OK`, `NOT_OK`, `UNCERTAIN`
- `context`: `fatigue`, `dizziness`, `discomfort`, `other`, `none`
- `concern`: `yes`, `no`, `uncertain`

Extra/duplicate keys, unknown values, invalid types, prose, fences and unsupported formatting are rejected. There are no explanation, diagnosis, severity, contact or authorization fields.

Application constraints are separate: AI OK never clears uncertainty. A NOT_OK suggestion needs `concern=yes`, independently present symptom vocabulary matching its category, and no conflicting negation/explicit uncertainty. `other`/`none` cannot ground NOT_OK. Deterministically clear meanings bypass the operation entirely. Accepted conservative advice produces wellness NOT_OK with `contactCall=not_requested`; a separate real human response to the contact offer is still required. The model never supplies consent, selects a contact or changes sensor severity/thresholds.

The existing 1.5-second native completion-operation deadline and five-second event availability budget apply. Load/inference/release use one serialized lease, and text is not usable until safe release completes. Release failure retains quarantine and fallback behavior. Each eligible operation verifies the actual artifact at event time; no dashboard-readiness shortcut was introduced. There is no new warm cache or repeated model loop. A semantic result whose statement cannot safely support empathy does not force another model inference.

## Contextual empathy

Complete natural first-person reports may canonicalize repeated intensifiers, limited fillers and punctuation into the existing bounded feeling representation. Unknown clauses, instructions, negation and unsupported symptoms remain excluded. Spanish feeling/gender is retained. “No me siento muy bien” maps to the existing unwell/mal acknowledgment contract. Clear long-day OK reports can receive a short deterministic acknowledgment without unnecessary model use.

The exact closed output grammar, one-sentence limit, size limit, language validation and deterministic fallback remain authoritative. No medical advice, invented symptom, general dialogue, safety instruction or contact promise becomes acceptable. Prompt/model configuration is unchanged; eligibility expands only where the same strict validator remains enforceable.

Fresh eligible NOT_OK empathy now runs during immediate mandatory guidance instead of being consumed at once. It can therefore contribute before the later acknowledgment segment. It is still a ready-only read after guidance, with no inference wait. This is a **confirmed code opportunity and mocked integration result**, not a claim that the physical GGUF accepted an output in this revision.

## Sentence plan, audio and display

One coordinated plan plays the deterministic mandatory prefix first, then a ready validated acknowledgment (or localized fallback), then the contact question. This ordering deliberately preserves immediate guidance: it cannot put fresh Gemma empathy first without waiting. Urgent/direct-request/missing-contact branches retain their exclusions. Required 911 wording is preserved once; nothing is removed to shorten the example.

Each sentence has its own sequential `speak` call and controller-created bubble. The contact offer remains intact even if a saved name includes an abbreviation such as “Dr. Rivera.” Initial questions/clarifications and reassurance also use sentence boundaries. No extra listening occurs between utterances. The contact question receives its own capture scope; empathy is spoken before that scope opens, so it cannot create premature contact consent. Existing microphone-free prewarming runs before the relevant prompt; capture begins only after actual final playback completion.

The production audio adapter requests a 120 ms pause between sentence utterances, checked against cancellation ownership. Actual TTS completion callbacks remain authoritative; no word-count timing estimate, microphone interruption, new audio-session category, duplex or aligned-session experiment was introduced. Scheduler/voice pacing still requires device testing.

The recently corrected compact header, single scroll view, keyboard avoidance, message accessibility and history-review behavior remain intact. Displayed sentence text is the text submitted to TTS; the existing 911 pronunciation expansion remains unchanged.

## Driver-language presentation scope

Conversation state snapshots the selected VoiceCheck language. A temporary `VoiceCheckLanguageScope` wraps the active Sensi UI (and CORE VoiceCheck fallback), covering status, captions, typed controls, handoff/completion messages and response buttons. It does not write the driver's preference, the independent app-language preference or the global alert language. Generated/typed driver statements stay raw. Button-generated driver replies now use the selected VoiceCheck language. Saved contact names remain unchanged.

Speech and acknowledgment validation already use the selected language; UI translation is not used to repair invalid model text. The native iOS phone confirmation uses the device/system's language and remains outside the app's localization control.

## Diagnostics and physical measurements

The existing explicit opt-in, bounded RAM-only Debug recorder is reused. New records include:

- `VoiceCheck semantic eligibility`: capture ID, final/eligible decision and deterministic outcome.
- `Gemma semantic assistance`: attempted/completed, structured acceptance/rejection, candidate enum/category, timeout/unavailable fallback and elapsed event times.
- Existing `Gemma event model lifecycle`: actual loaded/readiness state and completion-operation milliseconds, shared by empathy/semantics.
- `VoiceCheck semantic decision`: final application outcome and coded `grounded_caution`, `advice_not_sufficient` or `unavailable_or_not_ready`.
- `Sensi sentence response plan`: fixed segment roles and language.
- `Sensi sentence playback`: per-utterance started/settled status and elapsed completion time.

Native/adapter presence/status records and existing acknowledgment-source records remain available. No transcript, prompt, generated prose, contact or audio is added to these records. The recorder's deduplication and capacity remain unchanged; export a single check at a time.

There is **no explicit added inference wait** in the workflow. This does not prove zero physical latency: CPU/memory contention, verification/load time, model output acceptance and TTS scheduling must be measured on an iPhone. Lifecycle elapsed times include verification/loading; `nativeMs` wraps the native completion operation from JS, not native CPU time or peak native memory. The semantic completed event includes cleanup/validation opportunity. Compare playback starts/completions and the application-decision point to see whether work overlapped and was usable. No new physical-device timings or acceptance rates are claimed.

## Files modified for this request

Production:
- `lib/voice/wellnessLanguage.ts` (new)
- `lib/voice/responsePlan.ts` (new)
- `lib/voice/intent.ts`
- `lib/voice/voiceCheck.ts`
- `lib/voice/speechIO.ts`
- `lib/assistant/safetySemantic.ts` (new)
- `lib/assistant/safetyAcknowledgment.ts`
- `lib/assistant/safetyConversation.ts`
- `modules/gemma-poc/controller.ts`
- `modules/gemma-poc/phone.ts`
- `lib/analysis/safetyController.ts`
- `lib/hooks/useDriveSession.ts`
- `lib/i18n/LanguageProvider.tsx`
- `lib/i18n/catalog.ts`
- `components/SensiSafetyConversation.tsx`
- `components/DriveView.tsx` (active VoiceCheck language scope/hint only)

Tests:
- `tests/naturalLanguageSafety.test.ts` (new)
- `tests/voiceCheckLanguageScope.test.ts` (new)
- `tests/automaticMonitoring.test.ts`
- `tests/contextualAcknowledgment.test.ts`
- `tests/conversationalRefinement.test.ts`
- `tests/phase2aIntegration.test.ts`
- `tests/monitoringHook.test.ts`
- `tests/safetyConversationUI.test.ts`
- `tests/safetyConversation.test.ts`
- `tests/sensiGemmaIntegration.test.ts`
- `tests/voiceCheck.test.ts`
- `tests/voiceCheckReliability.test.ts`
- This report (new).

Earlier uncommitted UI, demonstration preference and phone handoff work remains preserved. No native Swift, sensor thresholds, Supabase schema/RLS, hardware protocol, model configuration or IPA configuration changed. The existing native phone implementation and one-use consent/authorization pipeline remain intact.

## Validation

TypeScript passed. Full `npm test`: **773 passed, 0 failed**. Model/audio/phone integration tests use mocks; they are not physical GGUF or recognition measurements. Existing emergency isolation, persistent preference, English/Spanish recognition, model-release failure, cancellation, native speech synthetic tests and output-contract regressions passed. Updated prior utterance-count assertions now reflect sentence playback; new tests assert exact ordered sentences, no duplicate guidance/offer, no overlapping capture, and consent independence.

Unsigned iOS Debug build passed. Release iOS JS export passed. Bundle inspection confirmed new semantic eligibility/decision, semantic-assistance, sentence-plan/playback diagnostics and timing-capture controls absent. Production semantic functionality remains included. `git diff --check` passed. No dependencies installed, commit, push, reset or unrelated overwrite performed.

## Physical-iPhone verification

1. Install/reload the current Debug application while parked. No new native dependency or migration is required. Leave real-contact demonstration OFF for language/model tests. Enable the existing timing capture in Developer Tools and clear older records.
2. English: “No, I'm feeling really really tired,” “I'm okay, but I'm dizzy,” “I'm exhausted,” “I'm good, I just had a long day,” and “I don't know, something feels off.” Verify expected NOT_OK/OK/clarification, sentence bubbles, one mandatory instruction of each kind, natural pacing, and capture only after the contact question completes.
3. Spanish: “No, estoy muy muy cansada,” “Me siento muy muy cansada,” “Sí, estoy bien, solo cansada,” “Estoy bien, pero me mareo,” and “No sé, me siento rara.” Inspect the actual finalized punctuation before judging negation behavior. Verify all app statuses/buttons/input/completion text and TTS follow the driver language while ordinary Settings retains its independent interface language. Names such as Mom must stay Mom.
4. To exercise semantic assistance rather than clear-case bypass, use an actually finalized ambiguous fragment such as “fatigue this evening” or “cansancio,” then allow the existing clarification. Inspect eligibility, attempt, actual readiness, structured validation and application decision. If the model rejects/fails/times out, safe clarification/escalation is expected. Do not count skipped work or mocked output as successful GGUF participation.
5. For empathy, inspect source after guidance: accepted Gemma output versus invalid/not-ready/unavailable fallback. Record load/readiness elapsed time, completion-operation milliseconds, completed-after-cleanup time, first guidance start and acknowledgment start. Report English and Spanish acceptance separately. Repeat missing-model/offline, cancellation and interruption; guidance/manual controls must continue.
6. Verify scroll to first/last messages, manual history review while sentences arrive, large text, VoiceOver and keyboard opening/closing. No forced jump away from reviewed history.
7. Only with a consenting saved contact, enable the persistent real-contact demonstration preference. Confirm a fresh run still requires explicit finalized consent to the specific contact offer and reaches the native iOS confirmation once. Cancel the OS prompt unless a call is planned. Repeat refusal, partial recognition, background/cancellation, driver/contact changes and preference OFF. Simulated data must remain unsaved/unlearned; ordinary simulations must remain noncalling.

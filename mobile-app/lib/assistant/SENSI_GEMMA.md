# Sensi: bounded context-aware Gemma acknowledgments

Gemma 3 270M Instruct QAT Q4_0 uses the existing pinned llama.rn runtime, native
SHA-256 verification, approved artifact and serialized process-wide controller.
Onboarding startup policy, speech recognition, prewarming, consent and IPA
configuration are unchanged. Runtime inference never downloads a model.

## Event flow and ownership

Sensor frames → FlagEngine → SafetyController → VoiceCheck remain authoritative.
Inference starts only after deterministic NOT OK interpretation, during mandatory
safety guidance playback. Only nonurgent cases proceeding to a saved-contact offer
are eligible. OK, silence, urgent/emergency-services answers, direct contact
requests and unavailable contacts skip inference. Omitted/unsupported statements
and buttons also skip native loading and generation. Buttons supply no statement;
voice supplies only successful final capture-scoped evidence; typed input remains
explicit manual evidence. No advisory intent classification was added.

The immutable request contains event category, fixed NOT OK outcome, VoiceCheck
language and an eligible whole first-person feeling report. The model prompt uses
only the extracted, authorized feeling, not the original first-person quotation. Unknown,
quoted, negated, identifying, action-bearing or instruction-like statements are
omitted. No measurements, profile, contact names/numbers, history or identifiers
are included. The accepted English and Spanish report patterns are in
`lib/assistant/safetyAcknowledgment.ts`.

Mandatory guidance starts immediately and is unchanged. At its completion,
VoiceCheck consumes the model result synchronously once, with no wait. Valid
empathy prefixes the existing deterministic contact-offer utterance; no extra
speech turn is added. The offer/retry wording and all consent rules remain fixed.
A failed guidance playback cancels unused inference and omits empathy. Missing,
invalid, unavailable or late results use fixed localized empathy. Cancellation or
loss of episode ownership prevents publication into later episodes.

Generated speech uses a closed single-sentence empathy grammar with three
second-person reflection forms in the selected language. The localized prompt
shows one sentence form without candidate lists, JSON arrays or driver-role text.
Two-sentence combinations are no longer allowed. The exact-match validator itself
is unchanged: case-sensitive matching after outer whitespace trimming, at most
180 characters and 24 whitespace-separated words, with no internal line breaks.
Wrong language, invented feelings, questions, instructions, medical claims,
action promises and any extra prose still fail validation. No output is repaired,
split or stripped of quotation marks to make it acceptable.

Generation remains greedy with a 1.5-second inference deadline and a five-second
overall availability budget. Context capacity is 1024 tokens and output is capped
at 64 tokens to accommodate Spanish and the bounded prompt. These are configured
limits, not measured iPhone performance. Stop/release ownership remains serialized;
no timeout force-unlocks native resources. Model disposal finishes before the
provider publishes its result, so its cost is included in the availability window.

## Validation status

`tests/fixtures/safetyAcknowledgment.ts` supplies English and Spanish prompt/output
fixtures. They are hand-authored mocked outputs, not recorded GGUF completions.
Automated tests verify context preservation, grounded grammar, failure/timeout,
late/cancelled output, unchanged guidance and consent, and replacement-episode
isolation. User-reported Phase 1B physical-iPhone results were 12 completed
inferences, zero accepted outputs, approximately 349 ms average inference and
609 ms combined lifecycle, with 12 successful releases. Those are baseline
measurements supplied by the user, not measurements of this refinement. The new
prompt has not yet been evaluated on the physical GGUF. Production-quality bilingual generation is
**not established**; valid Spanish output is supported with deterministic fallback.

See `modules/gemma-poc/PROMPT_REFINEMENT.md` for root-cause evidence and the
same 12-case diagnostic rerun procedure.

On a physical iPhone, use existing isolated warning simulations with an installed
model, a configured contact and the selected spoken language. Try each fixture
statement and button/typed equivalents. Record model versus fallback source,
cold-load/inference/release timing, validation acceptance and complete spoken text.
Mandatory guidance must begin before empathy and remain unchanged. Test unavailable
model/voice, incomplete recognition, background/cancel, profile changes and repeated
episodes in airplane mode. Simulations must never open the saved-contact dialer or
persist/learn incidents. Do not bypass simulation guards for model evaluation.

## Responses and legacy paths

Voice, typed Send, and buttons converge on the same VoiceCheck question and intent
policy. Voice still requires successful final capture-scoped recognition. Typed
input needs the rendered episode ID, question and capture ID; it cannot replay a
wellness response as contact consent. The first winning response cancels audio;
duplicates and stale results are rejected. Typed authorization is separate explicit
manual evidence, never fabricated speech finality or model output. There is no
typed input outside a safety check. Prefer voice while driving; type only when safe.

The launcher preserves its layout and opens Sensi standby, or retains an existing
safety conversation. Standby reports sensor, voice, and model-file readiness without
starting monitoring, requesting permissions, hashing/loading Gemma, or exposing
message input. Model presence does not imply verified runtime readiness. Settings
remains an independent tab; model/legacy Connected readiness cannot block viewing
Sensi. Standby and the Gemma safety thread share one native modal host. Post-OK
ordinary-chat continuation is disabled.
Stage 2B removes provider selection and Apple/OpenAI inference from application
code. Sensi always uses Gemma with deterministic fallback; persisted legacy mode
settings are ignored. Shared native speech/playback remains. Historical adapters
are test fixtures only; Advanced Gemma and voice diagnostics stay development-only.
On Android, lack of on-device recognition preserves the manual response window
instead of enabling server recognition. Existing system TTS/voice selection and
audio preemption remain in use.

## Physical validation

Use the installed, verified model; no new download is needed. Sensi uses Gemma automatically. Trigger the existing high/low/oxygen demo or a real confirmed sensor
event. Say `I'm dizzy` and verify empathy, deterministic stopping guidance, and the
captured contact offer without extra symptom/parking questions. Test typed and
button replies separately. Decline a contact offer and verify no phone opens.
Demos and Settings rehearsals never open the dialer, even with consent; they show
a simulation-complete message. Only real sensor events can validate explicit
consent and the iOS phone handoff.

Repeat in airplane mode, with an immediate button answer (may use fallback), an
unavailable model/voice, cancelled capture, backgrounding, and driver/session
changes. Check no duplicated speech or stale handoff occurs. No native rebuild
is needed if the current app already contains the verified llama.rn and native
SHA-256 modules; load the updated Metro bundle after stopping the previous app.
Android model/speech/TTS behavior and integrated iPhone behavior still require
physical validation. Phase-1 isolated inference timings do not validate phase 2.

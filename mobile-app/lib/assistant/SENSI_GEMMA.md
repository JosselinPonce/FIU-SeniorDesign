# Sensi phase 2: event-only Gemma empathy

Gemma 3 270M Instruct QAT Q4_0 uses the same pinned llama.rn runtime, native SHA-256
verification, approved model file, and process-wide controller as the diagnostic.
No runtime, model, download path, Supabase policy, auth flow, contact storage, or
native API was added for this phase. Provisioning is still an explicit development
action; a missing/corrupt model produces fixed empathy instead of a download.

## Event flow and ownership

Sensor frames → FlagEngine → SafetyController → VoiceCheck remain authoritative.
When an existing safety check starts, the optional Gemma request starts in parallel
with its wellness question. It receives only the fixed `concern_acknowledgment`
task and a two-string allowlist, never driver speech, symptoms, readings, profile
data, names, contact numbers, or actions. Initialization verifies the installed
model; inference has a 1.5-second budget and the overall warm request a five-second
budget. No response handler awaits either budget or model readiness.

After deterministic interpretation of a NOT OK answer, VoiceCheck synchronously
reads the selection if already ready. Only `I'm sorry to hear that.` and
`I hear you.` are permitted in English. Spanish uses reviewed fixed empathy.
Invalid/missing/late output immediately falls back to fixed text. Late results
cannot add speech, ask questions, resolve incidents, make offers, or authorize
calls. Urgent instructions precede empathy; ordinary stopping guidance follows
the short acknowledgment. Contact offers and any saved contact label come from
deterministic code and the captured authorized profile, never Gemma.

The optional request cancels on consumption, deadline, check/session/profile
cancellation, or backgrounding. The shared controller enforces one native operation
and retains ownership until native completion/stop/release. Busy diagnostics or
unavailable hardware cause immediate fallback; safety never waits for their cleanup.
Model resources are released after the selection task, not retained through a drive.
The development safety thread shows `Acknowledgment: Gemma selection` or
`deterministic fallback` for physical validation; this is not persisted or consent.

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

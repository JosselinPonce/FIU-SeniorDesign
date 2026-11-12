# Safety Testing and Sensi refinement

## Inspection before behavior changes

`VoiceCheck.run` previously called `announce(t.notOk)` then `ask(empathy + offer)`. These are two awaited TTS operations and two assistant messages from the controller's `io.speak` wrapper. The mandatory text (including 911) is deterministic. The offer is deterministic and uses the validated saved contact name. `approvedAcknowledgment` permits only its existing grounded grammar, otherwise fixed generic empathy.

The quoted historical response cannot prove model execution. The exact statement “No I'm feeling a little tired.” does not match the conservative whole-statement eligibility regex, so it would skip inference and use generic empathy on this source. This filter is unchanged. Actual past execution requires logs from that build/run.

`SettingsView` captures the default-off per-run real-contact switch when a scenario starts and forwards it through `useDriveSession.simulate` to `SafetyController.simulate`. The controller binds intent to owner/generation/profile/revision/contact. Only explicit deterministic consent creates a 30-second, one-use permit and `pendingDemoContact`. `RealContactDemoConfirmation` then requires a fresh named Alert confirmation; the platform independently checks active iOS/current screen/no recording before the existing `tel:` handoff. Ordinary simulations return `handoff=simulated`. The reported “would open” message was used for both opted and ordinary simulations, so it does not establish absence, expiry or revocation of opt-in. No historical authorization failure has been proven; no authorization bypass or speculative lifecycle fix is made.

## Implemented behavior

- Safety Testing is the first action under Health & Safety, above Safety checks and calibration.
- Fictional-number UI and its obsolete localized copy are removed. Native saved-contact handoff is unchanged. Isolated low-level fictional adapter tests remain unreachable from UI.
- Before starting, Safety Testing explicitly identifies a noncalling versus real-contact run. The active simulation retains that label. Pending confirmation has accurate completion copy rather than the ordinary “would open” message.
- Nonurgent NOT OK + contact offer uses one `ask` call: available validated empathy, unchanged mandatory instructions, then one contact offer. No separate mandatory-guidance TTS operation precedes it. Retry remains a distinct interaction. Urgent/911/direct-request/no-contact branches retain standalone mandatory instructions and existing authorization behavior.
- The user explicitly selected immediate guidance over waiting for Gemma. Composition snapshots an already-ready acknowledgment only. Fresh asynchronous event inference is normally consumed/cancelled before it starts; it must NOT be described as Gemma-powered empathy. There is no new wait, cache, partial-transcript promotion, broader eligibility, prompt or validator change. A ready result can still be used by the bounded adapter, and tests distinguish that prepared mocked case from fresh production inference. Obtaining fresh Gemma text in the same immediate utterance would require a separately approved latency or playback design.
- Conversation rendering uses the same text submitted to TTS; prior conversation messages are retained.

## Local Debug runtime evidence

Enable the existing opt-in timing capture under Settings → Advanced Settings → Developer Tools. Begin capture, run one simulation, stop/export the timing snapshot using the existing controls. No raw driver text, generated text, prompt, health details or contact is added.

Look for `Gemma contextual acknowledgment`: eligibility; inference attempted or inference skipped (`consumed_before_start`); completion acceptance or `output_contract_rejected`; unavailable/lifecycle failure; timeout; selection source/fallback. Elapsed event times measure approximate adapter duration, not isolated native inference time. `Gemma event model lifecycle` reports actual loaded/readiness state only if model work starts. `Sensi acknowledgment selection` correlates selection to the wellness capture ID. `Sensi response composition` identifies the subsequent contact-offer response as `ready_only`. A skipped attempt must not be counted as model participation. A missing event is not evidence that inference happened. Diagnostics use the existing opt-in bounded RAM recorder and Debug guard; no diagnostic controls are added to Release.

## Physical iPhone verification

1. Rebuild/install Debug if the current installed bundle is old; no new native dependency or Swift change is required. Enable timing capture before the run. Test while parked, with a consenting participant as the saved contact.
2. Health & Safety: Safety Testing first; thresholds/calibration remain accessible. No fictional calling UI anywhere in Settings or the safety modal.
3. Leave real-contact off. Start a warning; answer NOT OK, then yes. Observe explicit noncalling label and no confirmation/handoff.
4. Turn real-contact on for a new run; verify saved contact, answer NOT OK, then give finalized explicit yes (repeat with typed/buttons). Expect one combined nonurgent response containing all mandatory instructions, then Listening after playback. A fresh named confirmation must appear. Confirm only to inspect the existing iOS phone handoff; cancel the system prompt to avoid an unexpected call.
5. Repeat in Spanish; verify saved name, mandatory Spanish guidance, one offer, correct recognition/TTS language, and the same authorization gates.
6. Repeat refusal, ambiguous response, recognition failure, cancellation/background, expired confirmation, changed profile/contact and missing/invalid contact. None may grant a stale handoff. Simulated measurements must not appear as saved incidents/readings or threshold learning.
7. Inspect timing export: ready-only fallback is expected for fresh event work. Do not report accepted GGUF inference or physical call success from mocked tests. Physical verification of these changes remains outstanding.

## Files changed for this refinement

Production/UI: `components/SettingsView.tsx`, `components/SensiSafetyConversation.tsx`, `lib/assistant/safetyConversation.ts`, `lib/assistant/safetyAcknowledgment.ts`, `lib/analysis/safetyController.ts`, `lib/voice/voiceCheck.ts`, `modules/gemma-poc/phone.ts`, `lib/i18n/catalog.ts`. Removed obsolete `components/EmergencyDialerDemo.tsx` and its UI-specific `tests/emergencyDialerDemoUI.test.ts`; the low-level fictional adapter isolation tests remain.

Tests updated: `tests/automaticMonitoring.test.ts`, `tests/contextualAcknowledgment.test.ts`, `tests/conversationalRefinement.test.ts`, `tests/monitoringHook.test.ts`, `tests/phase2aIntegration.test.ts`, `tests/safetyConversationUI.test.ts`, `tests/sensiGemmaIntegration.test.ts`, `tests/settingsNavigation.test.ts`, `tests/voiceCheck.test.ts`. Added `tests/sensiRuntimeDiagnostics.test.ts` and this report. These changes sit on top of preserved uncommitted UI work; the complete git diff also includes that earlier work.

## Validation

- TypeScript: passed.
- Targeted integration/UI/authorization run: 94 passed; final full suite includes subsequent runtime-diagnostic and urgent-branch coverage.
- Final full suite: 696 passed, 0 failed. All model, recognition, TTS and phone fixtures are mocked; these are not physical GGUF or microphone results.
- Release iOS JS export: passed. Bundle inspection confirmed all four new diagnostic operation labels, skipped-inference reason, timing-capture control, fictional handoff control and displayed fictional number absent. Safety Testing and real-contact confirmation remain included.
- Unsigned Debug iOS build: passed. No Swift/native implementation or dependency changes; no IPA/archive/device validation claimed.
- `git diff --check`: passed. No commit/push/reset performed. Existing unrelated uncommitted work retained.

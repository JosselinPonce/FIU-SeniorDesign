# Phase 2D — Sensi conversational refinement

## Production audit and selected scope

`useDriveSession` feeds accepted sensor frames into `SafetyController` and the deterministic flag engine. Thresholds, sensor quality/continuity, sustained readings, and episode ownership determine the safety event. `runCheck` captures the episode/profile/session provenance and supplies `phoneSensiVoiceIO` to `VoiceCheck`. Sensi's conversation mirrors that check; it is not another recognition loop or AI interpreter.

`VoiceCheck.ask` registers the capture, prewarms through the existing phone adapter, speaks the deterministic wellness question, and listens after successful playback. Only current genuine final evidence (or scoped typed/button input) enters deterministic wellness interpretation. An unclear answer gets one retry. Incomplete/error recognition preserves manual input; two unconfirmed answers select the existing no-response escalation. These paths and diagnostics remain unchanged apart from the wellness retry copy described below.

For eligible nonurgent NOT OK, the existing implementation already:

1. Starts bounded contextual Gemma work after the finalized driver statement. The eligibility filter passes only minimal explicitly reported feelings; button-only or unsupported statements cannot gain invented personalization.
2. Immediately speaks the fixed pull-over/emergency guidance while inference runs. There is no wait for Gemma.
3. At guidance completion, consumes an available strictly validated acknowledgment or its deterministic fallback. Late inference cannot publish another turn. The existing five-second acknowledgment window and serialized load/release lifecycle remain unchanged.
4. Combines that one acknowledgment and the deterministic contact offer into **one** playback/answer turn. It does not add an empathy-only speech turn. Selected contact naming is validated and does not let the model choose a contact.
5. Requires explicit final/button/typed consent to the contact question or an existing explicit driver request, followed by controller provenance/live-session checks. Opening the phone interface does not establish a connected call. Simulation/rehearsal remains isolated; the fictional demo requires its own separate fresh confirmation.

Urgent, emergency-services, missing-contact, failed-guidance, direct-request, cancellation, and stale-episode paths retain their existing exclusions. In particular, urgent/direct-request paths do not insert contextual empathy before handoff. Gemma never supplies safety guidance, severity, interpretation, contact selection, or consent.

### Message ownership and ordering

Deterministic messages include the abnormal-reading question, retry, OK response, nonurgent/urgent/no-response guidance, contact offer/retry, and final handoff/simulation UI. Gemma can supply only the allowlisted one-sentence acknowledgment, with a fixed fallback if unavailable or invalid. The product's protected mandatory guidance remains exactly:

- English nonurgent: “Please pull over as soon as it is safe. If you need emergency help, call 911.”
- Spanish nonurgent: “Por favor detente cuando sea seguro. Si necesitas ayuda de emergencia, llama al 911.”
- English urgent: “Pull over as soon as it is safe and call 911 now.”
- Spanish urgent: “Detente en cuanto sea seguro y llama al 911 ahora.”

No-response escalation copy also remains unchanged. These are code/product safety requirements; this inspection does not establish a statutory requirement for any exact phrase.

Mandatory guidance remains a separate speech turn and bubble: merging it with an acknowledgment generated concurrently would either wait for Gemma, omit context before it finishes, or change the established ordering. No such playback change was made. The existing `speak` promise and single owned sequence already coordinate the acknowledgment-plus-offer safely. No duplicate empathy speech turn was found. Routine completed-playback labels and the long retry were avoidable presentation/copy overhead.

## Exact improvements

- English retry: **“I didn't catch that. Are you feeling okay? Say yes or no.”**
- Spanish retry: **“No te entendí. ¿Te sientes bien? Di sí o no.”**
- The retry repeats neither the driver's name nor the sensor explanation. Initial prompts, recognition hints, supported response interpretation, attempt counts, and timing are unchanged.
- Sensi contact actions now read **“Yes, open phone” / “No, thanks”**, localized as **“Sí, abrir teléfono” / “No, gracias”**. They invoke the same scoped call_yes/call_no handlers; the label does not itself authorize a handoff. Wellness actions are unchanged.
- The safety conversation opts into compact playback presentation: successful bubbles no longer display “Playback completed.” Pending/playing, failed and interrupted labels remain available. Mandatory guidance and the subsequent acknowledgment/offer remain distinct bubbles. Playback metadata is untouched, and other thread consumers retain their existing labels by default. The native/Debug diagnostic instrumentation is unchanged.

The device-tested Gemma prompt, closed output validator, candidates, deterministic empathy fallback, generation limits, model and readiness checks remain unchanged. The current acknowledgment already reflects only the explicit eligible feeling, including Spanish gender only when reported in the statement. No gender is inferred from a profile or name. A stylistic prompt change would require renewed actual GGUF validation without a demonstrated benefit here.

### Resulting example (existing playback order preserved)

Driver: “I'm dizzy.”

1. “Please pull over as soon as it is safe. If you need emergency help, call 911.”
2. “I'm sorry you're feeling dizzy. Would you like me to call Mom?”

Driver: “Me siento mareada.”

1. “Por favor detente cuando sea seguro. Si necesitas ayuda de emergencia, llama al 911.”
2. “Lamento que te sientas mareada. ¿Quieres que llame a mamá?”

These examples use outputs already accepted by the strict validator; they are not newly measured device generations. If Gemma is late/unavailable/invalid, the second turn immediately uses “I'm sorry to hear that.” or “Lamento que te sientas así.” with the contact question. There is no additional waiting or speech turn.

## File manifest

- `lib/voice/voiceCheck.ts`: bilingual wellness retry copy only in this phase.
- `lib/assistant/safetyConversation.ts`: concise contact action labels.
- `lib/assistant/threadPresentation.ts`: optional compact completed-label suppression, default unchanged.
- `components/SensiConversationThread.tsx`: optional compact playback prop; omit empty status labels.
- `components/SensiSafetyConversation.tsx`: opt the safety thread into compact playback.
- `lib/i18n/catalog.ts`: new action/retry translations; prior translations retained.
- `tests/safetyConversation.test.ts`: expected contact label updated.
- `tests/conversationalRefinement.test.ts` (new): 14 focused regressions.
- This report.

Other uncommitted changes, including earlier Phase 2C diagnostic work, were preserved. A repository-wide diff contains earlier work and is not this phase's manifest.

## Validation

- Relevant conversational, acknowledgment, integrated phone/controller, UI, localization and simulation tests: **78 passed, 0 failed**.
- Full suite: **657 passed, 0 failed, 0 skipped** (643 baseline plus 14 new tests).
- TypeScript (`tsc --noEmit`): passed.
- `git diff --check`: passed.
- Debug and production Release iOS/Hermes Expo exports: passed. These validate JavaScript bundling, not native signing/linking or IPA installation. No native code was changed or recompiled for this copy/presentation phase.
- New tests cover bilingual guidance-first ordering, inference overlap/no extra empathy turn, ready/late/invalid/unavailable mocked output, exact protected nonurgent guidance, concise retry semantics, cancellation during guidance, declined consent, localized action labels, retained failure/interruption labels, separate displayed guidance/offer, immutable playback metadata, and unchanged default diagnostic thread labels. The full existing suite also covers explicit/live authorization, urgent paths, typed/buttons, rehearsal/demo isolation, stale capture, strict model validation and diagnostics.
- Model outputs and audio/recognition in automated tests are mocks. No physical-iPhone conversational quality or new real GGUF acceptance result is claimed. No dependencies installed, commits or pushes; no Supabase/RLS changes.

## Physical-iPhone validation still needed

1. Use the updated Debug build/JavaScript and the approved installed model. Keep existing recognition/prewarming/session setup and aligned-session experiments unchanged. Test while parked, outside a drive. Do not reset permissions or treat a known intermittent recognition failure as a conversational regression without the existing capture chain.
2. Settings → Health & Safety → Try the voice check: use synthetic eligible English and Spanish NOT OK statements. Verify numeric 911 remains visible, mandatory guidance plays first without waiting, then exactly one acknowledgment/contact-question turn. Listen for natural cadence between separate turns; no new pause or audio overlap should be introduced.
3. Test unavailable/late model behavior through existing safe fixtures or a disposable test container. Confirm fixed guidance starts immediately and fallback/offer follows without waiting or a late additional turn. Do not damage the primary tester's model merely to create a failure.
4. Check “Yes, open phone” / “No, thanks” and Spanish equivalents. Rehearsal consent must remain simulated, with no live phone opening. The fictional dialer demo still needs its own fresh confirmation. Do not use live emergency calling to validate copy.
5. Exercise an unclear answer and verify the shorter retry; exercise typed/buttons and cancellation during guidance. Confirm known NOT OK is preserved when follow-up audio fails.
6. Confirm safety guidance and the contact offer stay in separate readable bubbles; successful playback labels are absent in the safety thread; failure/interruption labels and existing capture diagnostics remain available. Check both app-localization and selected VoiceCheck-language settings.
7. Verify the same copy/presentation in Release, with Debug tools absent. If recognition fails again, enable the existing Debug capture correlation and export one failing capture immediately. This phase does not claim to fix intermittent recognition.

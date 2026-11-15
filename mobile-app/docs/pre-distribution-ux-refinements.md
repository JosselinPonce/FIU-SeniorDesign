# Pre-distribution UX refinements

Base checkpoint: `c5655837bb220108a250cacd90eff1ffad8e3ec0` on
`samantha/claude-remediation`. Changes remain uncommitted for review.

## Standalone VoiceCheck Testing

Route: Settings → Health & Safety → Safety Testing → VoiceCheck Testing.
This is a user-invoked, clearly labeled diagnostic screen, including in Release;
it is distinct from the existing Debug-only developer diagnostics.

`VoiceCheckDiagnostic` accepts a deliberately narrow I/O interface. It uses the
same deterministic `understand` boundary and fixed guidance plan, but never
constructs VoiceCheck episodes, supplies a sensor event, consults Gemma, offers
contacts, writes driver state, calls a dialer, or accesses Supabase. Results expose
only OK/NOT_OK/UNCERTAIN, urgency and a response preview. They are not production
wellness results or action permits. Recognition language is local UI state;
selecting it does not update driver preferences. Raw transcripts remain in memory
only. Partial/error/stale/mismatched/offline-invalid recognition cannot establish
an interpretation. Typed input explicitly invokes the same interpreter.

The phone adapter uses the existing offline native recognition bridge with unique
capture IDs, exact requested locale and matching progress subscriptions. Permission
and asset failures retain typed input. Spanish availability depends on supported
iOS/device assets; the UI reports capability without claiming microphone success.
The optional spoken preview uses an installed system voice for the test language;
it does not replace the production saved voice preference.

Capture and preview acquire optional app-audio ownership. Production safety can
preempt them. Cancellation targets only the active diagnostic operation and waits
for native work and cancellation cleanup before release. Preview waits for system
speech to drain. Late progress/final output, backgrounding, blocking production
work, disposal and obsolete playback cancellation cannot publish a new result or
stop a later owner. Native cleanup that does not settle retains audio ownership;
it must not be treated as successful cleanup just because a timer elapsed.

## Simulation progress

`SimulationProgress` renders the existing `sf.demo` object: SIMULATED label,
elapsed simulated seconds, changing BPM or oxygen percentage, and engine phase.
It predicts no countdown and changes no simulation/controller/live-sensor logic.
The existing explicit real-contact-demo preference and fresh consent/confirmation
boundaries are unchanged. Diagnostic testing itself has no contact capability.

## Fallback, interpretation and controls

The deterministic acknowledgment fallback is now “Thank you for telling me.” /
“Gracias por decírmelo.” Contextually grounded Gemma acknowledgments remain
validated by the existing closed grammar. Eligibility, immediate mandatory
instruction ordering, urgent handling, consent and cancellation are unchanged.
Older translation entries are retained for compatibility with existing copy.

Only the complete English first-person affirmation grammar may treat a leading
conversational no as discourse: No im okay / No I'm good. This does not allow bare
no good, negated wellness, unknown trailing clauses or conflicting symptoms to
clear as OK. Existing Spanish punctuated affirmations remain supported;
unpunctuated no estoy bien / no me siento bien remain negative, not discourse.
The interpreter's final symptom/ownership/urgency vetoes still apply.

The Sensi transcript and response composer are separate sibling scroll areas.
The composer remains outside transcript scrolling, with a bounded height and its
own overflow scrolling for large text/small screens. The existing keyboard-aware
modal, scoped buttons and explicit Send behavior remain in place. Native visual
geometry still needs physical-device verification.

## Changed files

Production/UI:
- `components/VoiceCheckTesting.tsx` (new)
- `components/SimulationProgress.tsx` (new)
- `components/SettingsView.tsx`
- `components/SensiSafetyConversation.tsx`
- `lib/voice/voiceCheckDiagnostic.ts` (new)
- `lib/voice/phoneVoiceCheckDiagnostic.ts` (new)
- `lib/voice/wellnessLanguage.ts`
- `lib/ui/simulationProgress.ts` (new)
- `lib/ui/settingsNavigation.ts`
- `lib/assistant/safetyAcknowledgment.ts`
- `lib/i18n/catalog.ts`

Tests:
- `tests/preDistributionUX.test.ts` (new)
- `tests/phoneVoiceCheckDiagnostic.test.ts` (new)
- `tests/settingsNavigation.test.ts`
- `tests/safetyConversationUI.test.ts`
- `tests/contextualAcknowledgment.test.ts`
- `tests/conversationalRefinement.test.ts`
- `tests/gemmaContextualDiagnostic.test.ts`
- `tests/gemmaPromptContract.test.ts`
- `tests/phase2aIntegration.test.ts`
- `tests/sensiGemmaIntegration.test.ts`
- `tests/sensiRuntimeDiagnostics.test.ts`
- `tests/spanishGemmaPrompt.test.ts`

Existing fallback assertions were updated to the requested neutral copy. UI
fixtures now include the new child components and assert the requested composer
layout rather than the old transcript-footer layout. Existing safety assertions
and tests were retained. This report is the only documentation change.

## Physical-iPhone checklist

1. Open the diagnostic through the complete Settings route. Select English and
   Spanish independently of the driver's language. Verify permission denial,
   unavailable assets, final/partial transcripts, typed fallback and repeated runs.
2. Test No im okay / No im good, no good, no estoy bien, corrections and urgent
   symptoms. Check that displayed/spoken previews agree and no contact offer,
   dialer, incident persistence or uploaded event originates from the diagnostic.
3. Cancel during preparation, capture and playback. Exit, background and reopen.
   Confirm no late transcript or speech appears. Trigger a legitimate isolated
   safety simulation separately and verify diagnostic audio yields before safety.
4. Run warning/critical BPM and oxygen simulations. Observe elapsed simulated
   time, changing values and phases; live vital cards must remain separate.
5. In production VoiceCheck, verify neutral fallback and grounded acknowledgment
   in both languages, urgent guidance without empathy delay, and unchanged consent.
6. Scroll long conversations and open the keyboard at large Dynamic Type sizes.
   Confirm both buttons and typed Send remain accessible on a small iPhone.

No signing, installation, IPA distribution, commit or push is part of this work.

## Validation results

- 45 new tests; focused selection: 279 passed, zero failures.
- Full automated suite: 1,117 passed; zero failures, cancellations or skips.
- TypeScript and Git whitespace checks: passed.
- Release iOS JavaScript/Hermes export: passed for updated application source.
- Unsigned iOS Debug build: passed using the isolated, unchanged SDK 54 native
  workspace and derived data under `/private/tmp`. Only existing script-phase
  warnings were observed. No signing, device installation or IPA was performed.
- Every changed code/test file exactly matches its validated isolated copy.
- SHA-256 checks confirm unchanged native modules, dependencies/configuration,
  production VoiceCheck/controller/semantic lifecycle, local handoff and Git
  exclusion. The only interpretation adjustment is the requested bounded
  conversational-no grammar; empathy changes are presentation fallback only.
- HEAD and both protected branches are unchanged; staging area is empty.

Artifacts: `/private/tmp/drivesense-ux-refinement-4nlm263r`;
`/private/tmp/drivesense-ux-refinement-final-full.log`,
`/private/tmp/drivesense-ux-refinement-typecheck.log`,
`/private/tmp/drivesense-ux-refinement-final-export.log`, and
`/private/tmp/drivesense-ux-refinement-xcodebuild.log`.

These are automated and build results. Physical-iPhone geometry, microphone
capture, selected-language assets, interruptions and spoken playback remain
outstanding for these refinements. The diagnostic has no Gemma consult: its
UNCERTAIN result is the deterministic interpretation, not a replay of an entire
production safety conversation. Unsupported natural-language forms still clarify.
Ready for review and independent acceptance testing, with all changes uncommitted.

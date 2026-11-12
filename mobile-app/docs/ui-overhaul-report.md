# DriveSense UI/UX overhaul and Safety Testing integration

## Results by phase

- **0 — Audit:** `ui-overhaul-audit.md` records UUID/custom_id dependencies, canonical units, routes, foreground safety overlays, model/speech ownership and the real-contact approval boundary. The user approved Phase 5 before implementation.
- **1 — Profiles:** Subject ID removed from creation/editing/cards/confirmation. UUIDs, existing optional team labels, schema and cloud relationships remain intact; existing edits preserve custom_id and new UI-created profiles use null. The existing BMI formula and exact unit conversions are correct. The reported huge BMI could arise from implausible persisted measurements; no affected record was supplied, so its particular cause is unproven. A presentation-only guard returns unavailable for nonfinite/out-of-range inputs/results rather than displaying an implausible BMI. No health values are rewritten and profile personalization/threshold algorithms are unchanged. Driver confirmation now has initials, name, language, saved contact, direct Edit and one-shot Confirm & Continue.
- **2 — Navigation:** Shared non-scrolling ScreenHeader across profile/confirmation, Settings nested routes, Sensi standby, detailed vitals/history and Gemma diagnostics. Existing safe-area hosts, bottom tabs and routes retained. Header touch targets are at least 48 points; titles can wrap. Settings retains per-page scroll offsets and parent navigation while mounted; history retains list offset during detail navigation. Profile edit returns to the originating Settings page and Gemma returns to Developer Tools. Sensi's test action targets the single Safety Testing route, including repeated entry from an already-open Settings tab.
- **3 — Advanced:** Ordinary Advanced Settings links to the existing voice/language, monitoring, assistance, connectivity and privacy categories. Technical controls are inside a separate Debug-only Developer Tools route. Model recovery and advisory voice capability remain in production Sensi Settings. Timing recorder, actual Spanish capability/microphone diagnostics, English fixture and Gemma suite remain. Removed abandoned alignment controls and the redundant older multi-locale Spanish check from the UI only; working native/recognition infrastructure and current timing/result/shadow instrumentation remain intact.
- **4 — Safety Testing:** Simulate a Warning is first, with four unchanged scenario keys/semantics and warning/critical indicators. Technical simulation explanation is secondary. Threshold calculations/history and personalization are on Threshold details; oxygen/prototype caveats remain visible. The fictional-number practice is a separate secondary section.
- **5 — Approved real-contact path:** Explicit per-run opt-in names the valid saved contact and warns of a possible real call. The same separate simulation engine and deterministic VoiceCheck run; existing genuine final/button/typed contact consent is required. Consent prepares a 30-second final-confirmation opportunity, not a call. A separate fresh alert identifies the saved contact/number. A unique confirmation ID and private one-use permit gate the reused tel interface primitive. The platform also checks foreground, supported presentation, iOS and absence of recording/start-recording. Ordinary simulation/rehearsal remains noncalling. No fictional fallback is used for missing/invalid contact; Edit is offered.
- **6 — Sensi:** Reuses its steering-wheel glyph, short introduction/readiness and prominent Try a Safety Check. Fixed Back is outside scroll content. No chat input or unsolicited conversation was introduced. Mandatory guidance/acknowledgment/consent sequence and Gemma remain unchanged. Active safety actions can scroll on small screens while existing keyboard avoidance and voice-first behavior remain.
- **7 — Consistency:** Existing theme tokens/components, compact cards, native controls, wrapping text, safe-area hosts and English/Spanish catalog reused. No new dependencies or decorative animation system.
- **8 — Validation:** Results below. No device UX or real-call result is claimed.

## Real-contact authorization guarantees

The controller only prepares a permit after the existing VoiceCheck authorizes explicit contact consent/request for the opted-in simulation owner/generation. A public UI confirmation ID is distinct for each run; the permit itself stays private. It validates current profile ID/revision, unchanged normalized contact, generation, foreground/supported interaction, and no check/demo/recording before use. It can be claimed once, including under duplicate/reentrant UI actions.

The permit is revoked by background/unsupported presentation, cancellation, profile/contact changes, recording, new simulations/rehearsals, real warning/emergency events, dismissal or 30-second expiry. Opt-in UI resets after use, navigation or interruption. Old confirmations cannot authorize newer runs. New native handoff attempts fail closed for invalid numbers or failed guards. No speech partial or Gemma output can prepare or consume a permit.

The live `openAuthorizedPhoneInterface` still refuses demo/rehearsal provenance and simulated episode identities. The approved demo uses a separate guard and shares the same private `tel:` opening primitive; it does not broaden the live guard or introduce a direct-calling API. iOS/user confirmation remains. A resolved URL request never proves a connected call. Once a request is delivered to iOS, JavaScript cannot retract it; cancellation revokes future authorization, not an already-presented system action.

Simulated readings still use a separate FlagEngine and retain no fabricated incident saves, sensor uploads, learned baselines or acknowledgment adjustments. The implementation never automatically starts a phone request after silence, ambiguity, timeout, recognition failure, refusal or missing contact.

## Exact file manifest

Modified components:

- `components/DashboardAssistantEntry.tsx`
- `components/DriverConfirmation.tsx`
- `components/DriverPicker.tsx`
- `components/HistoryView.tsx`
- `components/ResponsivenessDiagnostics.tsx`
- `components/SensiSafetyConversation.tsx`
- `components/SensiStandby.tsx`
- `components/SettingsView.tsx`
- `components/SmartWheelScreen.tsx`
- `components/VitalsDetailView.tsx`

Added components: `components/ScreenHeader.tsx`, `components/RealContactDemoConfirmation.tsx`.

Modified logic/localization: `lib/analysis/safetyController.ts`, `lib/hooks/useDriveSession.ts`, `lib/i18n/catalog.ts`, `lib/ui/settingsNavigation.ts`, `lib/voice/phoneHandoff.ts`.

Added logic: `lib/ui/profileSummary.ts`, `lib/voice/realContactDemo.ts`.

Modified diagnostic presentation: `modules/gemma-poc/GemmaDiagnostic.tsx` (fixed header, same cleanup-before-return).

Modified existing tests: `tests/floatingSensi.test.ts`, `tests/localization.test.ts`, `tests/safetyConversationUI.test.ts`, `tests/sensiNavigation.test.ts`, `tests/settingsNavigation.test.ts`. Assertions were adapted for intended routes/labels and component stubs; live/simulation isolation tests were retained.

Added tests: `tests/profileSummary.test.ts`, `tests/realContactDemo.test.ts`, `tests/realContactDemoUI.test.ts`, `tests/screenHeader.test.ts`.

Added documentation: `docs/ui-overhaul-audit.md`, this report.

No native speech, model, dependency, database schema or Supabase RLS files changed. Pre-existing untracked archive and CLI cache files were left alone. No commit, push, reset or unrelated-file overwrite.

## Automated/build validation

- Full suite: **688 passed, 0 failed, 0 skipped** (666 baseline plus 22 new regressions).
- TypeScript (`npm run typecheck`): passed.
- `git diff --check`: passed.
- Debug and Release iOS/Hermes JavaScript exports: passed.
- Full unsigned Debug iOS app build: passed. No signed IPA/archive/install or device call was performed.
- Release bundle inspection: Safety Testing/real-contact review present; timing capture, alignment toggle and isolated Gemma diagnostic entry strings absent. Runtime Debug gates remain, including the Developer Tools route.
- New coverage exercises metric/imperial BMI and missing/invalid input, internal Subject ID preservation, accessible fixed headers, opt-in+final-confirmation requirements, voice/button/typed consent, refusal/silence/ambiguity/incomplete evidence, invalid contact/recording exclusion, one-use/expiry, background/profile/contact/dismissal revocation, real-warning revocation, old-confirmation isolation and no fabricated persistence/learning. Existing full-suite live authorization, recognition/prewarm, localization and sensor-routing coverage passes.

## Native build requirements and limitations

These changes use existing React Native/native modules and add no native API or entitlement. An existing up-to-date Debug shell can load the new JavaScript; distributing Release requires a newly bundled app/IPA. Existing microphone permissions, SpeechAnalyzer assets and Gemma provisioning still apply independently.

Ordinary selected-driver Drive/History/Settings pages retain global foreground VoiceCheck overlays; Sensi introduction need not be open. Profile editing, onboarding and isolated diagnostics intentionally pause unsupported safety presentation as before. No background/locked-iPhone foreground-presentation claim is made. Existing in-flight-check serialization is retained.

BMI plausibility limits are display guards for a driver app, not clinical reference ranges. Implausible persisted values are not repaired automatically; users must review/edit them. Since the personalization algorithm was explicitly kept unchanged, correcting bad stored measurements remains important. Scroll restoration across complete tab/screen remounts is not guaranteed; mounted Settings navigation and history-detail return are covered. Dynamic Type, keyboards, actual layout and system phone confirmation still require physical-device review.

## Physical-iPhone checklist

1. Check light/dark themes, Spanish/English, a smaller screen and larger Dynamic Type. Scroll profiles, threshold details, Developer Tools, history detail and Sensi; verify header/back remains reachable and bottom tabs stay intact.
2. Create metric and imperial profiles, edit an existing team-labeled profile, and confirm name/language/contact. Verify no Subject ID field, preserved saved identity/history, stable unit conversions, and unavailable display for implausible/missing BMI. Do not silently fix a tester's measurements.
3. Open Sensi from Drive, including while Settings was last on a nested page. Try a Safety Check must open the single Safety Testing page. Return from profile Edit and Gemma diagnostics to their parent routes. Check keyboard behavior for typed answers.
4. Run all four scenarios with opt-in OFF: correct existing thresholds/sequence and Simulation labels, no saved-contact phone interface, no fabricated history/cloud/learning. Review threshold details and oxygen caveat. Fictional practice stays separately labeled and freshly confirmed.
5. For the real-contact demonstration, use a knowingly participating saved contact while parked. Enable for one run, answer NOT OK, then consent by voice, typing or buttons. No system phone action should occur until the separate named final confirmation. Cancel the alert first; then repeat and choose Yes, open phone. Verify the intended saved number and iOS confirmation; cancel iOS confirmation if no call is intended. Do not use emergency-services numbers.
6. Repeat with refusal, silence, ambiguous/failed recognition, missing/invalid contact, expiry beyond 30 seconds, backgrounding, profile switching, recording, and an old confirmation after a new run. None may open the phone without a new valid consent/confirmation chain. Use existing Debug timing capture for recognition failures; no partial promotion.
7. Verify a genuine accepted sensor event presents VoiceCheck from Drive, History and Settings without opening Sensi first. Use controlled authorized testing, not unsafe driving. Confirm live provenance checks remain separate from simulations.
8. In Release, confirm Developer Tools/raw diagnostic output are absent while ordinary settings, model recovery, Safety Testing and the approved contact flow remain available. Verify existing Gemma empathy, mandatory guidance-first ordering, English/Spanish recognition and manual fallbacks on hardware.

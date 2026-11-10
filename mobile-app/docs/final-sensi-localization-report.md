# DriveSense final Sensi, onboarding and localization work

## Phase 1 — Sensi VoiceCheck

- Replaced the microphone glyph and pulse with a static 9 px orange dot and inline localized listening label. No animation remains. The indicator appears only after the native audio gate opens; the preceding readiness/cue interval is labeled Ready. Native stop notifications hide it before asynchronous cleanup finishes.
- Preserved both recognizers, audio ownership, offline enforcement, the six-second response window, and bounded finalization. Cue input remains excluded from recognition and noise calibration.
- Found concrete weaknesses in the previous cue implementation: `AVAudioPlayer.play()` returning false was silently treated as success, and playback was stopped using an estimated 180 ms startup/duration interval. This could conceal failed playback or cut off delayed playback. These are code findings, not proof of what happened on the physical iPhone.
- Cue playback now checks preparation/start results, waits for the actual AVAudioPlayer completion delegate, handles decoding failure/cancellation exactly once, and has an 800 ms failure timeout plus the existing 40 ms acoustic tail. The tone/envelope remain unchanged. Moderate per-player gain replaces the unusually attenuated gain; hardware volume and output routing are not overridden.
- Native results identify `ready-cue-completion-v4` and expose the cue error, output-volume reading, and output port types measured at the cue. Existing development timing snapshots include the revision, failure flag, volume, and route. This distinguishes old binaries, playback failure, and routing/volume conditions without logging transcripts or phone numbers.
- Removed normal driver-facing Gemma/acknowledgment implementation labels. Existing Advanced Settings developer tools remain available.
- Simulation completion appears once in its labeled status area; the duplicate conversation-thread status is filtered only for simulations. Live conversation message ownership remains unchanged.
- Spanish contact offers/retries now use the same validated configured name as English. Invalid/missing names use a generic emergency-contact description. Phone validation and deterministic consent are unchanged.
- Preserved the floating Sensi launcher, draggable behavior and greeting. Its existing simulation shortcut navigates to the existing Advanced Settings controls; no second VoiceCheck, simulated telemetry storage, learning path, or dialer bypass was introduced.

Validation: VoiceCheck, safety-controller, conversation UI, listening gate, actual native completion-state tests, localization presentation tests, and full regression suite. Actual audible behavior still requires device testing.

## Phase 2 — Onboarding and driver selection

- Added separate baseline and alert explanation pages within the existing How DriveSense Works stage. Their subpage progress uses `setup_education_step`; existing six-stage setup, notices, Gemma terms, artifact verification and completion persistence were retained. Completed users are not forced through model setup again. Review mode starts the explanations from the beginning.
- Added an immediately accessible app-language menu, including the sign-in screen, initial welcome, driver selection and confirmation screens.
- Added a persisted spoken-language default (`voicecheck_default_language`) and matching existing voice picker during onboarding. It defaults new profiles; existing drivers retain their saved `driver_profiles.language`. The existing profile editor, reachable from Settings → Sensi Assistant → VoiceCheck language, changes a driver's spoken language. No duplicate speech pipeline was added.
- Existing profile selection/create/edit flows are reused. Selection now stages the profile for explicit confirmation before calling the original `selectDriver` hook. Confirmation shows the exact driver name, saved contact, and spoken language, and prevents duplicate submissions. Going back has no monitoring effect.
- The existing hook still owns cancellation, profile configuration, baseline loads, calibration state and stale-selection guards. App-language changes never select a driver or reconfigure safety monitoring.

Validation: onboarding UI/progress persistence, setup persistence/version gates, new confirmation rendering/action tests, existing profile editing/measurement and monitoring-hook isolation tests.

## Actual baseline and alert behavior inspected

- The profile model establishes the initial reference/warning ranges. The learned baseline uses completed drives fetched from the preceding 180 days. Its preferred learning window is 28 days, extending to the most recent 10 drives when fewer are in that window.
- At least 60 retained heart-rate readings establish a baseline. Available heart-rate and SpO₂ readings are summarized. Bad signal and intervals surrounding NOT OK/no-response or escalated episodes are excluded (60 seconds before through 120 seconds after). The baseline refreshes after saved drives and is loaded for the selected profile.
- Calibration is separate and optional: a 60-second reference measurement needs at least 30 clean seconds. Accepted heart-rate corrections accumulate by clean-reading count and are bounded; SpO₂ is compared but never corrected. Calibration is not required to start monitoring.
- Threshold comparisons use accepted signal, outlier rejection and five-reading medians. A warning is checked for 15 seconds; critical conditions use 8 seconds. Confirmation requires at least 70% valid coverage and 80% of those readings beyond the warning boundary. Recovery and queued-episode ownership behavior were not changed.
- Heart-rate critical boundaries are 131 BPM high and 40 BPM low. Initial high-warning lines are bounded to 91–111 BPM before permitted personal acknowledgment adjustments; low-warning lines are 41–50 BPM. Existing acknowledgment caps remain 125 BPM high / 43 BPM low. Normal SpO₂ warning/critical boundaries are 93% / 91%; existing COPD-specific rules remain unchanged. These are prototype implementation details, not medical guidance.
- Foreground safety monitoring requires a configured driver, connected sensors, recent accepted data and a supported screen. Trip recording is independent. Critical readings and no response do not authorize an automatic emergency-services call. Saved-contact handoff requires explicit scoped consent plus live-event and final platform checks. Simulations never invoke it.

## Phase 3 — Application language

- Added one local app-only preference (`app_language`) and provider above sign-in/onboarding. It restores the preference before showing the interface and applies changes without restarting. Writes are serialized; a delayed load cannot overwrite a newer selection. Storage failures preserve the in-session choice and show a localized retry message.
- The language menu sits alongside appearance controls and in Settings. It never reads or writes the theme or a driver profile. Spoken language and installed-voice choices remain independent.
- Centralized translations use English source keys and explicit parameter templates. Presentation adapters localize text, button labels, accessibility labels/hints, input placeholders, information sheets, and confirmation dialogs without changing values, callbacks, refs, or stored data. No translation service or dependency was added.
- Raw driver names, contacts, phone numbers, typed values and driver transcripts are preserved. Model acknowledgments/system guidance can be displayed in the app language while speech remains in the driver's chosen spoken language. This is display-only and never feeds back into response interpretation or consent.
- Covered welcome/setup, dashboard/vitals, connectivity, histories, profiles/contact forms, Settings/submenus, calibration/privacy explanations, Sensi status/actions, and known app-generated errors. Parameterized values preserve measurement units. Header controls wrap; onboarding, standby and confirmation content scroll for longer labels.
- Developer-only diagnostics remain technical. Official Google legal text remains in its original language with an explanatory notice; native iOS permission sheets follow iOS language settings. Unknown OS/backend technical error details retain their original text rather than being mistranslated. The source-coverage regression audits static driver-facing copy, not every arbitrary runtime/native string.

Validation: preference persistence/write-failure/load-race tests; app/voice/theme independence; dynamic-name/phone/punctuation preservation; real display-adapter tests; centralized static UI-copy coverage and placeholder consistency; existing appearance, navigation and dashboard tests. Physical layout at large text sizes remains unverified.

## Phase 4 — Regression verification

Final results: `npm run typecheck` passed; `npm test` passed **531 tests**, with **0 failures and 0 skipped**; `git diff --check` passed. New regressions cover language persistence/races, independent preferences, static translation coverage and parameters, raw user-data preservation, onboarding explanation progress, explicit profile confirmation, named Spanish contact prompts, single simulation status, listening readiness, and native cue completion/cancellation. Native verification covers compilation of the speech/playback implementation into iOS objects in Debug and Release with a 15.1 deployment target, plus parsing of the module bridge. It does not constitute a full Xcode application link, install, or physical audio test.

Existing uncommitted changes were preserved. No commits, pushes, iOS regeneration, destructive cleanup, Supabase schema changes, or RLS/security edits were performed. Existing baseline/threshold algorithms, deterministic response/consent interpretation and live dialer authorization were not changed.

## Rebuild and physical testing

An Xcode rebuild is required for native cue completion/error reporting and readiness notifications. Metro reload alone is insufficient. No new dependency or full iOS-project regeneration is needed.

1. Install the rebuilt Debug app. Confirm timing snapshots report `ready-cue-completion-v4`.
2. Test speaker and the intended Bluetooth route at normal user volume, with silent mode on/off. If the cue is absent, capture its failure flag, output route and output-volume reading. Do not assume an old build or low volume without that evidence.
3. Test English and Spanish short answers and longer responses. Confirm Ready → cue → orange Listening indicator, no cue transcript, full six-second opportunity after the cue, and immediate indicator removal on timeout/cancel/interruption. Check backgrounding and incoming audio interruption.
4. Test all four App Language / VoiceCheck Language combinations. Change appearance independently. Restart and verify language persistence. Use large text and a smaller-screen simulator/iPhone to inspect wrapping and dialogs.
5. Review the added onboarding pages, restart mid-page, create/select/confirm a driver, edit spoken language/contact, switch profiles and verify the correct baseline/contact before monitoring resumes.
6. Launch the existing simulation from floating Sensi in both app languages. Confirm a single localized result, no dialer, no saved simulated trip/incident, and no baseline change. Existing automated tests verify persistence and handoff suppression; do not treat them as a physical live-call test.
7. If live saved-contact handoff needs physical verification, perform a separately controlled live-path test with explicit consent; do not bypass simulation guards or automatically initiate a call.

## Files changed in this task

The manifest below lists this task's files, including files that already had uncommitted work. Other pre-existing modified/untracked files were left intact.

- [mobile-app/App.tsx](/Users/samanthascott/Documents/FIU-SeniorDesign/mobile-app/App.tsx)
- [mobile-app/components/AppearanceMenu.tsx](/Users/samanthascott/Documents/FIU-SeniorDesign/mobile-app/components/AppearanceMenu.tsx)
- [mobile-app/components/BrandMark.tsx](/Users/samanthascott/Documents/FIU-SeniorDesign/mobile-app/components/BrandMark.tsx)
- [mobile-app/components/CalibrationCard.tsx](/Users/samanthascott/Documents/FIU-SeniorDesign/mobile-app/components/CalibrationCard.tsx)
- [mobile-app/components/CompactVitalCard.tsx](/Users/samanthascott/Documents/FIU-SeniorDesign/mobile-app/components/CompactVitalCard.tsx)
- [mobile-app/components/DashboardAssistantEntry.tsx](/Users/samanthascott/Documents/FIU-SeniorDesign/mobile-app/components/DashboardAssistantEntry.tsx)
- [mobile-app/components/DemoStartup.tsx](/Users/samanthascott/Documents/FIU-SeniorDesign/mobile-app/components/DemoStartup.tsx)
- [mobile-app/components/DraggableSensiLauncher.tsx](/Users/samanthascott/Documents/FIU-SeniorDesign/mobile-app/components/DraggableSensiLauncher.tsx)
- [mobile-app/components/DriveView.tsx](/Users/samanthascott/Documents/FIU-SeniorDesign/mobile-app/components/DriveView.tsx)
- [mobile-app/components/DriverConfirmation.tsx](/Users/samanthascott/Documents/FIU-SeniorDesign/mobile-app/components/DriverConfirmation.tsx)
- [mobile-app/components/DriverPicker.tsx](/Users/samanthascott/Documents/FIU-SeniorDesign/mobile-app/components/DriverPicker.tsx)
- [mobile-app/components/HistoryView.tsx](/Users/samanthascott/Documents/FIU-SeniorDesign/mobile-app/components/HistoryView.tsx)
- [mobile-app/components/Information.tsx](/Users/samanthascott/Documents/FIU-SeniorDesign/mobile-app/components/Information.tsx)
- [mobile-app/components/LanguageMenu.tsx](/Users/samanthascott/Documents/FIU-SeniorDesign/mobile-app/components/LanguageMenu.tsx)
- [mobile-app/components/Onboarding.tsx](/Users/samanthascott/Documents/FIU-SeniorDesign/mobile-app/components/Onboarding.tsx)
- [mobile-app/components/SafetyTypedResponse.tsx](/Users/samanthascott/Documents/FIU-SeniorDesign/mobile-app/components/SafetyTypedResponse.tsx)
- [mobile-app/components/SensiConversationThread.tsx](/Users/samanthascott/Documents/FIU-SeniorDesign/mobile-app/components/SensiConversationThread.tsx)
- [mobile-app/components/SensiSafetyConversation.tsx](/Users/samanthascott/Documents/FIU-SeniorDesign/mobile-app/components/SensiSafetyConversation.tsx)
- [mobile-app/components/SensiStandby.tsx](/Users/samanthascott/Documents/FIU-SeniorDesign/mobile-app/components/SensiStandby.tsx)
- [mobile-app/components/SensiVoicePlaybackDiagnostic.tsx](/Users/samanthascott/Documents/FIU-SeniorDesign/mobile-app/components/SensiVoicePlaybackDiagnostic.tsx)
- [mobile-app/components/SettingsView.tsx](/Users/samanthascott/Documents/FIU-SeniorDesign/mobile-app/components/SettingsView.tsx)
- [mobile-app/components/SmartWheelScreen.tsx](/Users/samanthascott/Documents/FIU-SeniorDesign/mobile-app/components/SmartWheelScreen.tsx)
- [mobile-app/components/ThresholdHistory.tsx](/Users/samanthascott/Documents/FIU-SeniorDesign/mobile-app/components/ThresholdHistory.tsx)
- [mobile-app/components/VitalsDetailView.tsx](/Users/samanthascott/Documents/FIU-SeniorDesign/mobile-app/components/VitalsDetailView.tsx)
- [mobile-app/components/VoiceCheckListeningIndicator.tsx](/Users/samanthascott/Documents/FIU-SeniorDesign/mobile-app/components/VoiceCheckListeningIndicator.tsx)
- [mobile-app/components/VoicePicker.tsx](/Users/samanthascott/Documents/FIU-SeniorDesign/mobile-app/components/VoicePicker.tsx)
- [mobile-app/components/charts.tsx](/Users/samanthascott/Documents/FIU-SeniorDesign/mobile-app/components/charts.tsx)
- [mobile-app/components/ui.tsx](/Users/samanthascott/Documents/FIU-SeniorDesign/mobile-app/components/ui.tsx)
- [mobile-app/docs/final-sensi-localization-report.md](/Users/samanthascott/Documents/FIU-SeniorDesign/mobile-app/docs/final-sensi-localization-report.md)
- [mobile-app/lib/analysis/safetyController.ts](/Users/samanthascott/Documents/FIU-SeniorDesign/mobile-app/lib/analysis/safetyController.ts)
- [mobile-app/lib/i18n/LanguageProvider.tsx](/Users/samanthascott/Documents/FIU-SeniorDesign/mobile-app/lib/i18n/LanguageProvider.tsx)
- [mobile-app/lib/i18n/catalog.ts](/Users/samanthascott/Documents/FIU-SeniorDesign/mobile-app/lib/i18n/catalog.ts)
- [mobile-app/lib/i18n/native.tsx](/Users/samanthascott/Documents/FIU-SeniorDesign/mobile-app/lib/i18n/native.tsx)
- [mobile-app/lib/i18n/preferences.ts](/Users/samanthascott/Documents/FIU-SeniorDesign/mobile-app/lib/i18n/preferences.ts)
- [mobile-app/lib/i18n/translate.ts](/Users/samanthascott/Documents/FIU-SeniorDesign/mobile-app/lib/i18n/translate.ts)
- [mobile-app/lib/voice/responsivenessDiagnostics.ts](/Users/samanthascott/Documents/FIU-SeniorDesign/mobile-app/lib/voice/responsivenessDiagnostics.ts)
- [mobile-app/lib/voice/speechIO.ts](/Users/samanthascott/Documents/FIU-SeniorDesign/mobile-app/lib/voice/speechIO.ts)
- [mobile-app/lib/voice/voiceCheck.ts](/Users/samanthascott/Documents/FIU-SeniorDesign/mobile-app/lib/voice/voiceCheck.ts)
- [mobile-app/modules/local-foundation-models/index.ts](/Users/samanthascott/Documents/FIU-SeniorDesign/mobile-app/modules/local-foundation-models/index.ts)
- [mobile-app/modules/local-foundation-models/ios/LocalFoundationModelsModule.swift](/Users/samanthascott/Documents/FIU-SeniorDesign/mobile-app/modules/local-foundation-models/ios/LocalFoundationModelsModule.swift)
- [mobile-app/modules/local-foundation-models/ios/LocalSpeechPlayback.swift](/Users/samanthascott/Documents/FIU-SeniorDesign/mobile-app/modules/local-foundation-models/ios/LocalSpeechPlayback.swift)
- [mobile-app/modules/local-foundation-models/ios/OfflineSpeechDiagnostic.swift](/Users/samanthascott/Documents/FIU-SeniorDesign/mobile-app/modules/local-foundation-models/ios/OfflineSpeechDiagnostic.swift)
- [mobile-app/tests/appearanceMenu.test.ts](/Users/samanthascott/Documents/FIU-SeniorDesign/mobile-app/tests/appearanceMenu.test.ts)
- [mobile-app/tests/dashboardPresentation.test.ts](/Users/samanthascott/Documents/FIU-SeniorDesign/mobile-app/tests/dashboardPresentation.test.ts)
- [mobile-app/tests/gemmaOnlyArchitecture.test.ts](/Users/samanthascott/Documents/FIU-SeniorDesign/mobile-app/tests/gemmaOnlyArchitecture.test.ts)
- [mobile-app/tests/listeningCueCompletion.test.ts](/Users/samanthascott/Documents/FIU-SeniorDesign/mobile-app/tests/listeningCueCompletion.test.ts)
- [mobile-app/tests/localization.test.ts](/Users/samanthascott/Documents/FIU-SeniorDesign/mobile-app/tests/localization.test.ts)
- [mobile-app/tests/onboardingUI.test.ts](/Users/samanthascott/Documents/FIU-SeniorDesign/mobile-app/tests/onboardingUI.test.ts)
- [mobile-app/tests/safetyConversationUI.test.ts](/Users/samanthascott/Documents/FIU-SeniorDesign/mobile-app/tests/safetyConversationUI.test.ts)
- [mobile-app/tests/safetyVoice.test.ts](/Users/samanthascott/Documents/FIU-SeniorDesign/mobile-app/tests/safetyVoice.test.ts)
- [mobile-app/tests/sensiMount.test.ts](/Users/samanthascott/Documents/FIU-SeniorDesign/mobile-app/tests/sensiMount.test.ts)
- [mobile-app/tests/sensiNavigation.test.ts](/Users/samanthascott/Documents/FIU-SeniorDesign/mobile-app/tests/sensiNavigation.test.ts)
- [mobile-app/tests/settingsNavigation.test.ts](/Users/samanthascott/Documents/FIU-SeniorDesign/mobile-app/tests/settingsNavigation.test.ts)
- [mobile-app/tests/voiceCheck.test.ts](/Users/samanthascott/Documents/FIU-SeniorDesign/mobile-app/tests/voiceCheck.test.ts)
- [mobile-app/tests/voiceCheckPresentation.test.ts](/Users/samanthascott/Documents/FIU-SeniorDesign/mobile-app/tests/voiceCheckPresentation.test.ts)

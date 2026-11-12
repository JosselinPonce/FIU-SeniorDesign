# VoiceCheck reliability, demonstration handoff and conversation layout

## Confirmed findings and limits

The exact statement `No I'm feeling really tired.` reproduced `intent=unclear` in the unmodified deterministic interpreter: P(OK)=0.5181, P(NOT_OK)=0.4713, below both acceptance thresholds. This is an interpretation gap, not proof of a native recognition failure.

The production path is iOS `OfflineSpeechDiagnostic.swift` → `listenOffline` → `lib/voice/speechIO.ts` (`phoneSensiVoiceIO`) → `SafetyController` capture wrapper → `VoiceCheck.ask` → `successfulFinal` → `onAnswer` → driver bubble → `understand` → next question or result. English uses the existing on-device SFSpeechRecognizer implementation; Spanish uses its existing SpeechAnalyzer/SpeechTranscriber path. Nothing in native recognition, finalization, prewarming, PCM, audio ownership or deadlines changed.

`onAnswer` publishes only scoped successful finalized voice evidence (or an accepted typed/button answer). A driver bubble can therefore display a finalized statement whose *meaning* is unclear; final recognition and an accepted wellness decision are different. The active safety view supplies no provisional text. Partial/incomplete transcripts are rejected and do not enter this callback. Native diagnostic and adapter records remain the authority for correlating a specific historical capture. Without those records and installed-build identity, the historical transcript's finality and root cause cannot be proven.

Previously, two unclear attempts and two silent attempts both used the same “I didn't hear an answer” message. The observed sentence can reproduce the unclear branch. This is a confirmed misleading-message defect; no speculative timer/route/recognition fix was made.

## Reliability changes

- Added a bounded whole-statement first-person English symptom rule for statements such as “No, I'm feeling really tired.” It requires an explicit supported symptom, permits a small set of modifiers, and cannot match negated, quoted, reported or trailing contradictory clauses. Existing urgent rules still run first. The probabilistic model, acceptance thresholds, Spanish behavior, contact interpreter and emergency policy are unchanged.
- Unresolved attempts track absence of observed usable text, unfinished speech, input failure (including rejected capture ownership) and finalized ambiguous meaning. Aggregate precedence is ambiguous > failure > unfinished > no observed text, so a later empty attempt cannot erase previously recognized ambiguous speech.
- Completion wording now accurately identifies the issue and retains deterministic pull-over/911 guidance. It never claims an incident was recorded while still inside VoiceCheck, especially in a simulation. Lack of recognized text is **not proof of physical silence**; the message says no answer was confirmed.
- Finalized OK/NOT_OK responses retain their existing outcomes and cannot be replaced by late callbacks. Partial text never becomes a decision or contact consent.
- New Debug-only `VoiceCheck unresolved response` records contain capture ID, question and a coded aggregate reason only. Existing native/adapter/controller interpretation records distinguish detailed failures; no transcript/audio/contact was added to diagnostics. The existing opt-in bounded RAM recorder is unchanged.

## Native phone safeguard and authorization

The implementation calls React Native `Linking.openURL` with the existing saved-contact `tel:` URL. Apple documents a user confirmation before dialing for native tel links on iOS 10.3+:
https://developer.apple.com/library/archive/featuredarticles/iPhoneURLScheme_Reference/PhoneLinks/PhoneLinks.html

`hasSystemPhoneConfirmation` limits this assurance to known supported iOS versions. The app's current deployment target is newer than 10.3. The production hook declares this capability; supported iOS automatically consumes the existing one-use permit after simulation/VoiceCheck audio cleanup and opens the native confirmation. There is no Review card or additional app Alert. This is a documented API expectation, **not a newly observed physical-device result**, and opening a phone interface does not establish call connection.

Without that capability assurance, exactly one concise named in-app confirmation remains; the phone boundary can still reject an unsupported platform. This branch does not assume an extra OS safeguard.

Real-contact demonstration now requires `accepted_offer`: an explicit affirmative answer to the actual contact-offer question. An unsolicited direct request alone cannot authorize this demonstration route. Scoped typed/buttons remain supported. Ordinary simulations/rehearsals still cannot enter the live handoff boundary. Missing/invalid contacts, partial/ambiguous/stale/expired answers, cancellation, backgrounding, recording and profile/contact changes remain fail-closed. Each run creates fresh RAM-only authorization; the permit is expiring and consumed once. No simulated incident, reading, learning or cloud write is introduced. Requested/failed handoff status is published for the same episode only.

## Persistent preference

`real_contact_demo_enabled_v1` uses existing local `app_settings` get/set APIs. Only `1` enables it; absent/invalid values default OFF. This Boolean is not synced through Supabase and contains no contact, driver identifier, transcript or permit. Restore/write failures are reported and do not claim successful enablement. Writes are guarded against overlap; scenarios wait for preference restoration/saving. The preference survives runs/navigation/backgrounding, while existing cancellation still revokes transient authorization. Missing contacts block enabled demonstrations; turning the preference off remains available. Ordinary noncalling runs remain available with it off.

Saved contact numbers are masked in ordinary Settings and fallback confirmation UI; the original saved number is passed unchanged through validation to the authorized native handoff. Profile editing/storage is unchanged.

## Conversation layout and pacing

The compact 18-point header, stage and short calling/noncalling indicator are grouped above a bordered conversation region. One ScrollView now contains all bubbles plus the response/completion footer; the competing half-height footer ScrollView and repetitive phone disclaimer are removed. Clipped subview removal is disabled, the scroll view can shrink inside the keyboard-avoiding safe-area layout, and typed controls remain reachable. Existing near-bottom tracking follows new messages only when the user is near the bottom; review position is retained otherwise, including keyboard layout changes. Previous messages and their safety guidance remain intact.

The coordinated nonurgent response is still one TTS operation with existing sentence-boundary punctuation. A separately timed pause would require splitting playback or a supported synthesis control; no speculative audio timing/SSML change was added. Exact natural pacing remains a device/voice check. Urgent guidance is unchanged. Gemma's existing ready-only snapshot, eligibility, strict validation, bounded lifecycle and deterministic fallback are unchanged.

## Files changed in this request

Production:
- `components/SettingsView.tsx`
- `components/RealContactDemoConfirmation.tsx`
- `components/SensiSafetyConversation.tsx`
- `components/SensiConversationThread.tsx`
- `lib/voice/intent.ts`
- `lib/voice/voiceCheck.ts`
- `lib/voice/phoneHandoff.ts`
- `lib/voice/realContactPreference.ts` (new)
- `lib/analysis/safetyController.ts`
- `lib/hooks/useDriveSession.ts`
- `lib/assistant/safetyConversation.ts`
- `lib/i18n/catalog.ts`

Tests:
- `tests/realContactDemo.test.ts`
- `tests/realContactDemoUI.test.ts`
- `tests/settingsNavigation.test.ts`
- `tests/monitoringHook.test.ts`
- `tests/safetyConversationUI.test.ts`
- `tests/voiceCheck.test.ts`
- `tests/safetyController.test.ts`
- `tests/voiceCheckReliability.test.ts` (new)
- `tests/realContactPreference.test.ts` (new)
- `tests/safetyThreadLayout.test.ts` (new)
- This report (new).

## Verification

TypeScript and the full suite passed: **724 tests, 0 failures**. Model/speech/phone integration fixtures are mocked; these are not physical iPhone, real GGUF or actual-call results. The relevant tests cover observed finalized symptoms, partial/empty finalization, unresolved wording, stale ownership, late timeout, cancellation, consent/refusal, missing contact, expiry, one-use/new-run permits, driver/contact changes, preference restoration, masking, single-scroller layout, history review and keyboard layout changes. Existing English/Spanish/Gemma, safety and simulation-isolation regressions passed.

Unsigned Debug iOS build passed. Release iOS JS export passed; bundle inspection confirmed the new unresolved-response diagnostic operation, Gemma diagnostic operation, response-composition diagnostic and timing-capture control absent, while the production preference/action and truthful response text remain. No Swift/dependency/IPA configuration changed. Install/reload the updated JS application; no native migration is needed. `git diff --check` passed. No commit, push, reset or overwrite of unrelated work was performed.

## Physical-iPhone checklist

1. Park, use a consenting saved contact, enable Debug timing capture if correlation is needed. Fresh installation: preference OFF. Enable it, complete a run, reopen Settings/relaunch, and verify it stays ON. Turn OFF and verify ordinary simulations never open a phone interface.
2. English: say “No, I'm feeling really tired.” Expect one coordinated NOT_OK guidance/offer, then Listening. Driver bubble should match the finalized answer. There must be no “didn't hear” or false recorded-emergency statement.
3. Give a clear affirmative to the contact offer: expect the native iOS phone confirmation directly, with no Review/extra app Alert. Verify the intended saved number and **cancel the OS prompt** unless a real call is planned with the participant. An interface request is not proof of a connected call.
4. Repeat refusal, ambiguous response, actual recognition failure, partial/empty finalization, cancellation/background, invalid contact and driver/contact changes. No stale authorization may open the phone. Repeat consent through typed/button controls and in Spanish.
5. On a smaller iPhone and with large accessibility text/VoiceOver: scroll to the first and last bubbles, review old messages while new ones arrive, open/dismiss the keyboard, and reach response/Close controls. Header/status must not obscure bubbles. Contact numbers should be masked outside editing/native handoff.
6. For any contradictory result, export existing capture-correlated native status/reason/final-presence, adapter acceptance, VoiceCheck interpretation and new unresolved coded record. Do not add transcript or contact data to diagnostic reports. Compare the installed build to this source before concluding that recognition or interpretation regressed.

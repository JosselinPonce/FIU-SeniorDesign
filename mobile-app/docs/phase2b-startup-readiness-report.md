# Phase 2B — Startup reliability and Spanish readiness

## Result and scope

Returning users with completed setup, current accepted notices/terms, and the current pinned artifact record now enter the dashboard without a native Gemma initialize/release cycle. Previously that cycle was required on launch. The record authorizes dashboard admission; it does not establish file availability or runtime readiness. First-time provisioning, verification, initialization, cleanup, and explicit setup completion remain required.

At safety-event time, actual artifact verification, initialization, bounded inference, strict output validation, and deterministic fallback remain in place. No safety threshold, emergency authorization, contact consent, dialer, capture, prewarming, or database policy was changed.

## Release model recovery

Settings → Sensi Assistant → Gemma model exposes **Check and repair Gemma** in Release. Merely opening Settings does not hash, load, download, or run inference. Status distinguishes a missing artifact, an unconfirmed artifact, a successful last explicit check, and errors; a successful check does not guarantee future availability.

Explicit recovery forces the existing SHA-256 verification, tests initialization, and releases the context. Only known missing/size/integrity failures permit the existing pinned download path. Initialization or hash-service errors do not replace otherwise valid weights. Existing artifact revision, staging, hash verification, and interrupted-download protections remain intact. Offline repair failure leaves dashboard admission and deterministic safety available; users can retry later.

A whole-sequence maintenance lease excludes safety inference and competing maintenance. The existing controller serialization remains authoritative. Provisioner ownership also excludes verification/inference while delayed native download cleanup is outstanding. Recovery is blocked during active monitoring, recording, safety checks, and demos; its own operation is cancelled on backgrounding, navigation away, or a new blocking activity. Duplicate presses cannot start another operation. Cancellation does not revoke dashboard access.

## Spanish capability reporting

The native Spanish capability query now uses the production SpeechTranscriber/SpeechAnalyzer technology on iOS 26+: device support, equivalent Spanish locale, installed locales, and read-only AssetInventory status using the same progressive-transcription preset. Missing assets and conflicting inventory are reported as unavailable or uncertain. Older systems report the OS requirement. The query neither reserves/downloads assets nor requests permissions nor starts microphone capture.

English still uses the existing SFSpeechRecognizer capability implementation. Settings presents capability as advisory and explicitly avoids a microphone-capture guarantee. Typed/button fallback remains available. A stale native bridge without Spanish metadata is reported as needing an app update. Existing production capture and prewarming code is unchanged.

## Native release failure

Before native release, a context is marked invalid. It becomes reusable only through a new successful initialization after successful cleanup; failed release retains the quarantined reference solely for cleanup retry. Generation and reloading cannot reuse that reference. The phone acknowledgment provider rejects an otherwise valid generated result if lifecycle cleanup fails, selecting deterministic fallback. Serialized ownership, cancellation, the existing five-second readiness window, and nonblocking mandatory guidance are preserved. A permanently stuck native operation may require app restart.

## Exact Phase 2B file manifest

Production files changed:

- `lib/onboarding/setup.ts`: returning admission and explicit recovery.
- `lib/onboarding/phone.ts`: maintenance lease integration.
- `modules/gemma-poc/controller.ts`: forced verification and context quarantine.
- `modules/gemma-poc/phone.ts`: maintenance/event exclusion and release-failure fallback.
- `modules/gemma-poc/provisioning.ts`: expose existing operation ownership.
- `components/GemmaModelSettings.tsx` (new): Release recovery UI.
- `components/SpeechCapabilityStatus.tsx` (new): advisory capability UI.
- `components/SettingsView.tsx`: mount recovery/capability UI and correct Spanish status.
- `components/SmartWheelScreen.tsx`: exclude Debug diagnostic entry during maintenance.
- `components/Onboarding.tsx`: accurate returning-user copy.
- `lib/i18n/catalog.ts`: Spanish strings for the new UI.
- `modules/local-foundation-models/index.ts`: capability metadata types.
- `modules/local-foundation-models/ios/LocalFoundationModelsModule.swift`: read-only Spanish native capability query and routing.

Tests changed: `tests/onboardingSetup.test.ts`, `tests/gemmaPoc.test.ts`, `tests/gemmaProvisioning.test.ts`, `tests/phase2aIntegration.test.ts`, `tests/settingsNavigation.test.ts`.

Tests added: `tests/modelSettings.test.ts`, `tests/spanishCapability.test.ts`.

Documentation added: this report. Other uncommitted files and earlier-phase changes were preserved; the repository-wide diff is not the Phase 2B manifest.

## Automated validation

- Full Node test suite: **631 passed, 0 failed** (617 baseline).
- TypeScript: `tsc --noEmit` passed.
- Regression coverage includes returning admission with no model/native cycle; fresh setup requirements; missing/corrupt/offline recovery; retry, concurrency and cancellation; valid-model preservation on initialization failure; Release Settings behavior; Spanish support/locale/asset uncertainty and English routing; release quarantine and fallback; late/cancelled inference, mandatory-guidance failures, microphone ownership, and emergency simulation isolation.
- Spanish hardware inventory tests execute the actual extracted Swift helper against mocked platform APIs. They are not device recognition results. JavaScript inference/lifecycle tests use mocked native/model dependencies; they do not establish GGUF acceptance or timing.
- Debug and Release Expo iOS/Hermes exports passed. Release bundle inspection confirms the recovery action is present and existing isolated contextual diagnostic entry strings are absent.
- Debug and Release iPhoneOS Swift implementation-module compilation passed for the speech implementation, including the new capability helper and existing playback/offline speech dependencies. The Expo bridge file passed parsing in both configurations. Existing speech concurrency/deprecation warnings remain. These checks are not a complete native app link, signed archive, or IPA installation.
- `git diff --check` passed. No dependencies installed, commits created, or pushes performed.

## Physical-iPhone validation still required

1. Build/install the updated native app in Debug and Release. The old installed bridge cannot validate the new Spanish query. On an already completed/current setup, cold launch offline and confirm dashboard admission without Gemma loading. Check a fresh test installation still requires notices, terms, provisioning, and successful setup.
2. In Settings → Sensi Assistant, check a valid model offline: verification/init/release should succeed without downloading. Use a disposable test app container for missing/corrupt-file cases; do not damage the primary tester's model. Offline failure must preserve dashboard access; online retry must repair using the pinned artifact.
3. Exercise duplicate presses, cancel, back navigation, background/foreground, and recording/monitoring locks. Confirm no competing loads/downloads and that recovery can be retried after cleanup. A forced release-failure scenario is covered by mocks; do not claim it occurred on hardware without native evidence.
4. Compare English capability with Spanish on iOS 26+, including installed and absent assets where available. Verify Spanish inventory reporting agrees with the actual recognition path, then separately test real capture. Capability success alone is insufficient.
5. Run existing isolated English/Spanish VoiceCheck simulations: eligible NOT OK responses, typed/button input, ineligible statements, missing model, cancellation, and delayed inference. Mandatory guidance must begin independently; available acknowledgment may join only its existing window. Keep simulation protections active and verify no live call authorization.
6. Rerun the existing 12-case contextual Gemma diagnostic in Debug for model-output regression. Release must expose recovery but no Debug diagnostics. Prior Phase 1D physical acceptance is historical evidence, not physical validation of this build.

## Remaining limitations

No new physical-device results, full signed native app build, or AltStore installation were produced. Native memory pressure/crashes and indefinitely stuck native cleanup cannot be resolved by JavaScript fallback. First-time offline setup remains subject to existing provisioning requirements. Asset inventory is advisory and can change before capture; event-time verification and deterministic fallbacks remain necessary.

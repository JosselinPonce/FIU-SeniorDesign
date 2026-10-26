# Stage 2B dependency map (inspected before retirement)

| Root | Dependencies | Disposition |
| --- | --- | --- |
| Settings mode selector → mode.ts → phoneAssistantProvider | provider.ts (Apple), connectedProvider.ts (Supabase function) | Remove production selectors/adapters; retain historical mocked provider contracts only in test fixtures |
| LocalAITest → VoiceConversationTest / index interpretation exports | DriverResponseInterpreter.swift → Apple FoundationModels | Remove diagnostic screens and native model methods/interpreter |
| DriverAssistant (unmounted general conversation UI) | provider adapters, ordinary AssistantConversation | Remove obsolete production screen |
| LocalFoundationModels native bridge | OfflineSpeechDiagnostic.swift, LocalSpeechPlayback.swift | Preserve speech/playback methods, module identifier, native registration and pod dependencies |
| speechIO / VoicePicker / playback diagnostic | speech bridge, final-recognition evidence, shared policies and audio ownership | Preserve |
| AssistantConversation / conversationPolicy / driverWellnessSafety | Pure deterministic consent/output gates and regression fixtures, shared thread types | Preserve shared logic and all safety tests; no production model inference implementation |
| Gemma / onboarding | llama.rn, ModelProvisioner, native SHA-256, verified receipt, local settings | Preserve unchanged |
| DemoStartup → sensiSupabase / demoAuth / session storage | SecureStore, Supabase Auth, app admission | Preserve; independent from obsolete AI endpoint |
| Settings DemoAuthPanel | Connected-only pilot sign-in surface | Remove obsolete surface; retain tested Auth/session utilities used for demo admission |
| profileSync / liveSync / deletion / repositories | Existing upload Supabase client, local DB | Preserve |
| supabase/functions/driver-assistant | backend feature flag, OpenAI Responses adapter, auth/quota RPCs | Leave local backend/deployed resources unchanged for separate review; no mobile consumer remains |

Historical adapter fixtures exist only to keep existing rejection, cancellation,
consent and transport-contract regression tests. They are not imported by shipped
application code and cannot be selected through Settings. No safety tests removed.

## Server resources requiring separate review

The exclusively obsolete AI function is `driver-assistant`. Review its deployment,
OpenAI billing/credentials, AI enable flag, model configuration, request fingerprint
secret, and dedicated quota/idempotency tables/RPCs in its migration/README before
removal. No remote resource inventory was performed; deployment status is not
asserted. No functions, tables, policies or secrets were deleted or changed.
OpenAI credential references occur server-side, not in the new mobile runtime.
No secret values were printed, rotated or revoked. Revoke unused OpenAI credentials
manually after confirming they are not shared by other services. Keep all non-AI
Supabase keys, authentication, session storage, profiles and recording uploads.

Native language-model removal requires rebuilding the development client to
actually remove Apple inference from its binary. The historical native module name
is retained for speech compatibility; it no longer exposes language-model APIs.

No npm dependencies were removed: the old Apple integration was a native SDK
import and OpenAI used HTTP, without a dedicated npm SDK. `@noble/hashes` remains
required by recording archives; native model SHA-256 remains unchanged. No obsolete
provider variables were found in the mobile .env or .env.example (names inspected,
values never printed). The existing demo-admission variables and Supabase keys
remain intact. Legacy assistant_mode settings are ignored rather than deleted.

Server review inventory: function driver-assistant; DRIVER_ASSISTANT_ENABLED,
OPENAI_API_KEY and DRIVER_ASSISTANT_FINGERPRINT_KEY; schema
driver_assistant_private (control, demo_users, requests); public RPCs
driver_assistant_reserve, driver_assistant_dispatch and driver_assistant_complete.
Do not revoke Supabase service/publishable keys as part of retiring OpenAI.

## File manifest

Removed from application locations (historical TypeScript snapshots, excluding the
native interpreter, are under tests/retired-ai for existing mocked regressions):

- `components/DriverAssistant.tsx`
- `components/DemoAuthPanel.tsx`
- `lib/assistant/provider.ts`
- `lib/assistant/connectedProvider.ts`
- `lib/assistant/phoneAssistantProvider.ts`
- `lib/assistant/connectedReadiness.ts`
- `lib/assistant/phoneConnectedReadiness.ts`
- `lib/assistant/connectedPilotPolicy.ts`
- `modules/local-foundation-models/LocalAITest.tsx`
- `modules/local-foundation-models/VoiceConversationTest.tsx`
- `modules/local-foundation-models/ios/DriverResponseInterpreter.swift`

Modified application/module/documentation files:

- `components/SettingsView.tsx`
- `components/SmartWheelScreen.tsx`
- `components/DashboardAssistantEntry.tsx`
- `components/SensiStandby.tsx`
- `components/Onboarding.tsx`
- `lib/hooks/useDriveSession.ts`
- `lib/assistant/mode.ts`
- `lib/assistant/sensiStandby.ts`
- `lib/assistant/sensiVoicePlaybackTest.ts`
- `modules/local-foundation-models/index.ts`
- `modules/local-foundation-models/ios/LocalFoundationModelsModule.swift`
- `modules/local-foundation-models/ios/LocalFoundationModels.podspec`
- `modules/local-foundation-models/package.json`
- `lib/assistant/README.md`
- `lib/assistant/CONNECTED_PILOT.md`
- `lib/assistant/SENSI_GEMMA.md`
- `modules/local-foundation-models/README.md`

Added `lib/assistant/advisoryContract.ts` (shared pure envelope validation), this
document, and `tests/gemmaOnlyArchitecture.test.ts`. Existing tests now import
retired adapters exclusively as fixtures; all safety assertions remain. UI tests
now require Gemma settings without a legacy selector. Full test fixture inventory
is under `tests/retired-ai/README.md`. No application import reaches that folder.

Tests updated for retired imports/UI or added mocks:

- `tests/assistantConversation.test.ts`
- `tests/assistantMode.test.ts`
- `tests/assistantProviders.test.ts`
- `tests/connectedConversationPolicy.test.ts`
- `tests/connectedPilot.test.ts`
- `tests/dashboardPresentation.test.ts`
- `tests/floatingSensi.test.ts`
- `tests/gemmaOnlyArchitecture.test.ts`
- `tests/information.test.ts`
- `tests/localAIConversationPolicy.test.ts`
- `tests/monitoringHook.test.ts`
- `tests/pilotSignIn.test.ts`
- `tests/safetyConversation.test.ts`
- `tests/sensiAuthIsolation.test.ts`
- `tests/sensiMount.test.ts`
- `tests/sensiThread.test.ts`
- `tests/sensiVoicePlaybackTest.test.ts`
- `tests/settingsNavigation.test.ts`
- `tests/uiRendering.test.ts`

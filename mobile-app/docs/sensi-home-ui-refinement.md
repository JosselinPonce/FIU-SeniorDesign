# Sensi home UI refinement

Branch: `samantha/claude-remediation`.
HEAD preserved: `c5655837bb220108a250cacd90eff1ffad8e3ec0`.
The earlier five uncommitted pre-distribution UX refinements remain intact.
All changes are unstaged and uncommitted.

## Implementation and exact task manifest

Modified:
- `components/SensiStandby.tsx`: Meet Sensi, System Readiness and Try Sensi sections;
  existing glyph, theme tokens, safe-area host, scrolling, button and navigation.
- `lib/i18n/catalog.ts`: additive English/Spanish home/readiness copy.
- `tests/sensiNavigation.test.ts`: updated rendering expectations, accessibility,
  callback navigation and rendering of every observed Gemma state.

New:
- `lib/assistant/systemReadiness.ts`: pure presentation selectors; no actions.
- `lib/assistant/useSystemReadiness.ts`: transient read-only observations using
  existing model subscription and native inventory APIs, refreshed on foreground
  restoration and selected-driver language changes. No polling.
- `tests/systemReadiness.test.ts`: state projections, unknown inputs, sensor
  transitions, actual progress, voice prerequisites, stale-response/language
  guards, read-only observer lifecycle and Spanish strings.
- `docs/sensi-home-ui-refinement.md`: this report.

No other preexisting file changed during this task. The shared catalog retains
all earlier additions. No new icon/logo/assets, dependency or native edits were
introduced. `DashboardAssistantEntry.tsx`, including the original steering-wheel
`SensiGlyph`, is byte-for-byte unchanged.

## Sources of truth

| Indicator | Source and meaning |
| --- | --- |
| Steering-wheel sensors | `drive.connection`, `drive.link.source`, `drive.relay.esp`. Scanning/connecting/discovery/retry → Connecting; failed → Connection unavailable; disconnected/idle → Not connected. Relay BLE connectivity alone cannot establish wheel connectivity. An unknown relay sensor link stays unverified. No vitals or simulation data are inputs. |
| Sensi AI (Gemma) | Existing `gemmaPoc.subscribe/state` and presence-only `inspectGemmaModelFile()`. The hook never calls load, provision, verify/hash, inference, cancel, maintenance or lease APIs. |
| Voice recognition | Existing read-only `checkOfflineSpeechCapability()` for the driver language, explicit speech/microphone permissions and exact requested locale. English additionally requires the locale in existing `onDeviceLanguages()` inventory. Spanish requires SpeechTranscriber, installed asset status and installed locale. Unknown/missing evidence remains checked-at-start; known unavailable capability/assets remains unavailable. This is capability, not physical microphone proof. |
| Voice responses | Existing `listVoices(language)` inventory and read-only `getSetting(voice:en/es)`. Available only when an installed language voice exists and any saved preferred voice is present. Missing voice → Unavailable; failed/unknown query → checked-at-start. No playback or audio-session acquisition occurs. |
| Manual responses | Existing production typed/button fallbacks remain available independently of Gemma or recognition. No input or chat is added to standby. |
| Overall label | Requires a selected driver, foreground state, established wheel connectivity and active safety monitoring before saying Safety checks available. Disconnected sensors never produce a ready claim. Connected but awaiting fresh/valid readings stays Awaiting valid readings. Optional AI and voice do not block deterministic/manual safety operation. |

Speech/TTS availability observations are cleared on backgrounding and the overall
label becomes unverified. Subscriptions are removed on unmount. Late inventory
responses cannot republish after replacement or dismissal. A language change
immediately masks old-language voice information before new results arrive.
Runtime subscriptions update model phase/progress without starting work or
claiming ownership. Model size/existence checks occur on opening/foregrounding
and idle runtime notifications, not interval polling or hashing.

## Gemma readiness limitation

A downloaded file is not a verified runtime. Even `loaded && installed` does not
prove that the production safety path can acquire that context: a diagnostic or
maintenance owner can hold it. The existing public observation does not expose a
safe event-time lease availability proof. No lifecycle API was changed to force
one into the UI.

Accordingly, the home reports:
- Checking model status;
- Not downloaded;
- Downloading, with a percentage only for finite, valid native completed/total
  progress, or no percentage until real progress is available;
- Readiness check in progress for verification/initialization;
- Downloaded — not verified, even for a resident initialized context;
- Unavailable for observed errors/cleanup requirements or unknown file access.

It deliberately does not display Gemma Ready. The detail states that integrity
and runtime availability are checked before use. A past explicit initialization
check or persisted setup admission is not converted into a current availability
promise. This follows the requested conservative fallback rather than adding a
second manager, warming the model, or probing inference from an idle screen.

## Layout, navigation and safety preservation

The greeting, requested tagline and description use the existing localization
conventions. Existing glyph size/colors and design language are retained. Text
can wrap with Dynamic Type; no status uses a one-line truncation or fixed text
height. The neutral overall label is width-bounded and wraps. Five labeled,
icon-supported accessibility groups communicate status without relying on color.
The page scrolls within the existing safe-area/modal host.

Try Sensi is the single primary action. It calls the unchanged
`onTrySafetyCheck` navigation callback to Safety Testing. It does not start a
simulation, recording, microphone, model session, real event or contact action.
Simulations and any separately opted-in real-contact demonstration retain their
existing isolation, fresh-consent and platform-confirmation protections.

No changes were made to production interpretation, VoiceCheck decisions,
recognition/capture behavior, diagnostic isolation, empathy fallback, fixed
composer, simulation progress, cancellation, emergency consent, native dialer,
Supabase, model/warm ownership, or sensor-event activation.

## Validation

All generated validation artifacts are under `/private/tmp`.

- Focused tests: 77 passed, zero failures.
- Full suite, including all previous UX refinements: 1,160 passed; zero failures,
  cancellations or skips (43 new tests in this task).
- TypeScript and Git whitespace checks: passed.
- Release iOS JavaScript/Hermes export: passed for current application source.
- Existing eight Debug trace/timing markers: absent from Release bytecode in
  UTF-8 and UTF-16 checks. The separately requested VoiceCheck Testing screen
  remains included; it is distinct from Debug-only developer tools.
- Unsigned iOS Debug native-shell build: passed in the existing isolated SDK 54
  temporary workspace. Only existing script-phase warnings; no signing, install,
  original native workspace mutation, IPA packaging or distribution.
- Task-start fingerprints: only the three modified files above changed among
  preexisting files. All other prior work, dependencies/configuration, original
  glyph, protected refs, local handoff and Git exclusion remained unchanged.

Logs: `/private/tmp/drivesense-sensi-home-focused.log`,
`/private/tmp/drivesense-sensi-home-full.log`,
`/private/tmp/drivesense-sensi-home-typecheck.log`,
`/private/tmp/drivesense-sensi-home-export.log`,
`/private/tmp/drivesense-sensi-home-xcodebuild.log`.

## Physical-iPhone acceptance

1. Open Sensi in light/dark themes, on a small iPhone and at large Dynamic Type.
   Check greeting/icon, wrapping, all five labels, VoiceOver grouping, Close and
   primary button access. No listening cue, microphone indicator or idle speech
   should start merely by opening/closing.
2. Connect/disconnect the direct wheel and relay configurations. A connected
   relay with its ESP32 disconnected must not show wheel sensors Connected.
   Connected transport awaiting fresh readings must not claim monitoring active.
3. Test absent/downloaded model and, where an already-authorized model operation
   is observable, actual progress, initialization, errors and cleanup. Opening
   standby itself must not download, initialize, hash, generate or retain a lease.
4. Change permission and voice assets in iOS Settings, then return. Verify
   recognition and TTS separately, missing saved voices, and English/Spanish
   driver-language changes. Available capability is not a verified microphone or
   speaker run; keep the earlier VoiceCheck Testing checklist.
5. Tap Try Sensi with sensors disconnected/model unavailable. Confirm navigation
   to the existing Safety Testing page, not an immediate check or phone action.
   Verify the prior diagnostic, simulation panel, neutral fallback, conversational
   no cases and fixed response composer remain intact.

Ready for review, with all work unstaged/uncommitted. No claim of universal
language coverage or physical-device success is made.

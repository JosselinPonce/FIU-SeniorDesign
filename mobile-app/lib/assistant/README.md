# Stage 4B: shared AI conversation, disabled Connected activation

`DriverAssistant` snapshots `local` or `connected` when its overlay is opened.
`AssistantConversation` continues to own all question flow, recognition retries,
final-only consent, deterministic contact parsing, emergency exclusions, audio
ownership and cancellation. CORE and live warning orchestration do not import
these provider modules.

`provider.ts` defines the small generation interface: prepare, generate, cancel,
dispose and current-ownership check. LOCAL forwards the same transcript, bounded
JSON context, request ID, native response and cancellation to Foundation Models.
No Foundation Models implementation or prompt was removed or changed.

`phoneAssistantProvider.ts` wires the selected adapter to the existing native bridge
or the dedicated `sensiSupabase.ts` client. It does not change telemetry
synchronization, call OpenAI directly or contain server secrets.
Neither provider is a fallback for the other.

## Connected is intentionally unavailable

`connectedReadiness.ts` exports a frozen release gate with `verified: false`.
Release builds retain that disabled default. An exact
`EXPO_PUBLIC_SENSI_CONNECTED_PILOT=true` permits the normal Connected conversation
only in an iOS development build. `phoneConnectedReadiness.ts` supplies the same
frozen build gate to the dashboard, launch router and provider. No flag, cached
session or public project key establishes backend readiness or enables its switches.
Pilot copy explicitly says backend access is unverified; voice/Auth preparation
does not claim that generation will succeed. Selecting the mode performs no backend
readiness probe. Sending a genuine final transcript is a real endpoint attempt,
not the no-network voice fixture, and requires separate authorization.

Default/non-iOS/release builds remain **Not configured** even if the flag is set in
a release bundle. Keep the production gate unchanged. A disabled endpoint produces
an unavailable error with no advisory playback and no automatic retry.

## Authentication and request boundary

Once separately activated, Connected preparation requires the dedicated Sensi Supabase
client's genuine, unexpired user session. `auth.getUser(access_token)` verifies the
identity online; a cached session or publishable key alone is insufficient.
Anonymous accounts, unconfirmed email/phone accounts, missing authentication and
identity mismatches fail closed. The Edge Function still re-verifies the user and
owns allowlist/quota enforcement; client checks cannot replace server checks.
The Settings sign-in uses this same dedicated Sensi client. It is visible in
development, or in an explicitly opted-in release pilot build with
`EXPO_PUBLIC_SENSI_PILOT_SIGN_IN=true` (default off). This UI-only flag does not
establish Connected readiness. Settings login verifies the confirmed email account
online and remains session-only; see [the one-request pilot plan](CONNECTED_PILOT.md).
It has its own Auth instance, unique storage key and URL session detection disabled.
The startup login defaults to secure native session persistence; unchecked sign-in
and the Settings sign-in remain memory-only. Device-local
sign-out does not sign out teammates on other devices. No tokens, session storage or
Authorization headers are copied to the upload client in `lib/supabase.ts`.

Profile synchronization, live uploads and deletion retain their existing client and
behavior. This separates request identity; it does not fix existing permissive cloud
policies or add profile ownership/isolation. No shared Auth settings are changed.
After upgrading from the shared-client demo flow, fully restart the app to clear
any previous in-memory upload-client session; do not sign it out during uploads.
## Senior Design startup (development builds only)

Set these non-secret values in the local Expo environment, then restart Metro:

```
EXPO_PUBLIC_SENSI_DEMO_MODE=true
EXPO_PUBLIC_SENSI_DEMO_EMAIL=<existing-confirmed-demo-account-email>
```

The fixed username is `drivesense-demo`; the email is a routing value, not a secret.
No account is created. Mode defaults off and also requires `__DEV__`. Missing email
configuration fails closed with a configuration message. No password belongs in
configuration. Connected readiness is unchanged and remains disabled.

The brief React Native startup splash uses the exact approved PNG; native launch
splash configuration is unchanged. `expo-secure-store ~15.0.8` and its Expo plugin
require an iOS native development rebuild, not a clean project regeneration.

Sensi session storage uses SecureStore/Keychain with
`WHEN_UNLOCKED_THIS_DEVICE_ONLY` on iOS, never SQLite or the upload client's storage.
Only session tokens and a remember preference are persisted, never passwords.
Unchecked login clears any old saved session before authenticating in memory.
Storage errors prevent admission/persistence with generic feedback; there is no
unencrypted fallback. Oversized session values rejected by native storage also fail
closed. Startup verifies the configured confirmed account online, refreshes expired
sessions when possible, and shows login on failure/offline/timeout. Refresh follows
app foreground/background state. Auth expiry or sign-out after admission never
unmounts the dashboard, monitoring or emergency modal; the next cold start checks
again. Settings provides device-local Sensi sign-out. A failed secure deletion must
be retried after resolving the storage error; do not assume saved tokens were erased.

Test checked login by fully terminating and reopening the rebuilt app online;
unchecked login must require credentials after termination. Sign out in Settings,
verify the dashboard stays mounted, then relaunch and expect login. Keychain data
can survive uninstall on iOS: use explicit sign-out, not uninstall, as the cleanup.
This demo gate is not profile access control: existing permissive cloud exposure and
upload behavior remain unchanged. Offline startup with demo enabled does not admit
a saved session; disable demo mode for the original no-auth startup.

The verified user's access token is passed explicitly in the function request's
Authorization header. It is never put in conversation state, history, diagnostics,
request JSON or logs. Identity changes/sign-out invalidate the provider and stop
its conversation. Session changes while awaiting a response discard that response.
No client-wide `setAuth`, function headers or auth/session settings are changed.

Only genuine successful final offline `en-US` recognition with explicit
`isFinal`, `finalResultReceived`, `hasFinalTranscript` and nonempty matching
`finalTranscript` may reach Connected generation. Partial/error/cancelled/timeout
results cannot be uploaded. The shared engine supplies the accepted capture
in memory, separately from its progress-display transcript.

The exact Stage 4A request is `{requestId, transcript, history}`. A fresh UUID owns
one attempted inference; transport retries are not automatic. Current transcript
is bounded by the existing 500-character speech policy. History contains at most
three relevant final driver/advisory pairs (six entries), capped at 1,024 characters
per entry and 12,288 UTF-8 bytes overall. Contact-related pairs, possible numeric
phone strings and links are omitted/rejected. The local context JSON is not sent.
There are no audio, saved-contact name/number, driver profile, medical profile,
recognition diagnostics, location or biometric parameters in the request.
Free speech can still contain personal information; these filters are not a
complete PII detector. Connected processing needs user disclosure before activation.

## Response and safety boundary

The client accepts only the exact Stage 4A success envelope:
`version:1, status:'ok', code:'advisory', advisoryOnly:true, callAuthorized:false,
message:<bounded text>`. Extra fields, authorization/consent/destination/tool fields,
wrong types, unavailable responses and common dialing/number/link content are
rejected. Model-generated authorization is never used. Errors are sanitized;
raw SDK/provider error details are neither logged nor displayed.

The message is mapped to the existing advisory interpretation with both contact
flags false and no model wellness classification. The trusted launch mode selects
`connectedConversationalReply` before playback; LOCAL retains the unchanged
`conversationalReply` vocabulary gate. Connected accepts bounded natural prose and
safe driving reminders, with conservative filters for action claims, medical advice,
unsafe driving, symptom dismissal, diagnostic probing and unconfirmed parking.
Clinical claims and clearance to continue a journey are rejected, including when
negated or quoted. Driving-related sentences must match safe-reminder constructions;
benign acknowledgments use no Local vocabulary allowlist or exact-sentence exception.
The engine supplies stopping context from its deterministic final-speech concern
state. When stopping is required or stopping guidance has already been delivered,
Connected model prose is replaced by deterministic stopping guidance, regardless
of model wellness. Only a whole, affirmative, unquoted safe-stopping sentence can
satisfy model-triggered guidance; a quoted or negated fragment cannot do so.
Rejected or repeated prose receives a neutral acknowledgment or required stopping
guidance, never a request to clarify driver speech. These lexical/structural checks
remain conservative heuristics, not a semantic safety proof; unfamiliar diagnoses,
euphemisms, indirect instructions and missed driver concerns need further adversarial
evaluation. False positives include negated/quoted clinical language and unfamiliar
safe reminders. Driver speech, deterministic guidance and SafetyController remain
the authority for safety and contact actions. Neither policy changes modes.

All direct saved-contact requests, genuine offers, refusals and emergency-services
exclusions still use the driver's final words through the unchanged local
SafetyController handoff. Generated text is never fed back into contact parsing
or treated as driver speech. Each new provider/interaction starts without consent.

## Native I/O and cancellation

Both AI modes use the existing strict on-device `en-US` recognizer and local Apple
voice playback, including the saved Zoe Premium preference. No audio upload or
network-recognition fallback was added. Speech/playback bridge availability and
on-device recognition capability are checked independently of Foundation Models.
Connected therefore does not require Apple Intelligence; LOCAL still does.
Missing native methods or voices remain explicit errors; no silent voice/mode
replacement occurs.

The existing stage/total conversation timeouts, capture retry and audio arbiter
are unchanged. Connected operations additionally have a 25-second overall deadline
covering Auth and generation, an AbortController and ownership checks after awaits.
Cancellation settles even if the SDK transport ignores abort; late replies cannot
reach speech or contact handoff. Closing, ownership loss, safety preemption or
mode changes dispose/stop the old interaction. Server quotas may remain charged
for requests that already reached the backend, even after a client abort.

The voice-timing repair adds native start/finish/idle confirmation and a playback
revision marker. Rebuild the existing iOS development app to apply it; Metro reload
alone cannot update Swift. No native dependency or project regeneration is needed.
The engine already awaits playback before capture. Duplicate safety cleanup now
checks its lease after waiting, so stale cleanup cannot deactivate optional audio.
Use the offline microphone diagnostic in [VOICE_FIXTURE_TEST.md](VOICE_FIXTURE_TEST.md)
to retest the complete opening question before Listening without a backend request.

## Remaining activation work

1. Separately authorize/apply Stage 4A's isolated migration and deploy the function.
2. Provision server-only secrets; invite/confirm demo Auth users and explicitly
   allowlist their Auth UUIDs with expiry. Configure quotas, kill switches,
   provider spending controls and protected operational logging.
3. Verify real user JWTs, unlisted/public-key rejection, database permissions,
   quotas, duplicates, hosted concurrent requests and provider failure behavior.
   Verify the deployed Stage 4A response contract against this client.
4. Establish the dedicated Sensi-client sign-in/session lifecycle and connected
   text-processing disclosure; selecting a local driver profile is not sign-in.
5. After evidence and separate approval, use the iOS development pilot opt-in;
   leave the fixed production gate disabled. Validate both AI modes on a physical iPhone, including Zoe,
   offline recognition, safety preemption, sign-out, mode changes and late replies.

All current provider tests use injected Auth/network fakes. No function invocation,
Auth request, migration, secret configuration or deployment was performed against
a live project while implementing this stage. The Stage 4A files remain unchanged.

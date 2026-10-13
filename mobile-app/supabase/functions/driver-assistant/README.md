# DriveSense Connected AI — Stage 4A

Backend foundation only. Nothing here is deployed, no live secrets are configured,
and the mobile app remains disconnected (`CONNECTED AI — Not configured`).
CORE, LOCAL AI, SafetyController, native audio and telemetry are unchanged by this stage.
Local Stage 2/3 checkpoint: `298d9ba6dc7d270f75cd0ffdbb8446d9d201fc72`.

## Trust boundary and contract

`POST /functions/v1/driver-assistant`, `Content-Type: application/json`,
`Authorization: Bearer <Supabase Auth user access token>`.
A publishable/anon API key in `apikey` is project identification, **not user authentication**.
The handler verifies the bearer against this project's Auth `/user` endpoint,
requires a non-anonymous `authenticated` account with confirmed email or phone,
and checks the database demo allowlist. Caller-supplied user IDs are rejected.
Gateway `verify_jwt = true` provides an additional check; do not bypass handler auth.

Request shape (values below are illustrative, not credentials):

```json
{
  "requestId": "22222222-2222-4222-8222-222222222222",
  "transcript": "I am feeling a little dizzy.",
  "history": [
    { "role": "assistant", "content": "Are you safely parked?" },
    { "role": "user", "content": "No, not yet." }
  ]
}
```

The transcript is at most 2,048 UTF-16 code units; history has at most six entries,
each at most 1,024 code units. Actual request body is capped at 12,288 UTF-8 bytes,
including chunked streams, with a four-second body-read deadline. Unknown keys,
system/tool roles, destination fields, model/instruction overrides, empty content,
invalid UTF-8/JSON, compressed bodies and unsupported HTTP methods/types are rejected.
No browser CORS allowance is configured in this native-only stage.
History is untrusted advisory context; it proves neither parking nor consent.
The backend cannot verify that a transcript came from genuine final recognition.
That remains the deterministic client's responsibility in a later stage.

Every application response, including errors, contains:

```json
{
  "version": 1,
  "advisoryOnly": true,
  "callAuthorized": false,
  "message": "Please pull over when it is safe.",
  "status": "ok",
  "code": "advisory"
}
```

The server creates the authorization fields; they are absent from the model schema.
No action/tool/destination/consent result exists. The provider's only accepted field
is `message`, limited to 600 characters. Tool/refusal/incomplete responses, extra
JSON keys, phone digits/URLs and common dialing/contact language fail closed.
The text filter is conservative and heuristic, not proof that free prose is safe.
Model text **must never** be parsed as contact intent, permission, parking confirmation,
or input to SafetyController. A future client must continue using the driver's
own genuine final transcript and existing deterministic consent controls.
This endpoint neither opens a dialer nor supplies a phone number.

The fixed server model is `gpt-4.1-mini-2025-04-14`, with fixed driving-safety
instructions, a strict JSON schema, no tools, no provider-side conversation state,
`store: false`, a 400-token output cap and a 12-second HTTP timeout. No automatic
provider retries occur. English-only advisory generation is the Stage 4A contract.

## Persistent controls

Migration: `supabase/migrations/202610100001_driver_assistant.sql`. It is a new,
one-time migration, deliberately separate from the existing telemetry SQL bundle.
Do not regenerate `apply_all.sql`, run `revert_all.sql`, or alter telemetry RLS.

The private schema is not exposed through the Data API. All its tables enable RLS,
have no public policies, and revoke privileges from PUBLIC, anon, authenticated
and service_role. Three narrowly scoped public RPCs grant EXECUTE only to
service_role; they run as their migration owner with an empty search path and
fully qualified object names. They return only admission status/booleans.
The Edge Function supplies the identity returned by verified Auth.
Only trusted database administrators manage the allowlist and control row.

All reservations take a row lock on the singleton control row. Limits apply across
users, processes and Edge isolates, not just within one in-memory instance.
Defaults:

| Control | Default |
| --- | --- |
| Environment enable switch | Off unless exactly `true` |
| Database enable switch | `false` |
| Demo allowlist | Empty; each entry also requires enabled + future expiry |
| Per-user day / rolling minute | 30 / 6 requests |
| Global day / rolling minute | 100 / 30 requests |
| Per-user / global concurrent leases | 1 / 4 |
| Lease lifetime | 120 seconds |
| Lifetime global reserved token ceiling | 2,000,000 token units |
| Charge per reservation | 20,000 token units, never refunded |

The token charge conservatively covers the bounded input bytes, fixed instructions
and schema overhead, plus capped output for the fixed text model. Actual token
counts are operational metadata only, never used to refund or weaken admission.
The default lifetime ceiling permits at most 100 attempts until an administrator
explicitly increases it. It does not reset at midnight. Daily windows use UTC;
minute windows are rolling. Model/instruction/size changes require revisiting the
reservation bound and tests. This is a token/request ceiling, not a dollar billing
meter: price changes and usage elsewhere in the OpenAI project remain external.

Reservations remain charged on error, client disconnect, provider timeout or crash.
Lease expiry frees concurrency, but never makes the same `(user, requestId)` reusable.
A keyed HMAC binds the canonical validated request to its request ID without storing
transcript/history. Same ID + same body returns HTTP 409 `duplicate_request`;
same ID + changed body returns 409 `request_conflict`. No response text is cached.
After a lost response the server intentionally cannot replay it, and a new ID
consumes new quota. Do not automatically retry with a new ID.
The second RPC rechecks the switch, allowlist and lease and permits dispatch once.
Terminal/expired/wrong leases cannot dispatch or overwrite another completion.
The kill switch prevents new dispatches; it cannot retract an already sent OpenAI
request or guarantee cancellation/billing of work after a network timeout.

## Required setup — future, separately authorized deployment

1. Choose a Supabase project and review the new migration with its database owner.
   Apply only this migration using the normal tracked migration process. Keep the
   `driver_assistant_private` schema outside exposed Data API schemas. Verify grants,
   RLS and RPC ownership in that project; do not change the permissive telemetry
   policies in this stage.
2. Configure Supabase Auth for invited demo users: require email/phone confirmation,
   disable anonymous sign-in, restrict open signups as appropriate, enable Auth rate
   limits/CAPTCHA for any public signup flow, and use short sessions/secure storage.
   Auth users and DriveSense's local driver profiles are separate identities; a
   selected local profile is not authentication.
3. Through trusted SQL administration only, insert specific **Auth UUIDs** into
   `driver_assistant_private.demo_users` with `enabled=true` and an explicit short
   `expires_at`. Do not allowlist by editable user metadata or local profile name.
   Review per-user caps and the global control row before enabling anything.
4. In Supabase project secrets, provision `OPENAI_API_KEY` and a randomly generated
   `DRIVER_ASSISTANT_FINGERPRINT_KEY` of at least 32 characters. Keep these values
   out of Git, mobile code, `EXPO_PUBLIC_*`, shell history, screenshots and logs.
   Do not use real values in example payloads or test fixtures. The platform must
   supply `SUPABASE_URL` and server-only `SUPABASE_SERVICE_ROLE_KEY`; never ship the
   service role key to a client. No ElevenLabs credentials are needed in Stage 4A.
5. Use a dedicated OpenAI project/service account key with only required model/API
   access. Confirm access to the pinned model, configure provider rate limits,
   usage alerts and appropriate billing controls, and establish an operator who
   can immediately disable/revoke the key. Treat budget alerts as alerts, not a
   substitute for the database ceiling or a guaranteed hard billing stop.
6. Review `supabase/config.toml` and deploy **only** `driver-assistant` with JWT
   verification enabled after separate approval. Do not blindly overwrite an
   existing project's configuration with this function-only file. Validate real
   user JWTs with the project's signing-key configuration; do not solve JWT
   compatibility errors by treating a publishable key as authentication.
7. Keep `DRIVER_ASSISTANT_ENABLED` unset/false and database `enabled=false` until
   integration checks pass. Enabling requires setting the environment switch to
   exactly `true` and the control row to `enabled=true`. Either switch stops new
   dispatches; the database switch requires no function redeploy. Revoke a single
   demo user by disabling their allowlist row or allowing it to expire.
8. On a staging project, test anonymous/publishable-key rejection, confirmed-user
   auth, unlisted/expired users, multi-connection quota races, duplicate IDs,
   provider timeout/refusal, switch revocation and grant isolation. Verify gateway
   and hosting logs do not capture request/response bodies or authorization headers.
   Establish request-volume/cost alerts and platform ingress protections against
   unauthenticated floods; application quotas only protect admitted model calls.
9. Connect the mobile app only in a later stage, preserving local speech, audio
   ownership, cancellation and SafetyController. Do not transfer contact consent
   across providers or derive it from this advisory response.

No above setup or live smoke call has been performed by this stage.

## Operations, privacy and rollback

The function logs only component, fixed outcome code, HTTP status and elapsed time.
The database stores Auth UUID, caller-generated request UUID, keyed fingerprint,
lease/state/timestamps and token counts. It stores no transcripts, history, messages,
phone numbers or credentials. Auth IDs and request timing are still personal
operational metadata: restrict admin access and define retention before deployment.
For this bounded demo, retain request tombstones for the demo lifetime; deleting
rows weakens duplicate prevention and current daily/minute counts. Never reset
`lifetime_reserved_tokens` as routine cleanup. Deleting an Auth user cascades their
ledger rows; the global lifetime ceiling persists. Fingerprint-key rotation makes
old request IDs conflict rather than execute again; rotate deliberately.

`store:false` does not imply zero provider retention: text is still sent to OpenAI.
Review provider data controls, user disclosure/consent for connected processing,
region requirements and hosting log retention before real-driver use. Avoid
transmitting contacts, identifiers, vitals or unrelated personal context; currently
there are no profile/telemetry fields, but user-entered free text may contain PII.

The server service role credential remains powerful elsewhere in the project.
This migration restricts these tables/RPCs but cannot narrow that credential's
project-wide privileges or repair unrelated telemetry policies. Audit access to
Edge secrets and administrator accounts. Auth or database outages fail closed.
The demo is not a production medical assistant or unrestricted public endpoint.

Rollback begins with database `enabled=false`, then disable the environment switch
and remove/disable the function. The mobile app needs no rollback because it was
never connected. Retain quota/idempotency metadata until pending requests have
expired and retention obligations are met. If objects are later removed, drop only
the three `public.driver_assistant_*` functions and `driver_assistant_private` schema
through a reviewed follow-up migration. Do not run the telemetry rollback bundle.

## Local verification

No new dependencies are required. From `mobile-app`:

```sh
node --test tests/driverAssistant.test.ts tests/driverAssistantQuota.test.ts
npm test
npm run typecheck
npm run test:sql
```

HTTP/Auth/provider tests use injected fakes, never real keys or network calls.
Quota tests execute the real SQL in the existing PGlite PostgreSQL dependency,
including denied anon/authenticated grants and unchanged telemetry policy metadata.
PGlite does not replace hosted multi-connection concurrency or Edge gateway testing.
If Deno/Supabase CLI is already available, check the Edge entrypoint and run a local
function smoke test without real provider secrets. Do not install tools merely to
run this stage. No native changes/rebuild are needed.

Official references used for the implementation:

- [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses)
- [Pinned GPT-4.1 mini model](https://developers.openai.com/api/docs/models/gpt-4.1-mini)
- [Supabase Edge authentication](https://supabase.com/docs/guides/functions/auth)
- [Supabase Auth getUser verification](https://supabase.com/docs/reference/javascript/auth-getuser)
- [Supabase database function security](https://supabase.com/docs/guides/database/functions)

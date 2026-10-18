# One-request Connected pilot (not activated)

Target: `zikvdzzxdmusnmpljxsh`. No new Supabase project is required.

## Prepared locally

Release Settings sign-in is now available only with the non-secret build flag
`EXPO_PUBLIC_SENSI_PILOT_SIGN_IN=true`. It is off by default; no environment file
was changed. Rebuild/rebundle the pilot app with that flag when approved. The flag
only exposes session-only login to the dedicated Sensi Auth client. Login verifies
the entered confirmed email account online. It does not alter Connected readiness,
server admission, uploads, driver profiles, or monitoring. No bundled password or
account email is needed. The server allowlist controls which Auth UUID may infer.

The real Connected pilot now has a separate, development-only build opt-in. With
the existing native iPhone development app installed (not Expo Go), stop Metro and
run from `mobile-app` on the Mac:

```sh
EXPO_PUBLIC_SENSI_CONNECTED_PILOT=true npm run start -- --dev-client --lan --clear
```

Open/reload that bundle in the iPhone development app on the same network. Sign in
through the existing startup demo or Settings panel, then choose **CONNECTED AI —
Development pilot** in Settings. No release sign-in flag is needed in development.
The dashboard says backend access is unverified. Do not start a real conversation
until endpoint testing is authorized: Start prepares Auth/voice; a final spoken
answer causes an endpoint attempt, potentially billable if admission is enabled.
This task performed no such attempt. While admission is disabled, expect an
unavailable error, no generated advisory playback, and no automatic retry.

The exact flag is effective only with `__DEV__` and iOS; all release builds remain
blocked. It changes no hosted switch and does not change the fixed
`CONNECTED_BACKEND_READINESS.verified=false`. The synthetic voice diagnostic is
still available separately without a backend request. If the existing native app
lacks the speech bridge, use the established native development rebuild process;
these JavaScript changes add no native dependency or Swift changes.

## Before any activation

1. The team reports the deployed `driver-assistant` source has been downloaded and
   reviewed. Retain that evidence for the pilot version and verify its JWT setting;
   do not repeat the broad audit or redeploy unless an actual mismatch is found.
2. Resolve the known migration-history version discrepancy (`20261010000` hosted
   versus `202610100001` local). Confirm the three `public.driver_assistant_*` RPCs,
   their exact signatures/definitions and service-only permissions using read-only
   inspection. Zero functions in the private table schema is not a missing-RPC test.
3. Confirm existing server configuration without displaying secret values. Do not
   provision or rotate keys for this pilot without separate approval. A successful
   direct OpenAI test does not validate the deployed Edge Function's key or model.
4. Install the intended pilot build, sign in to the one confirmed pilot account,
   and verify installed Zoe Premium is the saved `voice:en` identifier visible to
   the native playback bridge. A missing preferred voice must fail, not substitute.
   Complete fixture playback, Stop/Close and safety-preemption checks while parked.
5. Review connected-text disclosure and separately approve real endpoint testing
   and billable admission. Use only the iOS development pilot flag above; keep
   `CONNECTED_BACKEND_READINESS.verified=false`. The sign-in flag alone cannot
   authorize Connected launch. The team reports one disabled allowlist account,
   database admission off and an empty ledger; confirm those narrow conditions
   immediately before the approved window, without altering them during build prep.

## Approval window for one billable inference

Record the original settings first. A team/database owner must approve the shared
global enable window and identify the account by its verified Auth UUID, not its
local driver profile. No activation or billable request is authorized by this file.

- Environment admission: existing `DRIVER_ASSISTANT_ENABLED` must equal `true`.
- Database admission: `driver_assistant_private.control.enabled` must be `true`.
- Account admission: exactly the intended `driver_assistant_private.demo_users`
  row must have `enabled=true` and a short future `expires_at`. Prefer a dedicated
  existing confirmed pilot account with no other devices using it.
- Bound that row to one additional daily reservation: set `daily_requests` to its
  current UTC-day reservation count plus one (within schema limits),
  `minute_requests=1`, and `concurrent_requests=1`. Ensure the minute window is
  clear. Set expiry before the next UTC midnight and within the approved brief
  window so daily rollover cannot reopen admission. Do not delete ledger rows or
  refund/reset counters. Leave unrelated allowlist entries and global quota values
  untouched. If required capacity is unavailable, stop rather than raise it.

With the approved gate/build and server window in place: choose Connected mode,
start the real conversation, and say only “I feel comfortable and alert today.”
The native final transcript must reach `connectedRequest`; Supabase verifies the
user and reserves/dispatches one request; OpenAI returns an advisory; the real
Connected policy validates it; `speakLocal` uses the saved Zoe voice. Capture only
the outcome, fallback status, voice identity and aggregate admission count—no
credentials or unrelated personal data. Stop after the first reply, especially if
it asks another question. Do not automatically retry a failed/lost response; even
failures consume the one reservation and may have incurred provider cost.

## Immediate shutdown

The approved operator sets the database control `enabled=false` first, then
`DRIVER_ASSISTANT_ENABLED=false`, and disables the pilot allowlist row. This global
shutdown affects other Connected users and must be agreed with the shared-project
owner in advance. Confirm switch state read-only; do not probe by making another
inference. Sign out on the phone and restart Metro/reload the iPhone with
`EXPO_PUBLIC_SENSI_CONNECTED_PILOT=false npm run start -- --dev-client --lan --clear`.
The fixed production gate stays false throughout. Remove any release sign-in
build opt-in for ordinary distribution. Keep quota/idempotency
records and document the single reservation outcome. Disabling admission cannot
retract an OpenAI request that has already dispatched. No table/function removal,
legacy SQL bundle, or migration-history edit belongs in pilot shutdown.

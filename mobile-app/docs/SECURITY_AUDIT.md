# DriveSense — Stage 2D security and release-readiness audit

**Date:** 2026-10-25. **Branch:** `samantha/local-ai-prototype`. **Base HEAD:** `204bc72`, with the existing uncommitted Stage 1–2C work included in this review.

**Disposition: do not distribute an IPA for real/private driver data yet.** The linked backend has confirmed unrestricted database and archive policies. Passing functionality tests does not establish data isolation. Controlled testing should use synthetic profiles/readings in an isolated test environment; this audit does not approve using the shared project for private data. No diagnostics were disabled.

Only this report was added. No application/test code, dependencies, policies, deployed functions, database records, credentials or production settings were changed. No secret values or private user records are included here.

## Scope and evidence

- Inspected mobile Supabase clients, Auth/session utilities, profiles, SQLite, recording/alert/archive upload paths, deletion queues, SQL variants/migrations, Edge Function source, Expo/native configuration, diagnostics, onboarding and phone handoff. Also inspected the website's Supabase query/archive consumers.
- Used the existing authorized Supabase CLI for function metadata, **secret names only**, SELECT-only Postgres catalogs and archive-bucket metadata. The mobile endpoint was privately compared with linked project metadata and matches the inspected project. Root/mobile link metadata also match. Project identifiers and credentials are omitted.
- Deployed inspection covered RLS flags, policy expressions, table grants, ownership-related column names, view options, elevated-function ACL/search-path metadata and bucket settings. No application rows, Auth user records, Storage objects/content, request transcripts or secret values were fetched. No live access-control exploit was attempted.
- Executed the existing suite and a separate in-memory PGlite test with synthetic records. Mutations in that demonstration occurred only in a disposable local database, never Supabase.
- Deployed function **source**, runtime enable-switch values, Auth-provider/password/MFA configuration, logs, actual data contents, other client applications, server backups/retention and the signed/installed IPA remain unverified. Metadata is a point-in-time snapshot, not a complete penetration test.

## Supabase usage and authentication map

| Operation | Implemented client / resources | Authentication and sensitive-data behavior |
| --- | --- | --- |
| Optional demo admission | `components/DemoStartup.tsx`; `lib/assistant/demoAuth.ts`, `demoStartup.ts`, `sensiSupabase.ts` | Password sign-in, online `getUser` validation, expiry/refresh handling and confirmed configured account checks. Enabled only in development with the demo flag. Admission is latched; account changes do not unmount monitoring. This is not a backend data-authorization boundary. |
| Session persistence | `sensiSessionStorage.ts` | Remembered Auth session goes to SecureStore with `WHEN_UNLOCKED_THIS_DEVICE_ONLY`; session-only mode remains in memory. Switching modes deletes the prior credential. Password input is cleared. Sign-out is local scope; it does not revoke other devices. |
| Profile create/edit/retry | `lib/db/repositories.ts`, `profileEditing.ts`, `profileSync.ts` → `driver_profiles` | Local-first, UUID-scoped records. Uses the separate `lib/supabase.ts` client, not the signed-in demo session. `cloudProfile` explicitly excludes emergency contacts but includes identity/demographics, conditions, medications, language and calibration. Profile retries can occur without recording a trip. |
| Live/finished recordings | `liveSync.ts`, `sync.ts` → `drive_sessions`, `telemetry_events`, `drive_alerts`, `threshold_history` | Publishable-key upload client; no user/session-ownership binding. Active uploads run on a JS timer, catch-up retries local finished sessions. Health values, timestamps, quality, alert answers/channels and learned ranges are uploaded. No unrestricted iOS background-execution guarantee. |
| Waveform archive | `archiveStore.ts`, `liveSync.ts` → `session-archives` Storage bucket and `session_archives` metadata | Optional full-waveform mode; compressed PPGA bytes, SHA-256 and metadata. Object key is a bare session UUID plus extension, without owner namespace. Archive metadata includes driver name/profile/session identifiers. Compression/checksums are not encryption or access control. |
| Deletion | `deletion.ts` → profile/session rows and Storage objects | Local rows/cascades first, then cloud delete by UUID, with an offline `pending_deletes` queue. Scope is enforced by what the client knows, not by a cloud owner policy. See H-02. |
| Website dashboard | `website/src/supabase.js`, `lib/data.js`, `lib/realtime.js`, `lib/archive.js` | Source uses a publishable-key client to query profiles, trips, vitals, alerts, baselines/history, legacy readings and download archives. No Auth calls found in the reviewed website source. Deployed website/build configuration was not inspected. |
| Legacy Connected AI | `supabase/functions/driver-assistant` | No current production mobile consumer. Local handler requires an online-validated confirmed, non-anonymous user, then service-only allowlist/quota RPCs. Deployment remains ACTIVE; see M-03. |
| Local safety / Gemma setup | `lib/analysis/safetyController.ts`, `lib/onboarding`, `modules/gemma-poc` | Safety decisions and contact authorization are deterministic. No-recording incident results are transient; local configuration/adaptation may still persist. Gemma uses a verified local model and a restricted acknowledgment task. Model provisioning uses the pinned public Hugging Face URL; legal links point to Google. |

The data client in `lib/supabase.ts:8–14` has `persistSession:false` and is deliberately isolated from `sensiSupabase`. No production sign-in path for that upload client was found. Supabase distinguishes the application's publishable key from a signed-in user's identity; hiding a publishable key cannot supply authorization. [Official API-key guidance](https://supabase.com/docs/guides/getting-started/api-keys).

## Deployed RLS and Storage snapshot

| Reviewed public table | RLS | Effective reviewed policies | Ownership separation |
| --- | --- | --- | --- |
| `driver_profiles` | Enabled | ALL to `anon, authenticated`, unconditional USING/CHECK | None |
| `drive_sessions` | Enabled | Same | None |
| `telemetry_events` | Enabled | Same | None |
| `drive_alerts` | Enabled | Same | None |
| `session_archives` | Enabled | Same | None |
| `threshold_history` | Enabled | Same | None |
| `test_readings` | Enabled | Unrestricted ALL plus additional anonymous read/insert policies | None |
| `incidents` | Enabled | Two unrestricted ALL policies | None |

The reviewed public tables grant SELECT/INSERT/UPDATE/DELETE to both roles. Additional TRUNCATE/REFERENCES/TRIGGER grants also appear and merit least-privilege review; this audit does **not** claim PostgREST exposes a generic TRUNCATE endpoint. The ownership-column scan found no owner/user columns on the public schema. UUIDs and client-side filters do not authorize access. No missing/disabled RLS was observed on the reviewed public/private/Storage table metadata; enabled RLS with unconditional policies is nevertheless open access. `force_rls=false` alone is not a vulnerability or an explanation for the anonymous access.

`session-archives` is private (`public=false`), but deployed Storage policies permit read, insert, update and delete for `anon` and `authenticated` based only on bucket ID. There is no owner/session-membership predicate. File-size and MIME restrictions are unset. A private bucket does not replace object authorization. [Official Storage access-control guidance](https://supabase.com/docs/guides/storage/security/access-control).

Positive deployed controls: `session_summaries`, `active_sessions` and `driver_baselines` use `security_invoker=true`. All three `driver_assistant_private` tables have RLS enabled, no user-facing policies/grants were returned, and their public RPCs grant execute only to postgres/service_role. Those RPCs are SECURITY DEFINER with an empty search path. The legacy `mirror_to_test_readings` function was absent from the inspected function metadata.

## Findings

### C-01 — Critical: unrestricted health/profile database access

- **Affected component/evidence:** Deployed policies/grants above; matching local definitions in `supabase/schema.sql:158–172`, `v3_dashboard.sql:125–173`, `v7_history.sql:26–29`, `legacy_samantha.sql:123–128` and `apply_all.sql`. Policies do not use Auth identity or membership.
- **Confirmed status:** Deployed metadata confirms the authorization defect. A synthetic local run of the actual schema confirmed anonymous reads of both profiles, anonymous modification of another profile, and authenticated reads/deletion across those profiles. No real rows were read or changed.
- **Potential impact:** Disclosure, falsification and deletion of any accessible profile, health measurement, trip, alert and learned-range rows, regardless of user. Legacy emergency-contact columns exist on deployed profiles; their contents were not inspected. Existence of an actual breach is not established.
- **Remediation:** Define user or team/research membership ownership explicitly. Backfill ownership under an approved plan; restrict parent and child policies through verified membership and WITH CHECK predicates; remove every permissive prototype policy, including legacy-table policies. Fix canonical SQL so later application cannot reopen access. Do not equate driver-profile UUID with Auth-user UUID.
- **IPA blocker:** **Yes for private/real data, including teammate personal data.** A login screen or key rotation alone cannot fix it.
- **Deployed verification:** **Yes, policy/grant/schema metadata; not exploit execution.**

### C-02 — Critical: bucket-wide archive read/write/delete authorization

- **Affected component/evidence:** Deployed `storage.objects` policies and bucket settings; `supabase/v3_dashboard.sql:132–148`, `v5_delete.sql:14–16`; upload/download consumers in `lib/db/liveSync.ts:280–319` and `website/src/lib/archive.js:33–36`.
- **Confirmed status:** Policies authorize both client roles across the bucket. At minimum there is no authenticated-user separation; the anonymous role is also explicitly authorized. Storage HTTP requests and actual object contents were not tested.
- **Potential impact:** Access to named drivers' full waveforms and timestamps, replacement/deletion of others' objects, and arbitrary upload/storage-cost abuse. Object hashes do not provide confidentiality or a trusted ownership boundary.
- **Remediation:** Bind each object to an owned session/team, use an owner-aware path/policy, restrict all four operations, and set reasonable size/type limits. Retain the private bucket. Verify object permissions independently of the metadata table.
- **IPA blocker:** **Yes for real waveform data.**
- **Deployed verification:** **Yes, Storage policy and bucket metadata.**

### H-01 — High: demo authentication is disconnected from data authorization

- **Affected component/evidence:** `lib/supabase.ts:8–14`, `lib/assistant/sensiSupabase.ts`, `components/DemoStartup.tsx:10,39,65`, `lib/db/profileSync.ts`, `liveSync.ts`, `deletion.ts`. Deployed owner/user columns are absent.
- **Confirmed status:** Signed-in demo tokens are deliberately not used for profile/telemetry traffic. The only admission screen is development-flag-dependent and is bypassed in release builds. Local profiles, queues and recordings are not scoped to an Auth account; admission remains latched after sign-in. These were design choices, not a newly discovered authentication exploit.
- **Potential impact:** Users may mistake successful login for private data isolation. Sign-out/account expiry does not stop publishable-key uploads; account changes cannot establish ownership of queued data. Simply tightening RLS will break existing anonymous sync unless the client architecture is updated as well.
- **Remediation:** Choose an explicit authorized data owner and bind sync/deletion queues to that identity or approved team/device membership. Check authorization before transmitting/retrying. Preserve offline monitoring, but pause unauthorized cloud operations without losing local data. Separate recording ownership from Auth ownership rather than using profile IDs as credentials.
- **IPA blocker:** **Yes for claims of per-user/private cloud use; not a demand to remove offline local functionality.**
- **Deployed verification:** Client behavior confirmed by code/tests; deployed lack of ownership confirmed by metadata. Actual user/session operations were not exercised.

### H-02 — High: archive deletion can be falsely reported complete

- **Affected component/evidence:** `lib/db/deletion.ts:44–60`. `storage.remove()` returns an error envelope that is ignored; success is determined only by the subsequent row deletion. Pending entries are then dropped.
- **Confirmed status:** Code-level failure path. Current bucket-delete policy exists, but transient Storage failures, permissions changes or server errors can still produce this sequence. No live deletion attempted.
- **Potential impact:** Local/profile/metadata rows disappear while the sensitive uploaded object remains, potentially orphaned and untracked. A successful row delete is not proof the archive was erased.
- **Remediation:** Persist independent row/object deletion progress; inspect Storage errors; retain retryable object tombstones until deletion is confirmed. Test partial success and restart behavior. Review existing orphaned objects later using authorized administrative procedures.
- **IPA blocker:** **Yes before promising complete deletion of real data; synthetic controlled tests can proceed under that limitation.**
- **Deployed verification:** Failure path not exercised remotely; Storage policy presence verified.

### H-03 — High release-verification gap: the reviewed source is not an attested IPA

- **Affected component/evidence:** Dirty working tree at base HEAD `204bc72`; Stage 2C comparison shows committed HEAD still allows rehearsal handoff. Current `lib/voice/phoneHandoff.ts:9–15` blocks simulation/stale provenance. Stage 2B removed native Apple methods and requires a client rebuild. No signed IPA, embedded JS bundle or build provenance was supplied; no `eas.json` release profiles were found. EAS itself is not mandatory—Xcode distribution is also possible.
- **Potential impact:** A teammate build from the older commit or cached JS/native artifacts can omit the safety fixes despite tests passing in this workspace. The development-only 2C marker is not a release artifact attestation.
- **Remediation:** Build from the reviewed snapshot without discarding work, record its source/bundle identity and version/build number, verify the native rebuild and embedded Release bundle, and smoke-test the actual install. Review signing, entitlements, distribution method and update channels for the chosen build process.
- **IPA blocker:** **Yes until the exact distributed artifact is verified.**
- **Deployed verification:** Installed/distributed IPA unverified. Current source and tests verified.

### H-04 — High triage requirement: dependency advisories, including an npm Critical

- **Affected component/evidence:** Read-only `npm audit --json` returned **15 affected package entries: 1 Critical, 10 High, 4 Moderate**. Installed `shell-quote@1.10.0` enters through React Native → react-devtools-core. Other flagged branches include Expo CLI/Metro, node-forge, image-size and undici.
- **Confirmed status:** Installed dependency/advisory match, **not a proven exploitable iPhone runtime path**. Toolchain and development dependencies require separate reachability analysis. The maintainer rates the shell-quote issue High while npm/GitHub's reviewed entry reports Critical; affected versions and the 1.11.0 fix agree. [Maintainer advisory](https://github.com/ljharb/shell-quote/security/advisories/GHSA-pqg4-j6r4-53mv).
- **Potential impact:** Vulnerable command quoting/toolchain or parser/network paths if attacker-controlled inputs reach them. No exploit was executed.
- **Remediation:** Triage runtime versus build/dev-server exposure, select SDK-compatible patches and rerun native/build tests. Do not blindly apply `npm audit fix --force`; the reported graph includes an inappropriate major Expo replacement. No dependency update or automatic fix was made.
- **IPA blocker:** Requires disposition before broad distribution; this finding alone does not establish a remotely exploitable Release IPA. C-01/C-02 independently block real-data release.
- **Deployed verification:** Local dependency tree and advisory service verified; IPA reachability unverified.

### M-01 — Medium: local privacy, retention and backup protection are incomplete/unverified

- **Affected component/evidence:** `lib/db/database.ts:34–43,187–199`, `repositories.ts`, `archiveStore.ts:90–117`, `deletion.ts`. Names, contacts, demographics, medications/conditions, measurements, alerts and archive bytes reside in one SQLite database; full mode initially stores base64 raw frames. There is no application-level database/archive encryption configuration, per-account local partition, automatic retention expiry, backup exclusion or secure-erasure implementation in the reviewed code.
- **Potential impact:** Access on a shared/unlocked device, recovery/backup retention, and longer-than-expected retention. OS device encryption/Data Protection may mitigate this; their effective file attributes and backups were not inspected and are **not claimed disabled**. Querying only the last 180 days for analytics does not delete older data. Pi CSV/SD-card copies are outside phone/cloud deletion scope.
- **Remediation:** Define local access/retention requirements, assess file protection and backup inclusion on-device, minimize stored fields, and implement appropriate locking/encryption/expiry when approved. State deletion scope accurately; SQLite row deletion is not certified secure erasure.
- **IPA blocker:** Conditional for controlled team devices; resolve protection/retention requirements before private-data distribution.
- **Deployed verification:** Local implementation inspected; physical-device/backup behavior and server retention unverified.

### M-02 — Medium: partial uploads can be marked successful without a retryable parent

- **Affected component/evidence:** `lib/db/liveSync.ts:231–238,246–319`; `sync.ts` retries finished sessions only while their session status is local. Alert/history helpers swallow upload errors; archive failure sets a separate status but returns. The parent can still be marked synced and `report(null)` called.
- **Potential impact:** Cloud archives, alerts/history or their metadata can be missing while the trip appears synced; dirty child rows may no longer be selected by normal catch-up. Local copies remain, so this is not demonstrated local data loss.
- **Remediation:** Propagate required child failures, keep retryable work durable and report partial success accurately. Test Storage failure, metadata failure, alert rejection, restart and recovery separately.
- **IPA blocker:** Conditional for controlled testing; blocks a claim of reliable complete off-device recording backup.
- **Deployed verification:** Code path confirmed; live failure injection not performed.

### M-03 — Medium: obsolete OpenAI deployment and secrets remain

- **Affected component/evidence:** Management metadata reports `driver-assistant` **ACTIVE, version 6, verify_jwt=true**. Secret-name listing includes `OPENAI_API_KEY`, `DRIVER_ASSISTANT_ENABLED`, `DRIVER_ASSISTANT_FINGERPRINT_KEY`. Local `supabase/config.toml` still registers the endpoint. `backend.ts`, `handler.ts` and the dedicated migration remain.
- **Confirmed status:** Deployment and secret-name presence verified. **ACTIVE does not prove inference is enabled or billed.** Secret values/validity, kill-switch values, actual traffic, other callers and deployed handler-source equality were not inspected. Current production mobile source has no consumer; test-only retired fixtures are excluded from application imports.
- **Potential impact:** Unnecessary credential/billing/attack surface and an obsolete route capable of sending submitted text to OpenAI if enabled and authorized. Local source rejects unauthenticated/unconfirmed/anonymous users and uses allowlisted service-only quotas; tests pass. Deployed gateway JWT verification is confirmed, but no unauthenticated HTTP invocation was attempted.
- **Remediation:** Follow the retirement plan below; do not infer the deployed endpoint is harmless solely because the mobile client stopped calling it.
- **IPA blocker:** Conditional: obtain an explicit backend disposition before wider distribution. No need to remove Supabase itself.
- **Deployed verification:** Metadata/secret names/RPC ACLs verified; inference enablement, deployed code and end-to-end authorization behavior remain unverified.

### L-01 — Low: controlled-test capabilities remain visible in release UI

- **Affected component/evidence:** `components/SettingsView.tsx` keeps warning simulations, rehearsals and direct-ESP32 bench controls outside development-only guards. Gemma/playback/responsiveness diagnostic panels are guarded by `__DEV__`. Demo admission is also development-only. Generated native ATS allows local networking but not arbitrary loads or domain exceptions; no background modes were configured.
- **Potential impact:** Bench mode can disrupt the intended Pi connection; simulated readings can confuse users or distract them. This is a controlled-test/product-scope concern, not a simulation dialer bypass found in current code.
- **Remediation:** Keep tomorrow's requested controls intact. Decide separately which controls belong in externally distributed builds, and test Release behavior. Rehearsal/simulator origins, promoted fake IDs and stale requests are blocked at the phone boundary; genuine live events preempt simulator warm-up and retain their own consent scope.
- **IPA blocker:** No for controlled teammate testing after higher-severity blockers are addressed/isolated; review before broader distribution.
- **Deployed verification:** Current source/tests verified; installed IPA behavior unverified.

### L-02 — Low: release privacy/purpose wording needs final reconciliation

- **Affected component/evidence:** `app.json` microphone purpose still mentions conversations users start, although Sensi is event-only. Onboarding correctly distinguishes local Gemma inference from Supabase features and labels its notices as prototype notices. The app's “cloud deletion” wording needs reconciliation with H-02.
- **Potential impact:** Misunderstanding of voice behavior, retained health-derived results or deletion completeness. No claim of legally reviewed terms or regulatory compliance is made by this audit.
- **Remediation:** Align permission/distribution notices with the exact build, stored result fields, local/cloud retention and deletion scope. Preserve existing mandatory acknowledgments and model terms.
- **IPA blocker:** Not for informed controlled testing; complete the release/privacy review before broader use.
- **Deployed verification:** Source copy inspected; final store/IPA disclosures unverified.

### I-01 — Informational: credential handling and existing positive controls

- **Evidence/component:** Mobile `.env` is untracked and no tracked history for that path was found. Its configured key class is publishable; the endpoint is HTTPS with no embedded userinfo and matches the inspected project. The example uses placeholders. Pattern scanning of current tracked text found no Supabase secret/service-role JWT, OpenAI secret or private-key material candidates. Values were never printed. This is not an exhaustive scan of every historical Git object or binary artifact.
- **Impact/remediation:** No mobile privileged-secret leak was demonstrated. Do not rotate a legitimate publishable key merely because it ships in a client; fix authorization. Review/revoke unused OpenAI credentials only after confirming other services do not share them. Keep Supabase service/publishable credentials that non-AI services require. Use a full secret-history scanner and inspect the built IPA before release.
- **Blocker/deployed verification:** No standalone blocker from the observed client-key class. Server credential values and IPA embedding were not inspected.
- **Additional positives:** SecureStore session handling, online restored-user validation, parameterized local queries, current contact exclusion from cloud payloads, bounded content-free timing diagnostics, metadata-only local Edge logs, HTTPS configuration, native on-device speech, deterministic consent and verified model provisioning have relevant automated coverage. These do not compensate for C-01/C-02. Raw error messages may still appear in local sync UI; deployed log/crash collection requires separate configuration review.

## Safe OpenAI backend retirement plan — later approval required

1. Inventory all authorized callers, function traffic/billing and shared uses of the OpenAI credential. Do not assume this branch is the only client. Verify deployed handler contents and current kill switches using approved methods.
2. Disable inference using the existing backend controls under a separate approved change; confirm denied/no-provider behavior and allow active work to settle. Recheck that unrelated Auth, profile and recording endpoints are unaffected.
3. Review retention of `driver_assistant_private.control`, `demo_users`, `requests` and RPCs `driver_assistant_reserve`, `driver_assistant_dispatch`, `driver_assistant_complete`. Preserve needed audit/budget/idempotency history until a retention decision; premature deletion weakens existing safeguards.
4. Revoke an OpenAI key only after confirming it is exclusively obsolete. Remove obsolete function secrets/configuration and undeploy the function only when approved. Do not rotate shared Supabase service-role/publishable keys as a substitute.
5. Retire dedicated RPCs/tables/migration deployment entries in a reviewed follow-up. Verify the mobile and website continue functioning with no AI endpoint. No retirement step was executed here.

## Prioritized remediation and validation plan

1. **P0:** Protect the actual linked health tables and Storage objects with an approved ownership/membership model; remove permissive policies in both deployed state and canonical SQL. Until then, no private-data collection/distribution on this project. Use isolated synthetic-only testing when needed.
2. **P1:** Integrate authorized upload/deletion identity and bind queued work to it. Preserve deterministic offline monitoring while preventing unauthorized cloud transmission.
3. **P1:** Fix durable archive deletion and partial-upload retry/reporting; establish retention and orphan reconciliation procedures.
4. **P1:** Produce and verify the exact IPA/JS snapshot and required native rebuild; triage dependency advisories and patch compatible paths before broader release. No automatic SDK downgrade or forced audit fix.
5. **P2:** Carry out approved obsolete-backend retirement, physical-device local-storage/backup review and final privacy/release-control decisions.

Missing regression coverage to add later: real parent/child RLS isolation for two synthetic Auth users plus unauthenticated access, spoofed owner/parent IDs, upsert/delete and relationship changes; bucket listing/download/overwrite/delete and cross-user path attacks; account switching with pending uploads/deletes; expired-token cloud queues; Storage-delete error plus successful row delete; orphan recovery; partial archive/alert/history uploads; final Release IPA gates and source identity; on-device backup/protection behavior. Test with non-owner roles—table owners can bypass ordinary RLS. A passing schema-install test is not an isolation test. [Official RLS guidance](https://supabase.com/docs/guides/database/postgres/row-level-security).

## Checks executed

| Check | Result and limits |
| --- | --- |
| `npm test` | **500 passed, 0 failed**. Includes Auth/session isolation, profile/contact exclusion, service-role-only quota RPCs, deterministic consent, all simulation response methods, platform handoff guards and monitoring/upload integration. |
| `npm run typecheck` | **Passed**. |
| `npm run test:sql` | **35 checks passed**, ALL CHECKS PASSED. Disposable PGlite schema/apply/revert/legacy compatibility, not deployed tenant-isolation certification. |
| Additional temporary local PGlite check | Actual `schema.sql`, synthetic profiles only: anonymous cross-profile read/update and authenticated cross-profile read/delete all permitted. Reproduces C-01 locally; no test file modified. |
| Authorized deployed metadata inspection | Function status/JWT metadata, secret names, RLS/policies/grants, ownership-related columns, view options, RPC ACLs/search paths and bucket settings reviewed. No private records or objects accessed. |
| `npm audit --json` and installed-tree inspection | **15 affected package entries**, reachability not established; no fixes applied. |
| Secret-pattern/config review | No privileged client credential candidate found in reviewed tracked text/mobile env; values suppressed. Scope limits above. |
| Physical IPA/native build | **Not performed**. No native rebuild is needed for this report itself; outstanding Stage 2B native rebuild and artifact verification remain release work. |

This report is an assessment of observed source and authorized metadata, not evidence of a data breach or a blanket certification of Supabase or the distributed application.

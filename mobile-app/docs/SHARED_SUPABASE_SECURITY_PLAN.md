# Shared Supabase authorization design — Stage 2E.1

Date: 2026-10-25. Branch: `samantha/local-ai-prototype`.

**Design only; not authorization to deploy.** This document proposes a shared ownership model and coordinated migration. No policies, schema, functions, credentials, application behavior or deployed data were changed. No real user records, Auth accounts or Storage objects were queried for this design. Existing uncommitted work is preserved.

## 1. Evidence and shared architecture

Starting point: [SECURITY_AUDIT.md](SECURITY_AUDIT.md), particularly its confirmed deployed catalog snapshot: eight public tables have unconditional policies for both `anon` and `authenticated`; the private archive bucket has bucket-only CRUD policies. RLS being enabled and the bucket being private do not currently isolate users. The three reviewed views use `security_invoker=true`. These are the audit's point-in-time findings, not a new inspection of deployed state.

Repository source establishes the following consumers. “No writes found” describes inspected code, not an assurance about every installed/deployed client.

| Consumer and source | Reads | Creates / updates | Deletes | Current cloud identity |
| --- | --- | --- | --- | --- |
| Mobile local database: `lib/db/repositories.ts`, `profileEditing.ts` | Local profiles, trips, readings and alerts | Local SQLite records, offline UUIDs | Local records/cascades | Local driver selection is not Supabase authentication |
| Mobile profile sync: `profileSync.ts` | Local pending records | `driver_profiles` upsert | Through deletion service | Separate publishable-key data client in `lib/supabase.ts`; no production user sign-in found |
| Mobile recording sync: `liveSync.ts`, `sync.ts` | Local trip/archive state | `drive_sessions`, `telemetry_events`, `drive_alerts`, `threshold_history`; archive object and `session_archives` metadata | Through deletion service | Same data client; no verified owner attached to queue |
| Mobile deletion: `deletion.ts` | Local identifiers and archive paths | Durable local pending-delete entries | Cloud profile/session rows and Storage files | Same data client; current queue lacks authorization scope |
| Website: `website/src/supabase.js`, `lib/data.js`, `lib/archive.js` | Profiles, sessions, telemetry, alerts, archive metadata/content, thresholds, summaries/baselines, legacy `test_readings` | **No remote writes found** | **No remote deletes found** | Publishable-key client; no sign-in implementation found |
| Website Realtime: `lib/realtime.js`, `views/dev.js` | Changes for sessions, telemetry, archives, alerts and legacy readings | None | Receives deletion notifications | Same website client |
| Pi: `system/pi/ppg_relay.py`, `ppg_monitor.py`, `ppg-monitor`, `setup_pi.sh` | ESP32/BLE sensor frames and local relay state | BLE relay output; local CSV/JSON logs | No cloud deletion found | No Supabase SDK, direct uploader or cloud identity found in reviewed Pi source |
| Legacy Edge Function: `mobile-app/supabase/functions/driver-assistant` | Auth validation and private quota/allowlist RPCs | Private inference-request ledger through privileged RPCs | No reviewed health-record deletion | Verified caller bearer token; server-side service-role use |
| Historical mobile compatibility contract: `mobile-app/supabase/legacy_samantha.sql` | Profiles, telemetry | Profiles, `test_readings`, `incidents` | Not established | Historical SQL documents client needs; actual older app identity behavior is unverified |

The historical SQL is evidence of an older schema contract, not proof that an older client is still deployed. Other schema evidence includes `mobile-app/supabase/schema.sql`, `v3_dashboard.sql` and `v7_history.sql`; deployment must reconcile these variants rather than treating any single bootstrap file as authoritative.

```text
ESP32 -> Pi BLE relay -> mobile local monitoring / SQLite
                              |
                         recording sync
                              v
                    shared Supabase database + private archives
                              ^
                              |
                    website queries / Realtime / downloads

Legacy AI Edge Function -> separate private quota/request ledger
```

The phone is the reviewed cloud recording uploader. There is no separate recording server in the inspected source. Website source and Pi source are available; installed Pi customizations, externally hosted services, website deployment configuration and other clients remain unverified. JavaScript Map/Set `.delete()` calls in the website cache are not database DELETE operations.

## 2. Authentication model

### Existing behavior

- A publishable key identifies the application/project, not a driver or an authenticated data owner. Current mobile uploads and website queries can execute as `anon` under the audit's permissive policies.
- Optional development demo admission (`components/DemoStartup.tsx`, `lib/assistant/demoAuth.ts`, `sensiSupabase.ts`) uses password sign-in, online user validation and a separate SecureStore-backed Auth client. It does **not** authenticate the data upload client. A shared demo account cannot provide individual ownership isolation.
- Mobile profile UUIDs are created offline; profile selection chooses the data subject. Neither selection, a profile name/custom ID, nor knowledge of a session UUID proves ownership.
- Pi BLE pairing/BlueZ authorization is not Supabase Auth. No direct service-role use was found in Pi or browser/mobile data clients.
- Local legacy Edge source validates the bearer identity before invoking service-only private RPCs. The Stage 2D deployed function source/enable flags were not inspected; its deployment cannot be assumed to match local source.

### Proposed ownership decision — requires team approval

Use **private-by-default data workspaces**, with a personal workspace for each individually authenticated account. Explicit, trusted workspace membership can support approved shared research/team access across website and mobile. A driver is a data subject within a workspace, not necessarily an Auth user. Do not assign `auth.uid()` to a profile ID or invent a `user_id` relationship from table names.

Proposed new authorization entities:

- `workspaces`: stable ownership scope, provisioned by a trusted enrollment path.
- `workspace_memberships`: workspace ID, `auth.users` user ID, active/revoked status and approved role. Clients cannot self-enroll, change their role or assign another user. Membership administration requires a separately authorized server operation.
- Server-stamped creator/uploader IDs are audit attributes, **not substitutes for workspace ownership**. User-controlled metadata, claimed email domains, client IDs and device names must not grant membership.

| Proposed role | Read `R(w)` | Create/update `W(w)` | Delete `D(w)` |
| --- | --- | --- | --- |
| Viewer | Yes | No | No |
| Recorder | Yes | Yes | No |
| Owner/manager | Yes | Yes | Yes, through controlled deletion where needed |
| Anonymous / inactive member / no membership | No | No | No |

These roles are recommendations, not existing product permissions. A personal owner retains legitimate mobile edit/delete ability. An explicitly shared workspace permits authorized sharing; it does not promise isolation between its approved members. If participants require driver-specific consent/access inside a team workspace, add narrower grants before enabling sharing. Until the team resolves this, keep scopes personal and do not migrate everyone into one shared workspace.

Use the same Auth user identity on web and mobile for the same person, with separate properly managed device sessions. Production sign-in must be independent of the development demo gate. The data client must actually carry the authenticated session through a supported SDK lifecycle; do not copy a demo token once and assume refresh/logout synchronization. Preserve local safety and recording without cloud login.

## 3. Table-by-table ownership and policy design

All eight tables need explicit operation policies **to `authenticated` only**, minimum grants, and denial when `auth.uid()` or ownership is absent. Revoke anonymous CRUD. Remove every old permissive policy, including duplicate/legacy policies: permissive policies combine with OR, so adding restrictive-looking policies alongside `USING(true)` will not fix access.

Notation below describes proposed policy predicates, not executable migration SQL:

- `R(w)`, `W(w)`, `D(w)` derive from the current verified `auth.uid()` and active protected membership.
- Parent ownership is resolved through validated foreign keys. No arbitrary caller-supplied `user_id` is accepted by a helper.
- INSERT uses `WITH CHECK`; UPDATE uses both `USING` for the old row and `WITH CHECK` for the new row. SELECT/DELETE use `USING`.
- IDs, parent links, workspace and server audit identity are immutable to ordinary clients. Both UPDATE predicates alone would still allow reparenting between two workspaces the actor belongs to; enforce immutability separately using restricted column privileges and/or validated triggers.

| Table | Intended owner / verified current relationship | SELECT | INSERT | UPDATE | DELETE |
| --- | --- | --- | --- | --- | --- |
| `driver_profiles` | Proposed new `workspace_id`; current profile ID has no verified Auth ownership | `R(workspace)` | `W(workspace)`; trusted membership; server audit stamp | `W(old workspace)` and `W(new workspace)`; immutable ownership/ID | Logical `D(workspace)`; root deletion only through authorized orchestration |
| `drive_sessions` | Workspace of `profile_id -> driver_profiles` | `R(parent workspace)` | `W(parent workspace)`; valid existing parent | `W(old parent)` and `W(new parent)`; immutable profile/ID | Logical `D(parent workspace)`; controlled archive-aware deletion |
| `telemetry_events` | Workspace of `session_id -> drive_sessions -> driver_profiles` | `R(session workspace)` | `W(session workspace)`; valid session | `W(old/new session workspace)`; immutable session/ID | `D(session workspace)` |
| `drive_alerts` | Same session chain | `R(session workspace)` | `W(session workspace)` | `W(old/new session workspace)`; immutable session/ID | `D(session workspace)` |
| `session_archives` | Same session chain; metadata must match canonical object key | `R(session workspace)` | `W(session workspace)`; valid key, size/hash metadata and owned session | `W(old/new session workspace)`; immutable session/key; replacement through controlled protocol | `D(session workspace)` through archive-aware orchestration |
| `threshold_history` | Workspace of `profile_id -> driver_profiles` | `R(profile workspace)` | `W(profile workspace)` | `W(old/new profile workspace)`; immutable profile/ID | `D(profile workspace)` |
| `test_readings` | No current profile/session parent; proposed explicit workspace on bench/test collection | `R(workspace)` | `W(workspace)`; membership verified; `device_name` grants nothing | `W(old/new workspace)`; immutable ownership/ID | `D(workspace)` |
| `incidents` | Proposed authoritative session chain; legacy nullable `session_id` and `telemetry_event_id` are not sufficient validated FKs | `R(valid session workspace)` | `W(session workspace)`; optional telemetry must belong to that session | `W(old/new session workspace)`; immutable links/ID | `D(session workspace)` |

Example policy shape for later implementation:

```sql
-- Conceptual only: helper/schema names and guards do not exist yet.
-- SELECT on driver_profiles: USING (can_read_workspace(workspace_id))
-- INSERT: WITH CHECK (can_write_workspace(workspace_id))
-- UPDATE: USING (can_write_workspace(workspace_id))
--         WITH CHECK (can_write_workspace(workspace_id))
-- PLUS separate immutable ownership/ID and server-audit guards.
-- Child SELECT example: EXISTS an authorized session -> profile chain.
```

Do not grant direct profile/session/archive DELETE merely because a logical DELETE predicate exists: withhold that client operation and use the deletion protocol in section 4. Backend cascades must validate the root scope once and preserve cleanup jobs. For child tables where direct deletion is actually required, grant only the approved role/operation. Website viewers need no write grants. A future website editor requires an explicitly approved role, not unrestricted authenticated access.

Implementation constraints:

1. Index parent FKs and membership lookup keys. Add validated incident FKs and session/telemetry consistency guards. If an incident legitimately has no recorded session, design its separate trusted workspace linkage before admitting it; do not make a nullable parent mean public access.
2. Keep authorization helpers small and auditable. If `SECURITY DEFINER` is needed to avoid recursive membership policies, use a fixed/empty search path, qualified objects, no dynamic SQL, narrowly granted execution and no arbitrary actor parameter. Test with non-owner roles; table owners/service-role bypasses are not RLS tests. Assess `FORCE ROW LEVEL SECURITY` separately; it does not constrain service-role bypass.
3. Protect membership tables and helper execution as part of the same migration. Never let a client grant itself access. Server jobs with bypass privileges must still validate the requesting actor, scope and operation explicitly.
4. Preserve invoker security on `session_summaries`, `active_sessions`, `driver_baselines`; verify aggregates/joins cannot reveal another scope. Review every exposed function/view and grants, not just the eight tables.
5. Profile row access includes sensitive fields. Current `cloudProfile` excludes emergency contacts; do not start uploading them. Existing legacy contact columns need a retention/removal decision and narrower column/view grants if dashboard roles must not see them. RLS alone does not hide selected columns within an allowed row.

### Existing records and backfill

There is no verified ownership column in the audit snapshot. Do not backfill from names, driver selection, UUID possession, timestamps, device names, first login, or the shared demo account. Require an approved administrative provenance map (trusted enrollment/import/device-assignment records, with team confirmation). Propagate verified root ownership down valid parent chains; reconcile incident links separately.

Unowned records, orphans and conflicting links remain inaccessible in a quarantined/admin-only scope until proven. Never assign the whole legacy database to the first user or to a universal research workspace. New ownership may initially be nullable for reconciliation, but policy predicates must deny null ownership. Validate constraints only after isolation/reconciliation; retain unresolved data under restricted retention rather than silently deleting it.

## 4. Storage authorization and synchronization

Bucket: private `session-archives`. Current mobile order in `liveSync.ts` is object upload at `${sessionId}.ppga` with `upsert:true`, then `session_archives` metadata upsert. Website downloads the metadata's `storage_path`. A policy requiring an existing archive metadata row **before the first upload** would break this order.

Recommended first migration keeps canonical existing keys to avoid unnecessary object moves. A key is an identifier, not a secret or ownership claim. Authorize it by exact canonical equality against an existing session and its verified profile/workspace chain. Avoid unsafe UUID parsing of arbitrary paths; malformed/unmatched keys deny access. Prefixes or Storage `owner_id` alone are insufficient, especially for historical anonymous uploads and shared authorized readers.

| Storage operation | Proposed authorization |
| --- | --- |
| SELECT / list / download | Correct bucket and canonical owned-session key; `R(workspace)`. Viewers see committed archive metadata only; authorized writers may inspect their pending session object for retry. Deleting/quarantined sessions deny access. Apply isolation to listing as well as download. |
| INSERT | Correct bucket/key; `W(session workspace)` for an existing, non-deleting session; no arbitrary claimed owner/path. Apply approved object-size and content-type limits. Metadata/content validation is additional to authorization. |
| UPDATE / overwrite / move | Deny direct client changes. Immutable objects simplify integrity and prevent replacing an already published recording. Any exceptional repair needs a separately authorized server protocol and validation. |
| DELETE | Deny direct client deletion; authorize a durable session/profile deletion request with `D(workspace)` and process via trusted cleanup. |

Supabase documents that overwrite/upsert also requires SELECT and UPDATE; therefore denying UPDATE requires changing the mobile upload protocol, not merely changing policies. [Storage access-control documentation](https://supabase.com/docs/guides/storage/security/access-control).

Required upload changes before cutover:

1. Authenticate and bind the local recording/queue to a verified workspace. Upsert the authorized parent profile/session before uploading.
2. Upload with `upsert:false`. On a retry where an object already exists, verify the authorized existing object's bytes/hash/size or a trusted completed receipt; do not overwrite or assume a conflict means success.
3. Publish canonical metadata only after successful content verification/upload. Reject metadata pointing to another session's object, arbitrary paths or another scope. Client checksums express content integrity, not ownership or trustworthy clinical content.
4. Persist per-stage retry state. A parent marked synced must not hide failed child/archive work (Stage 2D partial-upload finding). Do not mark a file synced on denied/failed verification.

Required deletion changes:

- Current `deletion.ts` deletes local rows first and ignores the Storage API error envelope before considering row deletion successful (Stage 2D H-02). Replace this with durable, scope-bound deletion requests; local UX may remain pending while cloud cleanup retries.
- An authenticated request validates `D(workspace)` and records a server-owned deletion job/tombstone containing validated object keys and scope **before** cascading away the parent authorization chain. Mark the session deleting to stop new uploads and re-check permissions at request execution.
- A narrowly trusted worker uses the Storage API, retries idempotently and records completion; then finalize row removal. Do not delete managed Storage metadata directly with SQL. Parent deletion must not strand an object whose ownership can no longer be resolved.
- Never accept arbitrary paths supplied by a caller as deletion authority. Persisted server-authorized jobs survive retries/revocation according to an approved deletion lifecycle; new requests after revocation deny. No service key on phone, browser or Pi.

Existing objects require administrative reconciliation against verified session ownership. Orphan/unmapped objects stay inaccessible. Preserve their restricted cleanup mapping/tombstone until retention decisions are approved; do not infer ownership from Storage uploader fields or make the bucket public to migrate them. Set size/MIME bounds using actual recording requirements, not the unrelated Gemma model size. No objects were enumerated in this task.

## 5. Required consumer changes

### Mobile

- Add proper production Auth for cloud data and a shared authenticated data-client/session lifecycle. Retain offline monitoring, Gemma, recording and emergency authorization independently of cloud login; do not gate safety on Auth or alter Start/End Drive behavior.
- Scope local cloud associations, pending profile/trip uploads, delete queues and receipts to workspace and actor. On logout/account switch, freeze prior queues; account B must never upload/delete account A's work. Do not silently reassign unsynced local profiles. Define an explicit authorized enrollment/import step for previously unassigned local data.
- Handle expired/revoked identities with retryable auth state or denied access; never fall back to anonymous upload. Preserve parent-before-child ordering, adopt immutable archive upload and reliable deletion above.
- Update payload allowlists/schema compatibility intentionally for ownership. Authorization failures must not trigger legacy “strip missing field and retry” behavior that drops required ownership. Distinguish permission errors from optional historical measurement-column compatibility.

### Website

- Add individual sign-in, scope selection from server-authorized memberships, refresh/logout and clear access-denied states. Its existing dashboard needs read access, not blanket writes. No remote writing UI was found; inventory any separate editing website before choosing writer permissions.
- Preserve query/view/archive functionality through RLS. Scope caches (`profileCache`, live store), remove channels and reject stale callbacks on account/workspace changes; clear previous-user data. A denied request is not a missing-schema fallback or a valid empty dashboard.
- Realtime is an independent validation surface. Current global `*` session/alert subscriptions must not be assumed safe after adding row policies, particularly old/deleted-row payloads. Prefer authorized-query refresh/polling initially instead of raw DELETE notifications; alternatively design private workspace Broadcast with server-authorized channel membership. Prove isolation and revocation using the project's deployed Realtime version before retaining raw events. Client filters alone are not authorization. [Realtime limitations and authorization documentation](https://supabase.com/docs/guides/realtime/postgres-changes).

### Pi and other backends

- No direct Pi cloud change is needed for reviewed BLE-only relay code. Inventory actual deployed scripts. If direct ingest exists or is later added, use trusted enrollment mapping device identity to workspace, narrow capabilities and server validation. A shared device label/token must not permit arbitrary profile assignment; do not distribute service-role credentials.
- No separate recording synchronization server was found. Confirm external uploaders and service identities before cutover. Server-mediated access must validate scope even where service-role bypasses RLS.

### Edge Functions

- Keep the legacy AI private ledger isolated; do not repurpose it as a health-record bypass. No current reviewed health CRUD depends on it. Retirement of the deployed legacy AI endpoint is separate approved work.
- The proposed enrollment/deletion endpoints are **new work**, not existing functionality. Review JWT validation, server-derived actor, capability checks, replay/idempotency, concurrency and rate limits. Never trust a body `user_id` or workspace claim without membership validation.

## 6. Compatibility and migration sequence

Anonymous clients cannot retain unrestricted private-data access while closing these vulnerabilities. A coordinated cloud maintenance window or explicit rejection of old clients is preferable to insecure compatibility. Local safety/recording should continue and queue work during cloud interruption. The audit's current exposure needs separately approved containment; this design is not permission to leave real private data exposed until a convenient release.

1. **Agree on authority:** confirm owner/workspace model, roles, shared-research consent, deployed client inventory and reliable historical provenance. No production backfill until approved.
2. **Build isolated staging:** synthetic accounts/records only; create proposed ownership entities, helper/immutability guards, strict table/Storage grants, authorized views and scoped deletion worker. Test migration from representative *synthetic* legacy null/orphan/conflict states.
3. **Prepare compatible clients:** mobile Auth/queues/archive protocol and website Auth/cache/Realtime changes. Review external services. Pin tested artifacts and give old clients a clear cloud-unavailable/upgrade state, without disabling local safety.
4. **Coordinate fail-closed production maintenance:** pause cloud writers/readers; restrict access rather than preserving permissive policies. Back up data/configuration into restricted administrative storage. Record policy/grant/function definitions without putting secrets or real records in Git.
5. **Reconcile ownership administratively:** approved root mappings, child/incident consistency, object mappings and tombstones. Isolate unknowns, validate FKs/immutability, index joins. Unresolved rows remain denied.
6. **Apply reviewed strict cutover:** remove all unconditional/duplicate/legacy policies and unnecessary grants; install the complete policy set and Storage rules, membership protection, invoker views and reviewed Realtime configuration. Make changes transactionally where supported; Storage/client/server changes need coordinated staging rather than assuming one cross-service transaction. Prevent writes during gaps.
7. **Canary with synthetic A/B users:** validate actual authenticated mobile/web/Storage flows, failure/retry/deletion and Realtime; inspect only synthetic test records. Reopen supported clients after the isolation matrix passes. Monitor denied operations without logging health payloads/tokens.
8. **Retire insecure migration entry points:** review SQL bootstrap/revert scripts that reinstall permissive policies. A fresh environment and any restore must get the hardened schema/policies. Update operational instructions so nobody inadvertently reopens access.

Do not stage permissive anonymous policies as a temporary fallback. Restrict or pause cloud functionality when a compatible client is unavailable.

## 7. Validation strategy

No application tests were changed or executed for this design-only document. Prior Stage 2D results are evidence of the prior audit, not validation of these proposed policies. Required implementation gates follow.

Create synthetic Auth users A/B in distinct private workspaces; explicit shared viewer C; recorder without delete; revoked member; anonymous client. Use real signed-in SDK sessions in isolated staging and non-owner SQL roles/claims for policy tests. Service-role success cannot demonstrate RLS isolation.

| Test area | Required assertions |
| --- | --- |
| All eight tables | A can perform approved operations on A; A cannot SELECT/INSERT/UPDATE/DELETE B, even knowing IDs. Anonymous users deny. Viewer writes and recorder deletes deny. Test update/upsert conflicts and RETURNING/join behavior. |
| Ownership integrity | Spoofed workspace/creator, client self-membership, cross-parent links and parent reassignment deny, including actors who belong to both scopes. Null ownership, orphan legacy rows, inconsistent incident telemetry/session deny. |
| Views / website | Profiles, summaries, baselines, history, sessions, alerts and archives work for authorized identities; no B rows or aggregate leakage. Legacy fallback queries retain isolation. Test viewer write denial; any approved website editor separately needs positive/negative write tests. |
| Mobile uploads | Profile-first, live/finished trip, telemetry, alerts, thresholds, archive object-before-metadata and repeated retry work under authenticated identities. Missing Auth/revocation deny without anonymous fallback. Partial child upload remains retryable. |
| Account lifecycle | Offline A queue cannot run as B after logout/switch; expired/revoked membership cannot upload/delete. Caches/channels clear; stale callbacks do not show previous-account data. Authorized A reconnect can retry idempotently. |
| Storage | Own download/list/upload works; cross-user listing/download/writes deny. Spoofed owner fields, arbitrary paths, wrong session keys, malformed paths and orphan objects deny. Oversize/disallowed uploads reject. No direct overwrite/move/delete. Duplicate retries verify existing content; never overwrite silently. |
| Durable deletion | Authorized owner requests succeed; unauthorized/stale new requests deny. Storage failure remains pending; retries eventually remove both content and rows. Parent cascades cannot lose cleanup authority. Concurrent upload/delete is serialized/rejected safely. |
| Realtime | A never receives B payloads, IDs or old/deleted records. Token refresh, membership revocation, reconnect and workspace switch tested. If these cannot be proved, use authorized polling instead. |
| Privileged services | Enrollment derives actor from validated Auth. Deletion worker cannot be coerced to delete arbitrary objects. Service credentials remain server-only; public RPC grants and search paths audited. |
| Safety independence | Offline/no-login/denied cloud sync does not change deterministic monitoring, VoiceCheck, Gemma allowlist or emergency consent; simulated checks remain unable to dial. |

Run existing mobile tests/TypeScript checks, website build/tests and new local policy tests during implementation; then synthetic end-to-end staging tests with the actual Auth, PostgREST, Storage and Realtime services. Include supported old-client failure behavior. Production validation must not query real user records for this task.

## 8. Rollback strategy

- Keep reviewed hardened schema/policy definitions and compatible client/server artifacts versioned in the implementation phase. Backups and mapping exports remain restricted, outside Git.
- Roll back only to a version that preserves isolation and immutable ownership. Never restore `USING(true)`, anonymous CRUD, bucket-only authorization, public archives or a client service key.
- If the migration or new client fails, return cloud access to maintenance/deny-by-default, retain local queues and safety behavior, and repair forward. An old anonymous client is not a safe rollback target.
- Preserve ownership mappings, deletion jobs/tombstones and unresolved-record quarantine across rollback/restore. Do not undo object deletion by restoring stale metadata alone; reconcile actual Storage state and retain audit history.
- Re-run synthetic A/B/anonymous and upload/delete isolation checks after any restore before reopening access. Define an approved maintenance window and release rollback owner before deployment.

## 9. Team decisions and remaining unknowns

1. Who legally/operationally owns a driver's records: personal account, research organization, or another controller? Is sharing workspace-wide or driver-specific, and what consent permits website access?
2. Who may create/edit/delete profiles, trips, thresholds and historical incidents? Are viewers allowed demographics, conditions/medications and legacy emergency contacts? What retention/legal holds apply?
3. Which older mobile builds, deployed website versions, custom Pi scripts, external uploaders and service-role consumers still use this project? Current repository source cannot establish that inventory.
4. Which trusted records can establish historical ownership? What is the disposition of unprovable rows/objects? No production contents were inspected to answer this.
5. How are offline/unassigned local profiles enrolled without allowing arbitrary cloud claims? Are shared phones/wheels and participant-without-account workflows required?
6. What production Auth enrollment/recovery/provider/MFA policy replaces optional shared demo admission? Deployed Auth configuration was not verified in the audit.
7. Is archive replacement genuinely necessary? What recording size/type limits are appropriate? Who operates the authorized deletion worker, retention jobs and restricted backups?
8. Which Realtime strategy/version can prove deleted-event and revocation isolation? Are polling latency/cost acceptable initially?
9. Who approves maintenance, client minimum versions, migration/backfill and rollback? What happens to legacy clients and pending local work during cutover?

## 10. Recommended implementation boundary

Approve the ownership and sharing decisions first. Then implement production Auth plus scoped queues, strict parent-derived RLS, immutable archive uploads and durable authorized deletion together in isolated staging. Website authentication/read compatibility is a required part of the same release. Pi BLE relay and deterministic safety/Gemma require no authorization redesign. This document does not implement or approve deployed remediation.

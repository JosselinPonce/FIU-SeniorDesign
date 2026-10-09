/**
 * Pushes locally recorded drives to Supabase.
 *
 * Design rules this follows, in order of importance:
 *
 * 1. **Local SQLite is the source of truth.** Sync is a background convenience.
 *    A failed upload must never lose or alter a recorded drive, so nothing here
 *    deletes local rows — it only advances `sync_status`.
 * 2. **Idempotent by construction.** Every row already carries a phone-generated
 *    UUID, so uploads are `upsert`s keyed on that id. Re-running after a partial
 *    failure re-sends the same rows harmlessly; no duplicates, no ID remapping.
 * 3. **Parents before children.** Profiles, then sessions, then telemetry, so a
 *    foreign key never points at a row that has not landed yet.
 * 4. **Manual catch-up.** The active session is streamed by liveSync.ts; this
 *    uploads whatever that missed (drives recorded offline, failed pushes).
 *    The app stays fully usable with the radio off either way.
 */
import { syncProfiles } from './profileSync';
import { getDatabase } from './database';
import { LiveUploader } from './liveSync';
import { processPendingDeletes } from './deletion';

export type SyncResult = {
  profiles: number;
  sessions: number;
  events: number;
  errors: string[];
};

/**
 * Uploads every finished session that is still `local` -- drives recorded
 * with no signal, or whose final live push failed. Each goes through the same
 * path as the end of a live drive (LiveUploader.finish): profile, session,
 * telemetry, alerts, then the folded archive to Storage.
 *
 * Only *finished* sessions: an active one is being streamed live already.
 */
export async function syncToSupabase(): Promise<SyncResult> {
  await processPendingDeletes(); // deletions made offline go first
  const db = await getDatabase();
  const pending = await db.getAllAsync<{ id: string; n: number }>(
    `SELECT s.id, (SELECT COUNT(*) FROM telemetry_events e
                   WHERE e.session_id = s.id AND e.sync_status = 'local') AS n
     FROM drive_sessions s
     WHERE s.sync_status = 'local' AND s.status != 'active'
     ORDER BY s.started_at`,
  );
  const profileResult = await syncProfiles();
  const result: SyncResult = { ...profileResult, sessions: 0, events: 0 };
  const up = new LiveUploader(() => 'pi_lost');
  for (const s of pending) {
    await up.finish(s.id);
    if (up.status.lastError) {
      result.errors.push(up.status.lastError);
      break; // offline: the rest would fail the same way
    }
    result.sessions += 1;
    result.events += s.n;
  }
  return result;
}

/** How much is waiting to upload, for a "Sync (N)" button. */
export async function pendingCount(): Promise<{ profiles: number; sessions: number; events: number }> {
  const db = await getDatabase();
  const s = await db.getFirstAsync<{ c: number }>(
    `SELECT COUNT(*) AS c FROM drive_sessions
     WHERE sync_status = 'local' AND status != 'active'`,
  );
  const e = await db.getFirstAsync<{ c: number }>(
    "SELECT COUNT(*) AS c FROM telemetry_events WHERE sync_status = 'local'",
  );
  const p = await db.getFirstAsync<{ c: number }>("SELECT COUNT(*) AS c FROM app_settings q JOIN driver_profiles p ON q.key = 'profile_sync:' || p.id");
  return { profiles: p?.c ?? 0, sessions: s?.c ?? 0, events: e?.c ?? 0 };
}

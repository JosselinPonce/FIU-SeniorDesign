/**
 * Deleting data -- on this phone AND in Supabase.
 *
 *   deleteDriverEverywhere   a driver, all their drives, readings, alerts and
 *                            waveform archives
 *   deleteDriveEverywhere    one drive (session)
 *   wipeEverything           every driver this phone knows about
 *
 * Local rows go first and immediately (SQLite cascades from the profile).
 * Then the cloud: the row delete cascades through drive_sessions →
 * telemetry_events / drive_alerts / session_archives (ON DELETE CASCADE in
 * schema.sql / v3_dashboard.sql), and the .ppga files are removed from the
 * 'session-archives' bucket (needs supabase/v5_delete.sql for the Storage
 * delete policy).
 *
 * Offline? The cloud part is queued (app_settings 'pending_deletes') and
 * retried by processPendingDeletes() at start-up and on every manual sync, so
 * a deletion is never silently forgotten.
 *
 * Scope: only records this phone created/knows. A teammate's drivers on
 * another phone are never touched.
 */
import { supabase } from '../supabase';
import { getDatabase } from './database';
import { getSetting, setSetting } from './repositories';
import { ARCHIVE_BUCKET } from './liveSync';

type Pending = { table: 'driver_profiles' | 'drive_sessions'; id: string; files: string[] };

async function readQueue(): Promise<Pending[]> {
  try {
    const v = JSON.parse((await getSetting('pending_deletes')) ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

async function writeQueue(q: Pending[]) {
  await setSetting('pending_deletes', JSON.stringify(q));
}

/** One cloud deletion. Returns true when the server confirmed it. */
async function cloudDelete(p: Pending): Promise<boolean> {
  try {
    if (p.files.length) {
      // Best effort: without the v5 Storage policy this is refused, and the
      // row delete below still removes everything the dashboard shows.
      await supabase.storage.from(ARCHIVE_BUCKET).remove(p.files);
    }
    const { error } = await supabase.from(p.table).delete().eq('id', p.id);
    return !error;
  } catch {
    return false;
  }
}

async function deleteOrQueue(p: Pending): Promise<'cloud' | 'queued'> {
  if (await cloudDelete(p)) return 'cloud';
  await writeQueue([...(await readQueue()), p]);
  return 'queued';
}

/** Retries queued cloud deletions. Safe to call any time. */
export async function processPendingDeletes(): Promise<number> {
  const q = await readQueue();
  if (!q.length) return 0;
  const left: Pending[] = [];
  for (const p of q) if (!(await cloudDelete(p))) left.push(p);
  await writeQueue(left);
  return q.length - left.length;
}

export async function pendingDeleteCount(): Promise<number> {
  return (await readQueue()).length;
}

const archivePath = (sessionId: string) => `${sessionId}.ppga`;

export async function deleteDriverEverywhere(profileId: string): Promise<'cloud' | 'queued'> {
  const db = await getDatabase();
  const sessions = await db.getAllAsync<{ id: string }>('SELECT id FROM drive_sessions WHERE profile_id = ?', [profileId]);
  await db.withTransactionAsync(async () => {
    // Explicit child deletes as well as the FK cascade, so an install whose
    // foreign keys were created without ON DELETE CASCADE is still cleaned.
    for (const s of sessions) {
      await db.runAsync('DELETE FROM telemetry_events WHERE session_id = ?', [s.id]);
      await db.runAsync('DELETE FROM drive_alerts WHERE session_id = ?', [s.id]);
      await db.runAsync('DELETE FROM session_archives WHERE session_id = ?', [s.id]);
    }
    await db.runAsync('DELETE FROM drive_demo_events WHERE profile_id = ?', [profileId]);
    await db.runAsync('DELETE FROM drive_sessions WHERE profile_id = ?', [profileId]);
    await db.runAsync('DELETE FROM driver_profiles WHERE id = ?', [profileId]);
    await db.runAsync("DELETE FROM app_settings WHERE key = ?", [`ack:${profileId}`]);
  });
  return deleteOrQueue({ table: 'driver_profiles', id: profileId, files: sessions.map((s) => archivePath(s.id)) });
}

export async function deleteDriveEverywhere(sessionId: string): Promise<'cloud' | 'queued'> {
  const db = await getDatabase();
  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM telemetry_events WHERE session_id = ?', [sessionId]);
    await db.runAsync('DELETE FROM drive_alerts WHERE session_id = ?', [sessionId]);
    await db.runAsync('DELETE FROM session_archives WHERE session_id = ?', [sessionId]);
    await db.runAsync('DELETE FROM drive_demo_events WHERE session_id = ?', [sessionId]);
    await db.runAsync('DELETE FROM drive_sessions WHERE id = ?', [sessionId]);
  });
  return deleteOrQueue({ table: 'drive_sessions', id: sessionId, files: [archivePath(sessionId)] });
}

/** Deletes every driver (and everything under them) on this phone and in the
 *  cloud. App preferences (voice, storage mode) are kept. */
export async function wipeEverything(): Promise<{ drivers: number; queued: number }> {
  const db = await getDatabase();
  const drivers = await db.getAllAsync<{ id: string }>('SELECT id FROM driver_profiles');
  let queued = 0;
  for (const d of drivers) if ((await deleteDriverEverywhere(d.id)) === 'queued') queued += 1;
  // Anything orphaned (e.g. sessions of a profile deleted by an older build).
  await db.execAsync('DELETE FROM telemetry_events; DELETE FROM drive_alerts; DELETE FROM session_archives; DELETE FROM drive_demo_events; DELETE FROM drive_sessions;');
  return { drivers: drivers.length, queued };
}

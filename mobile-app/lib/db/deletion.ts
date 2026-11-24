import { STANDALONE_DEMO } from '../buildProfile';
import { telemetryAllowed } from './telemetryPolicy';
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
import { serializeCloudWrite } from './cloudWrites';
import { driverIntroKey } from '../onboarding/driverProgress';
import { profileSyncKey } from './profileEditing';
import { ARCHIVE_BUCKET } from './liveSync';

type Pending = { table: 'driver_profiles' | 'drive_sessions'; id: string; files: string[] };

async function readQueue(): Promise<Pending[]> {
  const v = JSON.parse((await getSetting('pending_deletes')) ?? '[]');
  if (!Array.isArray(v)) throw new Error('Pending deletion queue is unavailable.');
  return v;
}

async function writeQueue(q: Pending[]) {
  await setSetting('pending_deletes', JSON.stringify(q));
}

/** One cloud deletion. Returns true when the server confirmed it. */
async function cloudDelete(p: Pending): Promise<boolean> {
  if (!await telemetryAllowed()) return false;
  try {
    const files = new Set(p.files);
    if (p.table === 'driver_profiles') {
      const result = await supabase.from('drive_sessions').select('id,session_archives(storage_path)').eq('profile_id', p.id);
      if (result.error) return false;
      for (const session of result.data ?? []) {
        if (session.session_archives && (Array.isArray(session.session_archives) ? session.session_archives.length > 0 : true)) {
          files.add(archivePath(session.id));
        }
      }
    }
    if (files.size) {
      const storage = await supabase.storage.from(ARCHIVE_BUCKET).remove([...files]);
      if (storage.error) return false;
    }
    const { error } = await supabase.from(p.table).delete().eq('id', p.id);
    return !error;
  } catch {
    return false;
  }
}

async function settle(p: Pending): Promise<'cloud' | 'queued' | 'local'> {
  try {
    if (!await cloudDelete(p)) return 'queued';
    await writeQueue((await readQueue()).filter(item => item.table !== p.table || item.id !== p.id));
    return 'cloud';
  } catch { return 'queued'; }
}

export function processPendingDeletes(): Promise<number> {
  return serializeCloudWrite(async () => {
    if (!await telemetryAllowed()) return 0;
    const queue = await readQueue();
    const left: Pending[] = [];
    for (const item of queue) if (!await cloudDelete(item)) left.push(item);
    if (queue.length) await writeQueue(left);
    return queue.length - left.length;
  });
}

export async function pendingDeleteCount(): Promise<number> {
  return (await readQueue()).length;
}

const archivePath = (sessionId: string) => `${sessionId}.ppga`;

export function deleteDriverEverywhere(profileId: string, onLocalDeleted?: () => Promise<void>): Promise<'cloud' | 'queued' | 'local'> {
  return serializeCloudWrite(async () => {
    const db = await getDatabase();
    const queue = STANDALONE_DEMO ? null : await readQueue();
    let item!: Pending;
    await db.withExclusiveTransactionAsync(async tx => {
      const profile = await tx.getFirstAsync<{ id: string }>('SELECT id FROM driver_profiles WHERE id = ?', [profileId]);
      if (!profile) throw new Error('The selected driver is no longer available.');
      const sessions = await tx.getAllAsync<{ id: string; status: string; storage_mode: string }>(
        'SELECT id, status, storage_mode FROM drive_sessions WHERE profile_id = ?', [profileId]);
      if (sessions.some(session => session.status === 'active')) throw new Error('End and save the current drive before deleting this driver.');
      item = { table: 'driver_profiles', id: profileId, files: sessions.filter(s => s.storage_mode === 'full').map(s => archivePath(s.id)) };
      for (const s of sessions) {
        await tx.runAsync('DELETE FROM telemetry_events WHERE session_id = ?', [s.id]);
        await tx.runAsync('DELETE FROM drive_alerts WHERE session_id = ?', [s.id]);
        await tx.runAsync('DELETE FROM session_archives WHERE session_id = ?', [s.id]);
      }
      await tx.runAsync('DELETE FROM drive_demo_events WHERE profile_id = ?', [profileId]);
      await tx.runAsync('DELETE FROM ask_sensi_chats WHERE profile_id = ?', [profileId]);
      await tx.runAsync('DELETE FROM threshold_history WHERE profile_id = ?', [profileId]);
      await tx.runAsync('DELETE FROM drive_sessions WHERE profile_id = ?', [profileId]);
      await tx.runAsync('DELETE FROM driver_profiles WHERE id = ?', [profileId]);
      await tx.runAsync('DELETE FROM app_settings WHERE key IN (?, ?, ?, ?, ?, ?, ?)', [
        `ack:${profileId}`, `trend:${profileId}`, driverIntroKey(profileId), profileSyncKey(profileId),
        `sensi:launcher-position:${profileId}`, `caln:${profileId}`, `storage_mode:${profileId}`,
      ]);
      if (queue) await tx.runAsync("INSERT INTO app_settings(key,value) VALUES ('pending_deletes', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [JSON.stringify([...queue, item])]);
    });
    // Publish the committed local change before waiting on the remote copy.
    await onLocalDeleted?.();
    return STANDALONE_DEMO ? 'local' : settle(item);
  });
}

export function deleteDriveEverywhere(sessionId: string, profileId: string): Promise<'cloud' | 'queued' | 'local'> {
  return serializeCloudWrite(async () => {
    const db = await getDatabase();
    const queue = STANDALONE_DEMO ? null : await readQueue();
    let item!: Pending;
    await db.withExclusiveTransactionAsync(async tx => {
      const session = await tx.getFirstAsync<{ status: string; storage_mode: string }>(
        'SELECT status, storage_mode FROM drive_sessions WHERE id = ? AND profile_id = ?', [sessionId, profileId]);
      if (!session || session.status === 'active') throw new Error('This drive is unavailable for the selected driver.');
      item = { table: 'drive_sessions', id: sessionId, files: session.storage_mode === 'full' ? [archivePath(sessionId)] : [] };
      await tx.runAsync('DELETE FROM telemetry_events WHERE session_id = ?', [sessionId]);
      await tx.runAsync('DELETE FROM drive_alerts WHERE session_id = ?', [sessionId]);
      await tx.runAsync('DELETE FROM session_archives WHERE session_id = ?', [sessionId]);
      await tx.runAsync('DELETE FROM drive_demo_events WHERE session_id = ?', [sessionId]);
      await tx.runAsync('DELETE FROM drive_sessions WHERE id = ? AND profile_id = ?', [sessionId, profileId]);
      if (queue) await tx.runAsync("INSERT INTO app_settings(key,value) VALUES ('pending_deletes', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [JSON.stringify([...queue, item])]);
    });
    return STANDALONE_DEMO ? 'local' : settle(item);
  });
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

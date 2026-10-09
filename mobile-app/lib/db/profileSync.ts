import { getDatabase } from './database';
import { supabase } from '../supabase';
import type { DriverProfile } from './repositories';
import { cloudProfile, profileSyncKey, retryProfiles } from './profileEditing';

let running: Promise<{ profiles: number; errors: string[] }> | null = null;
export function syncProfiles() {
  if (running) return running;
  running = (async () => {
    const db = await getDatabase();
    // Remove markers for deleted drivers without recreating them in the cloud.
    await db.runAsync("DELETE FROM app_settings WHERE key LIKE 'profile_sync:%' AND substr(key, 14) NOT IN (SELECT id FROM driver_profiles)");
    return retryProfiles({
      pending: async () => {
        const rows = await db.getAllAsync<DriverProfile & { revision: string }>(
          "SELECT p.*, q.value AS revision FROM driver_profiles p JOIN app_settings q ON q.key = 'profile_sync:' || p.id ORDER BY p.updated_at");
        return rows.map(({ revision, ...profile }) => ({ profile, revision }));
      },
      upload: async profile => {
        const latest = await db.getFirstAsync<DriverProfile>('SELECT * FROM driver_profiles WHERE id = ?', [profile.id]);
        if (!latest) return null;
        const { error } = await supabase.from('driver_profiles').upsert(cloudProfile(latest), { onConflict: 'id' });
        return error?.message ?? null;
      },
      acknowledge: async (id, revision) => {
        await db.runAsync('DELETE FROM app_settings WHERE key = ? AND value = ?', [profileSyncKey(id), revision]);
      },
    });
  })().finally(() => { running = null; });
  return running;
}

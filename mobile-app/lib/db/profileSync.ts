import { telemetryAllowed } from './telemetryPolicy';
import { serializeCloudWrite } from './cloudWrites';
import { getDatabase } from './database';
import { supabase } from '../supabase';
import type { DriverProfile } from './repositories';
import { cloudProfile, profileSyncKey, retryProfiles } from './profileEditing';

const running = new Map<string | undefined, Promise<{ profiles: number; errors: string[] }>>();
export function syncProfiles(profileId?: string) {
  const existing = running.get(profileId);
  if (existing) return existing;
  const upload = (async () => {
    if (!await telemetryAllowed()) return { profiles: 0, errors: [] };
    const db = await getDatabase();
    // Remove markers for deleted drivers without recreating them in the cloud.
    await db.runAsync("DELETE FROM app_settings WHERE key LIKE 'profile_sync:%' AND substr(key, 14) NOT IN (SELECT id FROM driver_profiles)");
    return retryProfiles({
      pending: async () => {
        const rows = await db.getAllAsync<DriverProfile & { revision: string }>(
          "SELECT p.*, q.value AS revision FROM driver_profiles p JOIN app_settings q ON q.key = 'profile_sync:' || p.id WHERE (? IS NULL OR p.id = ?) ORDER BY p.updated_at", [profileId ?? null, profileId ?? null]);
        return rows.map(({ revision, ...profile }) => ({ profile, revision }));
      },
      upload: profile => serializeCloudWrite(async () => {
        const latest = await db.getFirstAsync<DriverProfile>('SELECT * FROM driver_profiles WHERE id = ?', [profile.id]);
        if (!latest) return null;
        const { error } = await supabase.from('driver_profiles').upsert(cloudProfile(latest), { onConflict: 'id' });
        return error?.message ?? null;
      }),
      acknowledge: async (id, revision) => {
        await db.runAsync('DELETE FROM app_settings WHERE key = ? AND value = ?', [profileSyncKey(id), revision]);
      },
    });
  })().finally(() => { running.delete(profileId); });
  running.set(profileId, upload);
  return upload;
}

import { STANDALONE_DEMO, TELEMETRY_HOLD_KEY } from '../buildProfile';
import { getDatabase } from './database';

export type TelemetryMode = 'available' | 'standalone' | 'held';

export async function telemetryMode(): Promise<TelemetryMode> {
  if (STANDALONE_DEMO) return 'standalone';
  try {
    const db = await getDatabase();
    const hold = await db.getFirstAsync<{ value: string }>('SELECT value FROM app_settings WHERE key = ?', [TELEMETRY_HOLD_KEY]);
    return hold?.value === 'true' ? 'held' : 'available';
  } catch { return 'held'; }
}

export async function telemetryAllowed(): Promise<boolean> {
  return await telemetryMode() === 'available';
}

/** Called only after explicit confirmation in a non-demo build. */
export async function resumeTelemetry(): Promise<boolean> {
  if (STANDALONE_DEMO) return false;
  const db = await getDatabase();
  await db.runAsync('DELETE FROM app_settings WHERE key = ?', [TELEMETRY_HOLD_KEY]);
  return true;
}

/** Boundary around every transport operation on the shared telemetry client. */
export function guardTelemetryFetch(fetcher: typeof fetch): typeof fetch {
  return async (input, init) => {
    if (!await telemetryAllowed()) throw new Error('Shared telemetry synchronization is disabled.');
    return fetcher(input, init);
  };
}

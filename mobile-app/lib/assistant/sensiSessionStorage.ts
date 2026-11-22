/** Sensi-only storage adapter. Never used by profile/telemetry clients. */
export type SecureSessionStore = {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
};
export const SENSI_STORAGE_KEY = 'drivesense-sensi-demo-auth-v1';
const preferenceKey = `${SENSI_STORAGE_KEY}.remember`;
export function createSensiSessionStorage(secure: SecureSessionStore) {
  let memory: string | null = null;
  let remember: boolean | undefined;
  let failed = false;
  async function guarded<T>(action: () => Promise<T>): Promise<T> {
    try { return await action(); }
    catch { failed = true; throw new Error('Secure Sensi session storage unavailable.'); }
  }
  async function persistent() {
    if (remember === undefined) remember = await guarded(async () => (await secure.getItemAsync(preferenceKey)) === 'true');
    return remember;
  }
  let queue = Promise.resolve();
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.catch(() => {}).then(work);
    queue = next.then(() => {}, () => {}); return next;
  }
  return {
    hasError: () => failed,
    select(keep: boolean) { return serial(async () => {
      // Old credentials must be removed before switching either storage mode.
      await guarded(() => secure.deleteItemAsync(SENSI_STORAGE_KEY));
      await guarded(() => secure.setItemAsync(preferenceKey, String(keep)));
      memory = null; remember = keep; failed = false;
    }); },
    getItem(key: string) { return serial(async () => {
      if (key !== SENSI_STORAGE_KEY) return null;
      return await persistent() ? guarded(() => secure.getItemAsync(key)) : memory;
    }); },
    setItem(key: string, value: string) { return serial(async () => {
      if (key !== SENSI_STORAGE_KEY) return;
      if (await persistent()) await guarded(() => secure.setItemAsync(key, value));
      else memory = value;
    }); },
    removeItem(key: string) { return serial(async () => {
      if (key !== SENSI_STORAGE_KEY) return;
      memory = null;
      await guarded(() => secure.deleteItemAsync(key));
    }); },
  };
}

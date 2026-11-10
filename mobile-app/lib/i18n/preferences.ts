export type AppLanguage = 'en' | 'es';
export const APP_LANGUAGE_KEY = 'app_language';
type Store = { getSetting(key: string): Promise<string | null>; setSetting(key: string, value: string): Promise<unknown> };
/** App-only preference. Never reads/writes profiles, voice selection, theme or safety state. */
export function createLanguagePreferences(store: Store) {
  let language: AppLanguage = 'en', revision = 0;
  let writes = Promise.resolve<unknown>(undefined);
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => language,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    async load() {
      const started = revision;
      try { const saved = await store.getSetting(APP_LANGUAGE_KEY);
        if (started === revision && (saved === 'en' || saved === 'es')) { language = saved; listeners.forEach(fn => fn()); }
      } catch { /* English remains available offline if storage is unavailable. */ }
    },
    select(next: AppLanguage) {
      if (next !== 'en' && next !== 'es') return Promise.reject(new Error('Invalid app language'));
      language = next; revision++; listeners.forEach(fn => fn());
      const pending = writes.then(() => store.setSetting(APP_LANGUAGE_KEY, next));
      writes = pending.catch(() => {}); return pending;
    },
  };
}

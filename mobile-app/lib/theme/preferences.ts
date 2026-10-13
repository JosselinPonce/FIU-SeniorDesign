import { themePreference, type ThemePreference } from './tokens.ts';
export const THEME_SETTING_KEY = 'appearance';
type Store = { getSetting(key: string): Promise<string | null>; setSetting(key: string, value: string): Promise<void> };
/** Observable state shared by the provider and tests; writes are serialized in selection order. */
export function createThemePreferences(store: Store) {
  let current: ThemePreference = 'light';
  let revision = 0;
  let writes = Promise.resolve();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach(listener => listener());
  return {
    getSnapshot: () => current,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async load() {
      const started = revision;
      try { const saved = await store.getSetting(THEME_SETTING_KEY);
        if (started === revision) { current = themePreference(saved); notify(); }
      } catch { /* Initial light, or a newer user selection, remains safe on read failure. */ }
    },
    select(value: ThemePreference) {
      if (!['light', 'dark', 'system'].includes(value)) return Promise.reject(new Error('Invalid appearance preference'));
      revision += 1;
      current = value;
      notify();
      const pending = writes.then(() => store.setSetting(THEME_SETTING_KEY, value));
      writes = pending.catch(() => {});
      return pending;
    },
  };
}

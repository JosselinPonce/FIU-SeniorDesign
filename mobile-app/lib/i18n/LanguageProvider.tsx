import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import * as repo from '../db/repositories';
import { createLanguagePreferences, type AppLanguage } from './preferences';
import { translateText } from './translate';
let renderedLanguage: AppLanguage = 'en';
export const translateCurrent = (source: string) => translateText(source, renderedLanguage);
const Context = createContext({ language: 'en' as AppLanguage, error: '',
  t: (source: string) => source, setLanguage: async (_value: AppLanguage) => {} });
export function LanguageProvider({ children }: { children: ReactNode }) {
  const [preferences] = useState(() => createLanguagePreferences(repo));
  const language = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot, preferences.getSnapshot);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  renderedLanguage = language;
  useEffect(() => {
    let mounted = true;
    void preferences.load().finally(() => { if (mounted) setLoaded(true); });
    return () => { mounted = false; };
  }, [preferences]);
  const value = useMemo(() => ({ language, error, t: (source: string) => translateText(source, language),
    async setLanguage(next: AppLanguage) {
      setError('');
      try { await preferences.select(next); }
      catch { setError('Language changed for this session but could not be saved. Please try again.'); }
    },
  }), [language, error, preferences]);
  return loaded ? <Context.Provider value={value}>{children}</Context.Provider> : null;
}
export const useAppLanguage = () => useContext(Context);

/** Temporary presentation scope. Never writes preferences or changes global alerts. */
export function VoiceCheckLanguageScope({ language, children }: { language: AppLanguage; children: ReactNode }) {
  const parent = useAppLanguage();
  const value = useMemo(() => ({ ...parent, language, t: (source: string) => translateText(source, language) }), [parent, language]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

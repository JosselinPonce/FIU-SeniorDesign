import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Appearance, Platform, useColorScheme } from 'react-native';
import * as repo from '../db/repositories';
import { createThemePreferences } from './preferences';
import { nativeAppearancePreference, presentationColors, resolveTheme, themes, type ThemePreference } from './tokens';

function useThemeState() {
  const [settings] = useState(() => createThemePreferences(repo));
  const preference = useSyncExternalStore(settings.subscribe, settings.getSnapshot, settings.getSnapshot);
  const system = useColorScheme();
  const name = resolveTheme(preference, system);
  useEffect(() => {
    // Keep iOS alerts/pickers aligned with the same persisted app preference.
    if (Platform.OS === 'ios') Appearance.setColorScheme(nativeAppearancePreference(preference));
  }, [preference]);
  const [error, setError] = useState('');
  useEffect(() => { void settings.load(); }, [settings]);
  return useMemo(() => ({ name, preference, tokens: themes[name], colors: presentationColors(themes[name]), error,
    async setPreference(value: ThemePreference) {
      setError('');
      try { await settings.select(value); }
      catch { setError('Appearance changed for this session but could not be saved. Please select it again to retry.'); }
    },
  }), [name, preference, error, settings]);
}
const ThemeContext = createContext<ReturnType<typeof useThemeState> | null>(null);
export function ThemeProvider({ children }: { children: ReactNode }) {
  const value = useThemeState();
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
export function useTheme() {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('ThemeProvider is required');
  return value;
}

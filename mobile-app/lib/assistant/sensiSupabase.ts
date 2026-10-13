import 'react-native-url-polyfill/auto';
import { createClient } from '@supabase/supabase-js';
import * as SecureStore from 'expo-secure-store';
import { AppState } from 'react-native';
import { createSensiSessionStorage, SENSI_STORAGE_KEY } from './sensiSessionStorage';

export const sensiSessionStorage = createSensiSessionStorage({
  getItemAsync: key => SecureStore.getItemAsync(key),
  setItemAsync: (key, value) => SecureStore.setItemAsync(key, value, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  }),
  deleteItemAsync: key => SecureStore.deleteItemAsync(key),
});

/** Sensi alone owns this session. Never pass it to profile/telemetry uploads. */
export const sensiSupabase = createClient(
  process.env.EXPO_PUBLIC_SUPABASE_URL!,
  process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  { auth: {
    storageKey: SENSI_STORAGE_KEY,
    storage: sensiSessionStorage,
    persistSession: true,
    detectSessionInUrl: false,
  } }
);

// Refresh only while the app is active; Auth changes never control monitoring.
if (AppState.currentState === 'active') sensiSupabase.auth.startAutoRefresh();
AppState.addEventListener('change', state => {
  if (state === 'active') sensiSupabase.auth.startAutoRefresh();
  else sensiSupabase.auth.stopAutoRefresh();
});

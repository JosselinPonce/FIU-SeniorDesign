import { AppState } from 'react-native';
import { sensiSupabase, sensiSessionStorage } from './sensiSupabase';
import { sensiPreferences } from './phoneSensiPreferences';
import { createCloudAuth } from './cloudAuth';
export const sensiCloudAuth = createCloudAuth(sensiSupabase.auth, sensiSessionStorage, {
  demoEmail: process.env.EXPO_PUBLIC_SENSI_DEMO_EMAIL ?? '',
  active: () => AppState.currentState === 'active',
  invalidateConsent: sensiPreferences.invalidateConsent,
});
sensiCloudAuth.subscribe(() => {
  void sensiPreferences.selectAccount(sensiCloudAuth.cachedCredential()?.userId ?? null);
});
AppState.addEventListener('change', state => {
  if (state === 'active') void sensiCloudAuth.restore(); else sensiCloudAuth.suspend();
});

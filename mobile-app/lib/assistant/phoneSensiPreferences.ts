import * as SecureStore from 'expo-secure-store';
import { getSetting, setSetting } from '../db/repositories';
import { createSensiPreferences } from './sensiPreferences';

export const sensiPreferences = createSensiPreferences({ getSetting, setSetting }, {
  getItemAsync: key => SecureStore.getItemAsync(key),
  setItemAsync: (key, value) => SecureStore.setItemAsync(key, value, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  }),
  deleteItemAsync: key => SecureStore.deleteItemAsync(key),
});

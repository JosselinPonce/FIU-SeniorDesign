import { createSensiPreferences as createPolicy } from '../../lib/assistant/sensiPreferences.ts';
import type { SecureSessionStore } from '../../lib/assistant/sensiSessionStorage.ts';

export function memoryConsent(values = new Map<string, string>()): SecureSessionStore {
  return {
    getItemAsync: async key => values.get(key) ?? null,
    setItemAsync: async (key, value) => { values.set(key, value); },
    deleteItemAsync: async key => { values.delete(key); },
  };
}

export function createSensiPreferences(store: Parameters<typeof createPolicy>[0], secure = memoryConsent()) {
  const policy = createPolicy(store, secure);
  void policy.selectAccount('fixture-account');
  return policy;
}

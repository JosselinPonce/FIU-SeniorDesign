import type { SecureSessionStore } from './sensiSessionStorage.ts';

export const SENSI_PREFERENCE_KEY = 'sensi:provider:v1';
export const SENSI_PROVIDERS = [
  { id: 'automatic', label: 'Automatic' },
  { id: 'openai', label: 'OpenAI Preferred' },
  { id: 'gemma', label: 'Offline Gemma Preferred' },
  { id: 'basic', label: 'Basic Offline Responses' },
] as const;
export type SensiPreference = typeof SENSI_PROVIDERS[number]['id'];
export const CLOUD_CONSENT_STORAGE_KEY = 'drivesense-sensi-cloud-consent-v3';
type Store = { getSetting(key: string): Promise<string | null>; setSetting(key: string, value: string): Promise<void> };
type GrantRecord = { accountId: string; drivers: string[] };
export type SensiPreferencesState = Readonly<{ loaded: boolean; preference: SensiPreference; driverId: string | null; accountId: string | null; consent: boolean; revision: number }>;

/** Consent only becomes usable after online identity verification and a matching secure grant. */
export function createSensiPreferences(store: Store, secure: SecureSessionStore) {
  let state: SensiPreferencesState = Object.freeze({ loaded: false, preference: 'gemma', driverId: null, accountId: null, consent: false, revision: 0 });
  let booting: Promise<void> | undefined, consentEpoch = 0, secureFailed = false;
  let preferenceWrites = Promise.resolve();
  let consentWrites = Promise.resolve();
  function serialConsent<T>(work: () => Promise<T>): Promise<T> {
    const next = consentWrites.then(work);
    consentWrites = next.then(() => {}, () => {});
    return next;
  }
  async function readGrants(): Promise<GrantRecord | null> {
    const raw = await secure.getItemAsync(CLOUD_CONSENT_STORAGE_KEY);
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as GrantRecord;
      return value && typeof value.accountId === 'string' && Array.isArray(value.drivers)
        && value.drivers.every(driver => typeof driver === 'string') ? value : null;
    } catch { return null; }
  }
  const listeners = new Set<(s: SensiPreferencesState) => void>();
  const update = (patch: Partial<SensiPreferencesState>) => {
    state = Object.freeze({ ...state, ...patch, revision: state.revision + 1 });
    for (const listener of listeners) { try { listener(state); } catch { /* An observer cannot block revocation or another subscriber. */ } }
  };
  function restoreConsent(patch: Pick<Partial<SensiPreferencesState>, 'driverId' | 'accountId'>) {
    const epoch = ++consentEpoch;
    update({ ...patch, consent: false });
    const { driverId, accountId } = state;
    if (!accountId) return Promise.resolve();
    return serialConsent(async () => {
      if (secureFailed) return;
      try {
        const grants = await readGrants();
        if (grants && grants.accountId !== accountId) {
          // A verified account change invalidates the previous account's grants.
          await secure.deleteItemAsync(CLOUD_CONSENT_STORAGE_KEY);
        } else if (driverId && grants?.drivers.includes(driverId) && epoch === consentEpoch) {
          update({ consent: true });
        }
      } catch { secureFailed = true; }
    });
  }
  return {
    get state() { return state; },
    subscribe(listener: (s: SensiPreferencesState) => void) { listeners.add(listener); try { listener(state); } catch { /* Read-only observer. */ } return () => { listeners.delete(listener); }; },
    boot() {
      return booting ??= (async () => {
        try {
          const value = await store.getSetting(SENSI_PREFERENCE_KEY);
          const preference = SENSI_PROVIDERS.find(p => p.id === value)?.id ?? 'gemma';
          update({ loaded: true, preference });
        } catch { update({ loaded: true, preference: 'basic' }); }
      })();
    },
    selectDriver(driverId: string | null) {
      return state.driverId === driverId ? Promise.resolve() : restoreConsent({ driverId });
    },
    selectAccount(accountId: string | null) {
      return state.accountId === accountId ? Promise.resolve() : restoreConsent({ accountId });
    },
    invalidateConsent() {
      ++consentEpoch;
      update({ accountId: null, consent: false });
      return serialConsent(async () => {
        try { await secure.deleteItemAsync(CLOUD_CONSENT_STORAGE_KEY); secureFailed = false; }
        catch { secureFailed = true; throw Error('Could not remove stored cloud consent. Cloud processing is disabled.'); }
      });
    },
    async savePreference(preference: SensiPreference) {
      if (!SENSI_PROVIDERS.some(p => p.id === preference)) throw Error('Invalid Sensi preference');
      await this.boot();
      update({ preference }); // Immediately invalidate pending results.
      preferenceWrites = preferenceWrites.catch(() => {}).then(() => store.setSetting(SENSI_PREFERENCE_KEY, preference));
      try { await preferenceWrites; }
      catch { update({ preference: 'basic' }); throw Error('Could not save Sensi preference. Basic responses remain available.'); }
    },
    saveConsent(driverId: string, consent: boolean) {
      const { accountId } = state;
      if (!accountId || state.driverId !== driverId) return Promise.reject(Error('Sign in and select the current driver before changing cloud consent.'));
      const epoch = ++consentEpoch;
      update({ consent: false });
      return serialConsent(async () => {
        try {
          const record = secureFailed ? null : await readGrants();
          const drivers = new Set(record?.accountId === accountId ? record.drivers : []);
          if (consent) drivers.add(driverId); else drivers.delete(driverId);
          await secure.setItemAsync(CLOUD_CONSENT_STORAGE_KEY, JSON.stringify({ accountId, drivers: [...drivers] }));
          secureFailed = false;
          if (epoch === consentEpoch) update({ consent });
        } catch {
          secureFailed = true;
          // Prefer removing all grants to restoring a failed revocation later.
          try { await secure.deleteItemAsync(CLOUD_CONSENT_STORAGE_KEY); }
          catch { /* Keep authorization disabled for the current process. */ }
          throw Error('Could not save cloud consent. Cloud processing remains disabled.');
        }
      });
    },
  };
}

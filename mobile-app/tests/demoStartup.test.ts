import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSensiSessionStorage, SENSI_STORAGE_KEY } from '../lib/assistant/sensiSessionStorage.ts';
import { demoEmail, restoreDemoSession, startupRoute, type StartupAuth } from '../lib/assistant/demoStartup.ts';

function secureStore() {
  const values = new Map<string, string>();
  return { values, async getItemAsync(key: string) { return values.get(key) ?? null; },
    async setItemAsync(key: string, value: string) { values.set(key, value); },
    async deleteItemAsync(key: string) { values.delete(key); } };
}
test('secure sessions restore across adapters; unchecked mode erases old tokens and stays memory-only', async () => {
  const secure = secureStore();
  const first = createSensiSessionStorage(secure);
  await first.select(true);
  await first.setItem(SENSI_STORAGE_KEY, 'fixture-session');
  const restored = createSensiSessionStorage(secure);
  assert.equal(await restored.getItem(SENSI_STORAGE_KEY), 'fixture-session');
  await restored.select(false);
  await restored.setItem(SENSI_STORAGE_KEY, 'memory-fixture');
  assert.equal(secure.values.has(SENSI_STORAGE_KEY), false);
  assert.equal(await restored.getItem(SENSI_STORAGE_KEY), 'memory-fixture');
  assert.equal(await createSensiSessionStorage(secure).getItem(SENSI_STORAGE_KEY), null);
});
test('sign-out removal clears secure and in-memory tokens', async () => {
  for (const keep of [true, false]) {
    const secure = secureStore(); const storage = createSensiSessionStorage(secure);
    await storage.select(keep); await storage.setItem(SENSI_STORAGE_KEY, 'fixture');
    await storage.removeItem(SENSI_STORAGE_KEY);
    assert.equal(await storage.getItem(SENSI_STORAGE_KEY), null);
    assert.equal(await createSensiSessionStorage(secure).getItem(SENSI_STORAGE_KEY), null);
  }
});
test('storage failure is explicit; no fallback to insecure persistence', async () => {
  const secure = secureStore();
  secure.setItemAsync = async () => { throw new Error('fixture failure'); };
  const storage = createSensiSessionStorage(secure);
  await assert.rejects(storage.select(true), /Secure Sensi/);
  assert.equal(storage.hasError(), true);
  assert.equal(secure.values.size, 0);
});
test('routing defaults to dashboard without demo; admission survives expiry and sign-out', () => {
  assert.equal(startupRoute(false, false, false), 'dashboard');
  assert.equal(startupRoute(true, false, false), 'login');
  assert.equal(startupRoute(true, false, true), 'dashboard');
  assert.equal(startupRoute(true, true, false), 'dashboard');
  assert.equal(demoEmail('drivesense-demo', ' demo@example.invalid '), 'demo@example.invalid');
  assert.equal(demoEmail('other', 'demo@example.invalid'), null);
  assert.equal(demoEmail('drivesense-demo', ''), null);
});
function auth(expired = false): StartupAuth & { refreshes: number } {
  let expiry = expired ? 1 : 9999999999;
  const result = {
    refreshes: 0,
    async getSession() { return { data: { session: { access_token: 'fixture', expires_at: expiry } }, error: null }; },
    async refreshSession() { result.refreshes++; expiry = 9999999999; return { error: null }; },
    async getUser() { return { data: { user: { role: 'authenticated', email: 'demo@example.invalid', email_confirmed_at: 'fixture' } }, error: null }; },
  };
  return result;
}
test('restore validates confirmed account and refreshes an expired session', async () => {
  for (const expired of [true, false]) {
    const client = auth(expired);
    assert.equal(await restoreDemoSession(client, 'demo@example.invalid'), true);
    assert.equal(client.refreshes, expired ? 1 : 0);
    assert.equal(await restoreDemoSession(client, 'other@example.invalid'), false);
  }
});
test('missing session, failed refresh and offline validation fail closed', async () => {
  const missing = { ...auth(), async getSession() { return { data: { session: null }, error: null }; } };
  assert.equal(await restoreDemoSession(missing, 'demo@example.invalid'), false);
  const failed = { ...auth(true), async refreshSession() { return { error: 'fixture' }; } };
  assert.equal(await restoreDemoSession(failed, 'demo@example.invalid'), false);
  const offline = { ...auth(), async getUser(): ReturnType<StartupAuth['getUser']> { throw new Error('fixture'); } };
  assert.equal(await restoreDemoSession(offline, 'demo@example.invalid'), false);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCloudAuth, type CloudAuthPort } from '../lib/assistant/cloudAuth.ts';
import { createSensiSessionStorage, SENSI_STORAGE_KEY } from '../lib/assistant/sensiSessionStorage.ts';
const id = '11111111-1111-4111-8111-111111111111';
const session = { access_token: 'test-user-token', expires_at: Date.now() / 1000 + 3600, user: { id } };
const tick = () => new Promise<void>(r => setImmediate(r));
function fixture(invalidateConsent?: () => Promise<void>) {
  let stored: typeof session | null = null, active = true, failed = false;
  let user: any = { id, role: 'authenticated', email_confirmed_at: '2026-01-01' };
  let listener: (event: string, session: typeof stored) => void = () => {};
  const modes: boolean[] = [], inputs: unknown[] = [];
  const auth: CloudAuthPort = {
    getSession: async () => ({ data: { session: stored }, error: null }), refreshSession: async () => ({ error: null }),
    getUser: async () => ({ data: { user }, error: null }),
    signInWithPassword: async input => { inputs.push(input); stored = session; listener('SIGNED_IN', stored); return { error: null }; },
    signOut: async () => { stored = null; listener('SIGNED_OUT', null); return { error: null }; },
    onAuthStateChange: fn => { listener = fn; return { data: { subscription: { unsubscribe() {} } } }; },
  };
  const cloud = createCloudAuth(auth, { select: async value => { modes.push(value); }, hasError: () => failed }, { demoEmail: 'demo@example.invalid', active: () => active, timeoutMs: 20, invalidateConsent });
  return { cloud, auth, modes, inputs, user: (value: any) => { user = value; }, active: (value: boolean) => { active = value; },
    storageFailure: () => { failed = true; }, emit: (event: string) => listener(event, stored), remembered: () => { stored = session; } };
}
test('optional authentication accepts verified confirmed identities and keeps tokens out of observable state', async () => {
  const f = fixture(); assert.equal(f.cloud.cachedCredential(), null);
  assert.equal(await f.cloud.signIn('drivesense-demo', 'transient-test-password', true), true);
  assert.deepEqual(f.modes, [true]); assert.deepEqual(f.inputs, [{ email: 'demo@example.invalid', password: 'transient-test-password' }]);
  assert.equal(f.cloud.cachedCredential()?.userId, id);
  assert.doesNotMatch(JSON.stringify(f.cloud.state), /token|password|11111111/);
  f.cloud.suspend(); assert.equal(f.cloud.cachedCredential(), null);
  assert.equal(await f.cloud.restore(), true);
  assert.equal(await f.cloud.signOut(), true); assert.equal(f.cloud.cachedCredential(), null); assert.deepEqual(f.modes, [true, false]);
  f.emit('SIGNED_IN'); await tick(); assert.equal(f.cloud.cachedCredential(), null, 'late Auth events cannot undo explicit sign-out');
});
for (const user of [{ id, role: 'anon', email_confirmed_at: 'yes' }, { id, role: 'authenticated', is_anonymous: true, email_confirmed_at: 'yes' }, { id, role: 'authenticated' }, { id: 'different', role: 'authenticated', email_confirmed_at: 'yes' }]) {
  test(`unverified or unauthorized identity fails closed: ${JSON.stringify(user)}`, async () => {
    const f = fixture(); f.user(user); assert.equal(await f.cloud.signIn('member@example.invalid', 'test-only', false), false); assert.equal(f.cloud.cachedCredential(), null);
  });
}
test('remembered sessions require online validation, and background/storage failures revoke cached authority', async () => {
  const f = fixture(); f.remembered(); assert.equal(await f.cloud.restore(), true);
  f.active(false); assert.equal(f.cloud.cachedCredential(), null); f.cloud.suspend(); f.active(true);
  assert.equal(await f.cloud.restore(), true); f.storageFailure(); assert.equal(f.cloud.cachedCredential(), null);
});
test('sign-out during online validation rejects late verified identity', async () => {
  const f = fixture(); f.remembered(); let resolve!: (value: any) => void;
  f.auth.getUser = () => new Promise(r => { resolve = r; });
  const pending = f.cloud.restore(); await tick(); await f.cloud.signOut();
  resolve({ data: { user: { id, role: 'authenticated', email_confirmed_at: 'yes' } }, error: null });
  assert.equal(await pending, false); assert.equal(f.cloud.cachedCredential(), null);
});
test('slow sign-in cannot acquire authority after timeout', async () => {
  const f = fixture(); let resolve!: (value: any) => void;
  f.auth.signInWithPassword = () => new Promise(r => { resolve = r; });
  assert.equal(await f.cloud.signIn('member@example.invalid', 'test-only', true), false);
  resolve({ error: null }); await tick(); assert.equal(f.cloud.cachedCredential(), null);
});
test('secure remembered mode changes serialize with SDK writes; sign-out removes durable credentials', async () => {
  const data = new Map<string, string>();
  const store = createSensiSessionStorage({ getItemAsync: async key => data.get(key) ?? null,
    setItemAsync: async (key, value) => { await tick(); data.set(key, value); }, deleteItemAsync: async key => { await tick(); data.delete(key); } });
  await Promise.all([store.select(true), store.setItem(SENSI_STORAGE_KEY, 'test-session'), store.select(false), store.setItem(SENSI_STORAGE_KEY, 'late-test-session')]);
  assert.equal(data.has(SENSI_STORAGE_KEY), false); assert.equal(await store.getItem(SENSI_STORAGE_KEY), 'late-test-session');
  const restarted = createSensiSessionStorage({ getItemAsync: async key => data.get(key) ?? null, setItemAsync: async () => {}, deleteItemAsync: async () => {} });
  assert.equal(await restarted.getItem(SENSI_STORAGE_KEY), null);
});
for (const condition of ['refresh-failure', 'revoked', 'expired-after-refresh', 'offline'] as const) test(`restored cloud session fails closed: ${condition}`, async () => {
  const f = fixture(); f.remembered();
  if (condition === 'refresh-failure' || condition === 'expired-after-refresh') {
    f.auth.getSession = async () => ({ data: { session: { ...session, expires_at: 1 } }, error: null });
    f.auth.refreshSession = async () => ({ error: condition === 'refresh-failure' ? Error('test') : null });
  }
  if (condition === 'revoked') f.auth.getUser = async () => ({ data: { user: null }, error: Error('test revoked') });
  if (condition === 'offline') f.auth.getUser = async () => { throw Error('test offline'); };
  assert.equal(await f.cloud.restore(), false); assert.equal(f.cloud.cachedCredential(), null);
});

test('explicit and SDK sign-out invalidate consent while suspend only pauses authorization', async () => {
  let invalidations = 0;
  const f = fixture(async () => { invalidations++; });
  assert.equal(await f.cloud.signIn('member@example.invalid', 'fixture-only', true), true);
  f.cloud.suspend();
  assert.equal(invalidations, 0);
  assert.equal(await f.cloud.restore(), true);
  assert.equal(await f.cloud.signOut(), true);
  assert.equal(invalidations, 1);
  await f.cloud.signIn('member@example.invalid', 'fixture-only', true);
  f.emit('SIGNED_OUT');
  assert.equal(f.cloud.cachedCredential(), null);
  assert.equal(invalidations, 2);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import ts from 'typescript';
import { createSensiSessionStorage, SENSI_STORAGE_KEY } from '../lib/assistant/sensiSessionStorage.ts';
import { signInDemo, signOutDemo } from '../lib/assistant/demoAuth.ts';
const source = (path: string) => readFileSync(new NodeURL(path, import.meta.url), 'utf8');

test('Sensi SDK session, headers and sign-out stay isolated from upload client', async () => {
  const requests: { url: string; authorization: string | null }[] = [];
  const userId = '11111111-1111-4111-8111-111111111111';
  const jwt = [{ alg: 'HS256', typ: 'JWT' }, { sub: userId, role: 'authenticated',
    exp: Math.floor(Date.now() / 1000) + 3600 }]
    .map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.') + '.fixture';
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, authorization: new Headers(init?.headers).get('Authorization') });
    if (url.includes('/token')) return Response.json({ access_token: jwt, refresh_token: 'fixture-only',
      token_type: 'bearer', expires_in: 3600, user: { id: userId, email: 'demo@example.invalid', role: 'authenticated' } });
    if (url.includes('/logout')) return new Response(null, { status: 204 });
    return Response.json([]);
  };
  let options: any;
  // Run the actual constructor module with fixture env and mocked transport only.
  const compiled = ts.transpileModule(source('../lib/assistant/sensiSupabase.ts'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports: any = {};
  new Function('require', 'exports', 'process', compiled)((name: string) => {
    if (name === 'react-native-url-polyfill/auto') return {};
    if (name === 'expo-secure-store') return {};
    if (name === 'react-native') return { AppState: { currentState: 'background', addEventListener() {} } };
    if (name === './sensiSessionStorage') return { SENSI_STORAGE_KEY, createSensiSessionStorage: () => createSensiSessionStorage({
      async getItemAsync() { return null; }, async setItemAsync() {}, async deleteItemAsync() {},
    }) };
    assert.equal(name, '@supabase/supabase-js');
    return { createClient(url: string, key: string, config: any) {
      options = config;
      return createClient(url, key, { ...config, global: { fetch: fetcher } });
    } };
  }, exports, { env: { EXPO_PUBLIC_SUPABASE_URL: 'https://fixture.supabase.co',
    EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'fixture-public-key' } });
  const sensi = exports.sensiSupabase;
  const uploads = createClient('https://fixture.supabase.co', 'fixture-public-key', {
    auth: { persistSession: false, detectSessionInUrl: false }, global: { fetch: fetcher },
  });
  assert.equal(options.auth.persistSession, true);
  assert.equal(options.auth.detectSessionInUrl, false);
  assert.equal(options.auth.storageKey, 'drivesense-sensi-demo-auth-v1');
  assert.ok(options.auth.storage);
  assert.equal(options.global, undefined);
  assert.notEqual(sensi.auth, uploads.auth);
  let uploadEvents = 0;
  const subscription = uploads.auth.onAuthStateChange(event => {
    if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') uploadEvents++;
  }).data.subscription;
  try {
    assert.equal(await signInDemo(sensi.auth, 'demo@example.invalid', 'fixture-password'), true);
    assert.equal((await uploads.auth.getSession()).data.session, null);
    assert.equal((await sensi.auth.getSession()).data.session?.access_token, jwt);
    await uploads.from('driver_profiles').select('id');
    await sensi.functions.invoke('driver-assistant', { body: {} });
    assert.notEqual(requests.find(r => r.url.includes('/rest/v1/driver_profiles'))?.authorization, `Bearer ${jwt}`);
    assert.equal(requests.find(r => r.url.includes('/functions/v1/driver-assistant'))?.authorization, `Bearer ${jwt}`);
    assert.equal(await signOutDemo(sensi.auth), true);
    assert.equal((await sensi.auth.getSession()).data.session, null);
    assert.equal((await uploads.auth.getSession()).data.session, null);
    assert.equal(uploadEvents, 0);
  } finally {
    subscription.unsubscribe();
    await sensi.auth.stopAutoRefresh();
    await uploads.auth.stopAutoRefresh();
  }
});

test('demo and Connected wiring use Sensi; upload wiring and disabled readiness remain intact', () => {
  const panel = source('../components/DemoAuthPanel.tsx');
  assert.match(panel, /import \{ sensiSessionStorage, sensiSupabase \} from '..\/lib\/assistant\/sensiSupabase'/);
  assert.doesNotMatch(panel, /\bsupabase\.auth/);
  assert.match(source('../lib/assistant/phoneAssistantProvider.ts'), /connectedAssistantProvider\(sensiSupabase,/);
  for (const file of ['profileSync', 'liveSync', 'deletion']) {
    const upload = source(`../lib/db/${file}.ts`);
    assert.match(upload, /import \{ supabase \} from '..\/supabase'/);
    assert.doesNotMatch(upload, /sensiSupabase/);
  }
  assert.match(source('../lib/assistant/connectedReadiness.ts'), /verified: false/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { sensiSignInEnabled, signInConfirmedPilot } from '../lib/assistant/pilotSignIn.ts';

function fixture(patch: Record<string, unknown> = {}, offline = false) {
  let signsOut = 0, signsIn = 0;
  return {
    auth: {
      async signInWithPassword(input: { email: string; password: string }) {
        signsIn++; assert.equal(input.email, 'pilot@example.invalid'); assert.equal(input.password, ' fixture ');
        return { error: null };
      },
      async signOut(input: { scope: 'local' }) { assert.equal(input.scope, 'local'); signsOut++; return { error: null }; },
      async getSession() { return { data: { session: { access_token: 'fixture-token', expires_at: Date.now() / 1000 + 3600 } }, error: null }; },
      async refreshSession() { return { error: null }; },
      async getUser() {
        if (offline) throw new Error('private upstream details');
        return { data: { user: { email: 'pilot@example.invalid', role: 'authenticated',
          email_confirmed_at: 'fixture-confirmed', is_anonymous: false, ...patch } }, error: null };
      },
    },
    signsOut: () => signsOut, signsIn: () => signsIn,
  };
}

test('release sign-in is absent by default and requires an exact non-secret UI opt-in', () => {
  for (const flag of [undefined, '', 'false', 'TRUE', '1']) assert.equal(sensiSignInEnabled(false, flag), false);
  assert.equal(sensiSignInEnabled(false, 'true'), true); assert.equal(sensiSignInEnabled(true, undefined), true);
});

test('pilot login verifies the confirmed account online, trims email and keeps credentials transient', async () => {
  const f = fixture(); assert.equal(await signInConfirmedPilot(f.auth, ' pilot@example.invalid ', ' fixture '), true);
  assert.equal(f.signsIn(), 1); assert.equal(f.signsOut(), 0);
});

test('unconfirmed, anonymous, wrong-account and offline validation fail closed and clear the local session', async () => {
  for (const patch of [{ email_confirmed_at: undefined }, { is_anonymous: true },
    { email: 'other@example.invalid' }, { role: 'anon' }]) {
    const f = fixture(patch); assert.equal(await signInConfirmedPilot(f.auth, 'pilot@example.invalid', ' fixture '), false);
    assert.equal(f.signsOut(), 1);
  }
  const f = fixture({}, true); assert.equal(await signInConfirmedPilot(f.auth, 'pilot@example.invalid', ' fixture '), false);
  assert.equal(f.signsOut(), 1);
});

test('blank pilot credentials make no Auth requests', async () => {
  const f = fixture(); assert.equal(await signInConfirmedPilot(f.auth, '', ' fixture '), false);
  assert.equal(f.signsIn(), 0); assert.equal(f.signsOut(), 0);
});

test('pilot sign-in cannot activate Connected, alter upload identity, or introduce persistent passwords', () => {
  const source = (path: string) => readFileSync(new NodeURL(path, import.meta.url), 'utf8');
  assert.match(source('./retired-ai/lib/assistant/connectedReadiness.ts'), /verified: false/);
  const panel = source('./retired-ai/components/DemoAuthPanel.tsx');
  assert.match(panel, /signInConfirmedPilot\(sensiSupabase.auth/);
  assert.match(panel, /sensiSessionStorage.select\(false\)/);
  assert.doesNotMatch(panel, /setSetting|functions.invoke|\.from\(/);
  assert.doesNotMatch(source('../components/SettingsView.tsx'), /sensiSignInEnabled|DemoAuthPanel|EXPO_PUBLIC_SENSI_PILOT_SIGN_IN/);
});

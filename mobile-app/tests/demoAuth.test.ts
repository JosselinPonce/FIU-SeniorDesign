import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signInDemo, signOutDemo, type DemoAuth } from '../lib/assistant/demoAuth.ts';

test('demo sign-in uses existing password auth, trims email, preserves password', async () => {
  let calls = 0;
  const auth: DemoAuth = {
    async signInWithPassword(input) {
      calls++;
      assert.deepEqual(input, { email: 'demo@example.invalid', password: ' transient fixture ' });
      return { error: null };
    },
    async signOut() { throw new Error('unexpected'); },
  };
  assert.equal(await signInDemo(auth, ' demo@example.invalid ', ' transient fixture '), true);
  assert.equal(calls, 1);
});

test('empty credentials never make an authentication request', async () => {
  const auth: DemoAuth = {
    async signInWithPassword() { assert.fail('must not request'); },
    async signOut() { assert.fail('must not request'); },
  };
  assert.equal(await signInDemo(auth, ' ', 'fixture'), false);
  assert.equal(await signInDemo(auth, 'demo@example.invalid', ''), false);
});

test('SDK errors and exceptions become only a generic failure result', async () => {
  for (const throws of [false, true]) {
    const auth: DemoAuth = {
      async signInWithPassword() {
        if (throws) throw new Error('upstream details');
        return { error: { message: 'upstream details' } };
      },
      async signOut() {
        if (throws) throw new Error('upstream details');
        return { error: { message: 'upstream details' } };
      },
    };
    assert.equal(await signInDemo(auth, 'demo@example.invalid', 'fixture'), false);
    assert.equal(await signOutDemo(auth), false);
  }
});

test('sign-out targets only this client session, preserving other devices', async () => {
  const auth: DemoAuth = {
    async signInWithPassword() { assert.fail('must not sign in'); },
    async signOut(input) {
      assert.deepEqual(input, { scope: 'local' });
      return { error: null };
    },
  };
  assert.equal(await signOutDemo(auth), true);
});

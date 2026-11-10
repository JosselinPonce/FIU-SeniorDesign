import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_PHONE_URL, openDemoPhoneInterface } from '../lib/voice/demoPhoneHandoff.ts';
import { openAuthorizedPhoneInterface } from '../lib/voice/phoneHandoff.ts';

test('demo opens only the fixed fictional destination and cannot authorize a live call', async () => {
  const calls: string[] = [];
  assert.equal(await openDemoPhoneInterface({ platform: 'ios', version: '26.6', current: () => true,
    canOpen: async url => { assert.equal(url, DEMO_PHONE_URL); return true; }, open: async url => calls.push(url) }), 'requested');
  assert.deepEqual(calls, ['tel:+12025550123']);
  for (const source of ['demo', 'rehearsal', 'standalone'] as const) {
    await assert.rejects(openAuthorizedPhoneInterface('+13055551234', { source, episodeId: 'live-like-id' }, () => true, async url => { calls.push(url); return true; }), /blocked/);
  }
  assert.deepEqual(calls, [DEMO_PHONE_URL]);
});
test('demo fails closed for unsupported devices, cancellation, unavailable handlers and native errors', async () => {
  const deps = { platform: 'ios', version: 26, current: () => true, canOpen: async () => true,
    open: async () => { throw Error('native rejected'); } };
  assert.equal(await openDemoPhoneInterface(deps), 'failed');
  assert.equal(await openDemoPhoneInterface({ ...deps, platform: 'android' }), 'unsupported');
  assert.equal(await openDemoPhoneInterface({ ...deps, version: 10.2 }), 'unsupported');
  assert.equal(await openDemoPhoneInterface({ ...deps, current: () => false }), 'cancelled');
  assert.equal(await openDemoPhoneInterface({ ...deps, canOpen: async () => false }), 'unsupported');
  let current = true;
  assert.equal(await openDemoPhoneInterface({ ...deps, current: () => current, canOpen: async () => { current = false; return true; } }), 'cancelled');
});

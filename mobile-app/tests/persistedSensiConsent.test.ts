import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSensiPreferences, CLOUD_CONSENT_STORAGE_KEY } from '../lib/assistant/sensiPreferences.ts';
import { memoryConsent } from './helpers/sensiConsent.ts';
import { createLocalAcknowledgmentRouter } from '../lib/assistant/acknowledgmentRouter.ts';
import { acknowledgmentCandidates, acknowledgmentContext } from '../lib/assistant/safetyAcknowledgment.ts';
import { SafetyController, type SafetyState } from '../lib/analysis/safetyController.ts';
import { recognitionEvidence } from '../lib/voice/coreRecognition.ts';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const store = { getSetting: async () => 'openai', setSetting: async () => {} };
const approved = async (policy: ReturnType<typeof createSensiPreferences>) => {
  await policy.boot();
  await policy.selectDriver('driver-a');
  await policy.selectAccount('account-a');
};

test('only a verified matching account and driver restore a secure grant across processes', async () => {
  const data = new Map<string, string>(), secure = memoryConsent(data);
  const first = createSensiPreferences(store, secure);
  await first.selectDriver('driver-a');
  await assert.rejects(first.saveConsent('driver-a', true), /Sign in/);
  await approved(first);
  assert.equal(first.state.consent, false);
  await first.saveConsent('driver-a', true);
  assert.deepEqual(JSON.parse(data.get(CLOUD_CONSENT_STORAGE_KEY)!), { accountId: 'account-a', drivers: ['driver-a'] });
  const reopened = createSensiPreferences(store, secure);
  await reopened.selectDriver('driver-a');
  assert.equal(reopened.state.consent, false);
  await approved(reopened);
  assert.equal(reopened.state.consent, true);
  await reopened.selectDriver('driver-b');
  assert.equal(reopened.state.consent, false);
  await reopened.selectDriver('driver-a');
  assert.equal(reopened.state.consent, true);
  await reopened.selectAccount(null); // Background or auth verification.
  assert.equal(reopened.state.consent, false);
  await reopened.selectAccount('account-a');
  assert.equal(reopened.state.consent, true);
  const pending = reopened.saveConsent('driver-a', false);
  assert.equal(reopened.state.consent, false);
  await pending;
  const again = createSensiPreferences(store, secure);
  await approved(again);
  assert.equal(again.state.consent, false);
});

test('verified account change and sign-out remove the previous persistent grant', async () => {
  const secure = memoryConsent(), policy = createSensiPreferences(store, secure);
  await approved(policy);
  await policy.saveConsent('driver-a', true);
  await policy.selectAccount('account-b');
  assert.equal(policy.state.consent, false);
  assert.equal(await secure.getItemAsync(CLOUD_CONSENT_STORAGE_KEY), null);
  await policy.selectAccount('account-a');
  assert.equal(policy.state.consent, false);
  await policy.saveConsent('driver-a', true);
  await policy.invalidateConsent();
  const reopened = createSensiPreferences(store, secure);
  await approved(reopened);
  assert.equal(reopened.state.consent, false);
});

test('a new explicit grant after a storage failure cannot revive an old grant', async () => {
  const memory = memoryConsent();
  let failed = false;
  const secure = {
    ...memory,
    async setItemAsync(key: string, value: string) {
      if (failed) throw Error('Secure storage unavailable');
      await memory.setItemAsync(key, value);
    },
    async deleteItemAsync(key: string) {
      if (failed) throw Error('Secure storage unavailable');
      await memory.deleteItemAsync(key);
    },
  };
  const policy = createSensiPreferences(store, secure);
  await approved(policy);
  await policy.saveConsent('driver-a', true);
  failed = true;
  await assert.rejects(policy.saveConsent('driver-a', false));
  assert.equal(policy.state.consent, false);
  failed = false;
  await policy.selectDriver('driver-b');
  await policy.saveConsent('driver-b', true);
  await policy.selectDriver('driver-a');
  assert.equal(policy.state.consent, false);
});

for (const situation of ['authorized', 'ok', 'no-consent', 'signed-out', 'failure', 'cancelled'] as const) {
  test(`Safety Testing scenario: ${situation}`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
    const policy = createSensiPreferences(store, memoryConsent());
    await approved(policy);
    if (situation !== 'no-consent') await policy.saveConsent('driver-a', true);
    if (situation === 'signed-out') await policy.invalidateConsent();
    let requests = 0, opened = 0, persisted = 0, learned = 0;
    let resolveLate!: (text: string) => void;
    let state!: SafetyState;
    const published: NonNullable<SafetyState['conversation']>[] = [];
    const router = createLocalAcknowledgmentRouter(policy, { ready: () => false, generate: async () => '' }, {
      ready: () => situation !== 'signed-out',
      generate: async context => {
        requests++;
        if (situation === 'failure') throw Error('fixture provider unavailable');
        if (situation === 'cancelled') return new Promise(resolve => { resolveLate = resolve; });
        return acknowledgmentCandidates(context)[0]!;
      },
    });
    const replies = [situation === 'ok' ? "I'm okay" : "No, I'm feeling dizzy", 'No, thanks'];
    const controller = new SafetyController({
      assistantMode: () => 'gemma',
      startAcknowledgment: (context, scope) => { assert.ok(scope?.simulation && scope.cloudSimulation); return router(context, scope); },
      voiceIO: () => ({
        cancel() {}, speak: async () => { await tick(); },
        listen: async (_lang, _ms, _hints, id) => {
          const text = replies.shift();
          return text ? recognitionEvidence(id, { status: 'success', transcript: text, finalTranscript: text,
            isFinal: true, finalResultReceived: true }) : null;
        },
      }),
      handoffContact: async () => { opened++; },
      save: async () => { persisted++; }, saveAck: async () => { learned++; }, haptic() {},
      newId: () => 'fixture', onChange: next => { state = next; if (next.conversation) published.push(next.conversation); },
    });
    controller.configure({ id: 'driver-a', custom_id: null, display_name: 'Test driver', age: 30, gender: 'male',
      height_cm: 180, weight_kg: 80, created_at: '', updated_at: '', emergency_name: 'Contact',
      emergency_phone: '+13055550123' }, null);
    let done = false;
    const pending = controller.simulate('high_critical').finally(() => { done = true; });
    for (let i = 0; i < 180 && !done; i++) {
      t.mock.timers.tick(250);
      await tick();
      if (situation === 'cancelled' && requests) controller.cancelCheck();
    }
    assert.equal(done, true);
    const result = await pending;
    assert.equal(requests, ['authorized', 'failure', 'cancelled'].includes(situation) ? 1 : 0);
    assert.deepEqual([opened, persisted, learned], [0, 0, 0]);
    assert.ok(published.every(dialogue => dialogue.simulation === true));
    if (situation === 'cancelled') {
      resolveLate(acknowledgmentCandidates(acknowledgmentContext('bpm_high', 'en', "I'm dizzy"))[0]!);
      await tick();
      assert.ok(!published.some(dialogue => dialogue.messages.some(message => message.acknowledgmentSource === 'openai')));
      return;
    }
    if (situation !== 'ok') assert.equal(result?.contactCall, 'declined_offer');
    const ack = state.conversation?.messages.find(message => message.acknowledgmentSource !== undefined);
    assert.equal(ack?.acknowledgmentSource, situation === 'ok' ? undefined : situation === 'authorized' ? 'openai' : 'fallback');
    if (ack) assert.equal(ack.playback, 'completed');
  });
}

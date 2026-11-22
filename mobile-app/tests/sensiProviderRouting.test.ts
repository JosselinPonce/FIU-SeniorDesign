import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSensiPreferences, memoryConsent } from './helpers/sensiConsent.ts';
import { SENSI_PROVIDERS, SENSI_PREFERENCE_KEY } from '../lib/assistant/sensiPreferences.ts';
import { createLocalAcknowledgmentRouter } from '../lib/assistant/acknowledgmentRouter.ts';
import { acknowledgmentContext } from '../lib/assistant/safetyAcknowledgment.ts';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const scope = { driverId: 'driver-a', simulation: false, current: () => true };
function fixture() {
  const saved = new Map<string, string>();
  const store = { getSetting: async (key: string) => saved.get(key) ?? null, setSetting: async (key: string, value: string) => { saved.set(key, value); } };
  const secure = memoryConsent();
  return { saved, store, secure, policy: createSensiPreferences(store, secure) };
}

test('new policy ignores retired assistant_mode and preserves local-only behavior without cloud consent', async () => {
  const f = fixture(); f.saved.set('assistant_mode', 'connected'); await f.policy.boot(); await f.policy.selectDriver('driver-a');
  assert.equal(f.policy.state.preference, 'gemma'); assert.equal(f.policy.state.consent, false);
  for (const provider of SENSI_PROVIDERS) {
    await f.policy.savePreference(provider.id);
    assert.equal(f.saved.get(SENSI_PREFERENCE_KEY), provider.id);
    assert.equal(f.policy.state.consent, false, 'selection cannot grant cloud consent');
  }
});
test('consent is per driver and revoked synchronously before persistence', async () => {
  const f = fixture(); await f.policy.boot(); await f.policy.selectDriver('driver-a'); await f.policy.saveConsent('driver-a', true);
  assert.equal(f.saved.size, 0, 'consent never enters the driver preferences database');
  const revoked = f.policy.saveConsent('driver-a', false); assert.equal(f.policy.state.consent, false); await revoked;
  await f.policy.selectDriver('driver-b'); assert.equal(f.policy.state.consent, false);
  await assert.rejects(f.policy.saveConsent('driver-a', true));
  await f.policy.selectDriver('driver-a'); assert.equal(f.policy.state.consent, false);
});
test('a late previous-driver consent lookup cannot grant consent to a new driver', async () => {
  const f = fixture();
  await f.policy.selectDriver('driver-a');
  await f.policy.saveConsent('driver-a', true);
  const a = f.policy.selectDriver(null);
  const b = f.policy.selectDriver('driver-a');
  const c = f.policy.selectDriver('driver-b');
  await Promise.all([a,b,c]);
  assert.equal(f.policy.state.driverId, 'driver-b'); assert.equal(f.policy.state.consent, false);
});
test('preference/consent persistence failures remain fail-closed', async () => {
  const policy = createSensiPreferences({ getSetting: async () => { throw Error('db'); }, setSetting: async () => { throw Error('db'); } },
    { ...memoryConsent(), setItemAsync: async () => { throw Error('keychain'); } });
  await policy.boot(); assert.equal(policy.state.preference, 'basic'); await policy.selectDriver('driver-a');
  await assert.rejects(policy.savePreference('openai')); assert.equal(policy.state.preference, 'basic');
  await assert.rejects(policy.saveConsent('driver-a', true)); assert.equal(policy.state.consent, false);
});

for (const language of ['en', 'es'] as const) for (const provider of SENSI_PROVIDERS) for (const ready of [false, true]) {
  test(`${language}: ${provider.id}, ready=${ready}: local chain is bounded and never downloads or calls cloud`, async () => {
    const f = fixture(); await f.policy.boot(); await f.policy.selectDriver('driver-a'); await f.policy.savePreference(provider.id);
    let generations = 0;
    const output = language === 'en' ? "I'm sorry you're feeling dizzy." : 'Lamento que te sientas mareada.';
    const context = acknowledgmentContext('bpm_high', language, language === 'en' ? "I'm dizzy" : 'Me siento mareada');
    const router = createLocalAcknowledgmentRouter(f.policy, { ready: () => ready, generate: async () => { generations++; return output; } });
    const task = router(context, scope); await tick();
    assert.equal(task.get(language), ready && provider.id !== 'basic' ? output : language === 'en' ? 'Thank you for telling me.' : 'Gracias por decírmelo.');
    assert.equal(generations, ready && provider.id !== 'basic' ? 1 : 0);
    assert.equal(task.get(language), language === 'en' ? 'Thank you for telling me.' : 'Gracias por decírmelo.');
  });
}
for (const reason of ['cancel', 'consume', 'preference', 'consent', 'driver', 'interaction'] as const) test(`late local output is rejected after ${reason}`, async () => {
  const f = fixture(); await f.policy.boot(); await f.policy.selectDriver('driver-a');
  let resolve!: (text: string) => void, signal!: AbortSignal, current = true;
  const router = createLocalAcknowledgmentRouter(f.policy, { ready: () => true, generate: async (_c, s) => { signal = s; return new Promise(r => { resolve = r; }); } });
  const task = router(acknowledgmentContext('bpm_high', 'en', "I'm dizzy"), { ...scope, current: () => current }); await tick();
  if (reason === 'cancel') task.cancel();
  if (reason === 'consume') assert.equal(task.get('en'), 'Thank you for telling me.');
  if (reason === 'preference') await f.policy.savePreference('basic');
  if (reason === 'consent') await f.policy.saveConsent('driver-a', false);
  if (reason === 'driver') await f.policy.selectDriver('driver-b');
  if (reason === 'interaction') current = false;
  resolve("I'm sorry you're feeling dizzy."); await tick();
  assert.equal(task.get('en'), 'Thank you for telling me.'); assert.equal(signal.aborted, true);
});
test('unrecognized feeling and simulations cannot enable any cloud transport', async () => {
  const f = fixture(); await f.policy.boot(); await f.policy.selectDriver('driver-a'); await f.policy.saveConsent('driver-a', true); await f.policy.savePreference('openai');
  let generated = 0;
  const router = createLocalAcknowledgmentRouter(f.policy, { ready: () => true, generate: async () => { generated++; return 'unsafe text'; } });
  const task = router(acknowledgmentContext('spo2_low', 'en', 'something unknown'), { ...scope, simulation: true }); await tick();
  assert.equal(task.get('en'), 'Thank you for telling me.'); assert.equal(generated, 0);
  const simulated = router(acknowledgmentContext('bpm_high', 'en', "I'm dizzy"), { ...scope, simulation: true }); await tick();
  assert.equal(simulated.get('en'), 'Thank you for telling me.'); assert.equal(generated, 1, 'only local generation was possible; invalid output rejected');
});

test('VoiceCheck consumes only Gemma output ready when mandatory guidance finishes', async () => {
  const { VoiceCheck } = await import('../lib/voice/voiceCheck.ts');
  const { recognitionEvidence } = await import('../lib/voice/coreRecognition.ts');
  for (const completesBeforeSelection of [true, false]) {
    const f = fixture();
    await f.policy.boot();
    let finishGuidance!: () => void;
    const guidance = new Promise<void>(resolve => { finishGuidance = resolve; });
    let finishGemma!: (value: string) => void;
    const generation = new Promise<string>(resolve => { finishGemma = resolve; });
    const router = createLocalAcknowledgmentRouter(f.policy, { ready: () => true, generate: () => generation });
    let task: ReturnType<typeof router> | undefined;
    let captures = 0;
    const spoken: { text: string; delivery?: string }[] = [];
    const check = new VoiceCheck({
      cancel() {},
      async speak(text, _lang, delivery) {
        spoken.push({ text, delivery });
        if (text === 'If you need emergency help, call 911.') await guidance;
      },
      async listen(_lang, _ms, _hints, id) {
        const answer = ++captures === 1 ? "I'm dizzy" : 'No, thanks';
        return recognitionEvidence(id, { status: 'success', transcript: answer, finalTranscript: answer,
          isFinal: true, finalResultReceived: true });
      },
    }, 'en', '', {
      contactAvailable: true,
      startAcknowledgment: context => { task = router(context, { ...scope, simulation: true }); },
      acknowledgment: () => task!.get('en'),
      cancelAcknowledgment: () => task?.cancel(),
    });
    const result = check.run('bpm_high');
    await tick();
    const text = "I'm sorry you're feeling dizzy.";
    if (completesBeforeSelection) { finishGemma(text); await tick(); }
    finishGuidance();
    const outcome = await result;
    if (!completesBeforeSelection) { finishGemma(text); await tick(); }
    assert.equal(task?.source, completesBeforeSelection ? 'gemma' : 'fallback');
    assert.deepEqual(spoken.filter(line => line.delivery), [{
      text: completesBeforeSelection ? text : 'Thank you for telling me.', delivery: 'acknowledgment',
    }]);
    assert.equal(outcome.contactCall, 'declined_offer');
    assert.equal(check.authorizesContact(outcome), false);
  }
});

test('Debug records one terminal Gemma fallback reason without storing speech or output; Release records none', async () => {
  const { responsiveness } = await import('../lib/voice/responsivenessDiagnostics.ts');
  const f = fixture();
  await f.policy.boot();
  const context = acknowledgmentContext('bpm_high', 'en', "No I'm feeling a little dizzy", 'voice');
  const previous = Object.getOwnPropertyDescriptor(globalThis, '__DEV__');
  try {
    for (const debug of [true, false]) {
      Object.defineProperty(globalThis, '__DEV__', { value: debug, configurable: true });
      for (const reason of ['unavailable_at_dispatch', 'native_readiness_loss', 'empty_output', 'validation_rejected',
        'timeout', 'cancellation', 'missed_playback_cutoff'] as const) {
        responsiveness.setEnabled(true);
        let settle!: (value: string) => void;
        const waiting = new Promise<string>(resolve => { settle = resolve; });
        const router = createLocalAcknowledgmentRouter(f.policy, {
          ready: () => reason !== 'unavailable_at_dispatch',
          generate: async (_context, _signal, report) => {
            if (reason === 'native_readiness_loss' || reason === 'timeout') report?.(reason);
            if (reason === 'cancellation' || reason === 'missed_playback_cutoff') return waiting;
            return reason === 'validation_rejected' ? 'Private generated text.' : '';
          },
        });
        const task = router(context, scope);
        await tick();
        if (reason === 'cancellation') task.cancel();
        assert.equal(task.get('en'), 'Thank you for telling me.');
        settle("I'm sorry you're feeling dizzy.");
        await tick();
        const snapshot = responsiveness.snapshot();
        const events = snapshot.flatMap(record => record.events).filter(event => event.point === 'Gemma terminal fallback');
        assert.deepEqual(events.map(event => event.details.reason), debug ? [reason] : []);
        assert.doesNotMatch(JSON.stringify(snapshot), /Private generated text|feeling a little dizzy/);
      }
    }
  } finally {
    responsiveness.setEnabled(false);
    if (previous) Object.defineProperty(globalThis, '__DEV__', previous);
    else Reflect.deleteProperty(globalThis, '__DEV__');
  }
});

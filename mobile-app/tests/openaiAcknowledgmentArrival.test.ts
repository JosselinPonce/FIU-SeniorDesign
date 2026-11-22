import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceCheck } from '../lib/voice/voiceCheck.ts';
import { recognitionEvidence } from '../lib/voice/coreRecognition.ts';
import { createOpenAIAcknowledgment } from '../lib/assistant/openaiAcknowledgment.ts';
import { createLocalAcknowledgmentRouter } from '../lib/assistant/acknowledgmentRouter.ts';
import { acknowledgmentCandidates, acknowledgmentContext } from '../lib/assistant/safetyAcknowledgment.ts';
import { createSensiPreferences } from './helpers/sensiConsent.ts';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

for (const latency of [1000, 2500, 3690, 5000]) for (const delivery of ['before-selection', 'after-selection', 'invalid-envelope'] as const) {
  test(`simulated NOT_OK with HTTP 200 at ${latency} ms: ${delivery}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let time = 0;
    const descriptor = Object.getOwnPropertyDescriptor(performance, 'now');
    Object.defineProperty(performance, 'now', { value: () => time, configurable: true });
    t.after(() => {
      if (descriptor) Object.defineProperty(performance, 'now', descriptor);
      else Reflect.deleteProperty(performance, 'now');
    });
    const advance = async (ms: number) => { time += ms; t.mock.timers.tick(ms); await tick(); };

    const policy = createSensiPreferences({ getSetting: async () => 'openai', setSetting: async () => {} });
    await policy.boot();
    await policy.selectDriver('driver-a');
    await policy.saveConsent('driver-a', true);
    const utterance = "No, I'm feeling dizzy";
    const context = acknowledgmentContext('bpm_high', 'en', utterance, 'voice');
    const text = acknowledgmentCandidates(context).find(candidate => candidate !== 'Thank you for telling me.')!;
    assert.ok(text);
    const requestId = '22222222-2222-4222-8222-222222222222';
    let returned = false, requests = 0, captures = 0;
    let signal: AbortSignal | null | undefined;
    const cloud = createOpenAIAcknowledgment({
      cachedCredential: () => ({ token: 'fixture-only', userId: 'fixture-account', revision: 1 }),
      subscribe: () => () => {},
    }, {
      url: 'https://fixture.invalid', publicKey: 'fixture-only', requestId: () => requestId,
      // Deliberately ignore abort, as a hosted request may still finish at the server.
      fetcher: async (_url, init) => {
        requests++;
        signal = init?.signal;
        await new Promise<void>(resolve => setTimeout(resolve, latency));
        returned = true;
        return Response.json({
          version: 3, requestId: delivery === 'invalid-envelope' ? 'wrong-id' : requestId,
          advisoryOnly: true, callAuthorized: false, status: 'ok', code: 'advisory', message: text,
        });
      },
    });
    const router = createLocalAcknowledgmentRouter(policy, { ready: () => false, generate: async () => '' }, cloud);
    let task: ReturnType<typeof router> | undefined;
    let releaseGuidance!: () => void;
    const guidance = new Promise<void>(resolve => { releaseGuidance = resolve; });
    const spoken: string[] = [];
    const check = new VoiceCheck({
      cancel() {},
      speak: async sentence => {
        spoken.push(sentence);
        if (sentence === 'If you need emergency help, call 911.') await guidance;
      },
      listen: async (_lang, _ms, _hints, id) => {
        const answer = ++captures === 1 ? utterance : 'No, thanks';
        return recognitionEvidence(id, { status: 'success', transcript: answer, finalTranscript: answer,
          isFinal: true, finalResultReceived: true });
      },
    }, 'en', '', {
      contactAvailable: true,
      startAcknowledgment: input => {
        task = router(input, { driverId: 'driver-a', simulation: true, cloudSimulation: true, current: () => true });
      },
      acknowledgment: () => task!.get('en'),
      cancelAcknowledgment: () => task?.cancel(),
    });

    const pending = check.run('bpm_high');
    await tick();
    assert.equal(requests, 1);
    assert.equal(captures, 1);
    assert.ok(spoken.includes('Please pull over as soon as it is safe.'));
    // The earlier cutoff keeps these cases deterministic even for short responses.
    const selectionMs = Math.min(2500, latency - 1);
    await advance(delivery === 'after-selection' ? selectionMs : latency);
    assert.equal(returned, delivery !== 'after-selection');
    assert.equal(signal?.aborted, delivery !== 'after-selection', 'completed client adapter releases its transport');
    releaseGuidance();
    const result = await pending;
    assert.equal(result.outcome, 'not_ok');
    assert.equal(result.contactCall, 'declined_offer');
    assert.equal(check.authorizesContact(result), false);
    assert.equal(task?.source, delivery === 'before-selection' ? 'openai' : 'fallback');
    assert.equal(spoken.includes(text), delivery === 'before-selection');
    const playbackCount = spoken.length;
    if (delivery === 'after-selection') {
      assert.equal(signal?.aborted, true, 'fallback selection aborts the in-flight request');
      await advance(latency - selectionMs);
      assert.equal(returned, true);
      assert.equal(spoken.length, playbackCount);
      assert.equal(task?.source, 'fallback');
    }
  });
}

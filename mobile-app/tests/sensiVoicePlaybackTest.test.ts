import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { createSensiVoicePlaybackTest, SENSI_VOICE_TRANSCRIPT, SENSI_VOICE_RESPONSE } from '../lib/assistant/sensiVoicePlaybackTest.ts';
import { AudioOwnership } from '../lib/voice/audioOwnership.ts';
import type { ConversationState } from '../modules/local-foundation-models/assistantConversation.ts';
import type { LocalPlaybackResult, OfflineTranscription } from '../modules/local-foundation-models/index.ts';

const voice = { id: 'fixture-zoe', name: 'Zoe', quality: 'Premium' as const, language: 'en-US' };
function setup(options: { delayed?: boolean; interrupted?: boolean; development?: boolean; prepare?: () => Promise<typeof voice> } = {}) {
  const audio = new AudioOwnership(), spoken: string[] = [], states: ConversationState[] = [], played: LocalPlaybackResult[] = [];
  let started!: () => void, cleaned!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const cleanup = new Promise<void>(resolve => { cleaned = resolve; });
  let cancels = 0;
  const runner = createSensiVoicePlaybackTest({ development: options.development ?? true, audio,
    prepare: options.prepare ?? (async () => voice),
    speak: async (text, voiceId) => {
      spoken.push(text); assert.equal(voiceId, voice.id);
      if (text === SENSI_VOICE_RESPONSE) {
        started();
        if (options.delayed) await cleanup;
      }
      const cancelled = options.delayed && text === SENSI_VOICE_RESPONSE;
      const interrupted = options.interrupted && text === SENSI_VOICE_RESPONSE;
      return { status: cancelled ? 'cancelled' : interrupted ? 'error' : 'completed', voiceId,
        reason: interrupted ? 'audio_interrupted' : cancelled ? 'cancelled' : 'completed', message: '', elapsedMs: 1 };
    },
    cancelSpeech: async () => { cancels++; }, onChange: state => { states.push(state); },
    onPlayback: (_text, result) => { played.push(result); },
  });
  return { runner, audio, spoken, states, played, entered, cleaned, cancels: () => cancels };
}

test('development fixture uses real Connected conversation policy and selected playback voice', async () => {
  const f = setup(); await f.runner.start();
  assert.deepEqual(f.spoken, ['How are you feeling?', SENSI_VOICE_RESPONSE]);
  assert.equal(f.states.at(-1)?.phase, 'complete');
  assert.deepEqual(f.states.at(-1)?.turns[0], { driver: SENSI_VOICE_TRANSCRIPT,
    assistant: SENSI_VOICE_RESPONSE, fallback: false, fallbackReason: undefined });
  assert.equal(f.audio.available, true); assert.equal(f.played.at(-1)?.status, 'completed');
});

for (const action of ['stop', 'close', 'preemptWithSafety'] as const) {
  test(`${action} waits for native cleanup and releases ownership without a late reply`, async () => {
    const f = setup({ delayed: true }); const running = f.runner.start(); await f.entered;
    let finished = false;
    const stopping = f.runner[action]().then(() => { finished = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finished, false); assert.equal(f.audio.available, false); assert.equal(f.cancels(), 1);
    await assert.rejects(f.audio.acquire('optional', async () => {}));
    f.cleaned(); await stopping; await running;
    assert.equal(f.audio.available, true); assert.equal(f.states.at(-1)?.phase, 'cancelled');
    assert.equal(f.spoken.length, 2); assert.equal(f.played.at(-1)?.status, 'cancelled');
    if (action === 'close') await assert.rejects(f.runner.start(), /closed/);
  });
}

test('real safety ownership blocks fixture playback and fixture preemption cannot take unrelated audio', async () => {
  const f = setup(); const release = await f.audio.acquire('safety', async () => {});
  await assert.rejects(f.runner.preemptWithSafety(), /Start fixture/);
  await f.runner.start();
  assert.deepEqual(f.spoken, []); assert.equal(f.states.at(-1)?.phase, 'error');
  assert.equal(f.audio.available, false); release(); assert.equal(f.audio.available, true);
});

test('native interruption is visible and releases the fixture lease', async () => {
  const f = setup({ interrupted: true }); await f.runner.start();
  assert.equal(f.states.at(-1)?.phase, 'error');
  assert.match(f.states.at(-1)?.message ?? '', /audio_interrupted/); assert.equal(f.audio.available, true);
});

test('closing during preparation prevents playback and missing voice errors fail explicitly', async () => {
  let prepare!: () => void;
  const f = setup({ prepare: () => new Promise(resolve => { prepare = () => resolve(voice); }) });
  const run = f.runner.start(); await Promise.resolve(); const closing = f.runner.close();
  prepare(); await closing; await run; assert.deepEqual(f.spoken, []); assert.equal(f.audio.available, true);
  const missing = setup({ prepare: async () => { throw new Error('Selected voice unavailable'); } });
  await missing.runner.start(); assert.deepEqual(missing.spoken, []);
  assert.match(missing.states.at(-1)?.message ?? '', /Selected voice unavailable/);
});

test('release guard refuses fixture construction; UI wiring stays behind development-only require', () => {
  assert.throws(() => setup({ development: false }), /development-only/);
  const settings = readFileSync(new NodeURL('../components/SettingsView.tsx', import.meta.url), 'utf8');
  assert.match(settings, /SensiVoicePlaybackDiagnostic = __DEV__\s*\? \(require/);
  const ui = readFileSync(new NodeURL('../components/SensiVoicePlaybackDiagnostic.tsx', import.meta.url), 'utf8');
  assert.match(ui, /if \(!__DEV__\) return null/); assert.match(ui, /speak: speakLocal, cancelSpeech: cancelLocalSpeech/);
  assert.match(ui, /status !== 'active'.*test.stop/);
  assert.match(ui, /if \(props.blocked\).*stop/);
  assert.doesNotMatch(ui, /supabase|fetch\(|driver\.|emergency_phone/);
  assert.match(ui, /useMicrophone: \(\) => microphoneTest.current/);
  assert.match(ui, /listenOffline\('en-US', id, 15000\)/);
});

test('offline microphone diagnostic starts only after the opening completes and cancels capture before releasing audio', async () => {
  const audio = new AudioOwnership(); const spoken: string[] = []; let capturing!: () => void, finishCapture!: () => void;
  let cancellations = 0;
  const entered = new Promise<void>(resolve => { capturing = resolve; });
  const pending = new Promise<void>(resolve => { finishCapture = resolve; });
  const runner = createSensiVoicePlaybackTest({ development: true, audio,
    prepare: async () => voice,
    speak: async (text, voiceId) => { spoken.push(text); return { status: 'completed', reason: 'complete', message: '', voiceId, elapsedMs: 1 }; },
    cancelSpeech: async () => {}, useMicrophone: () => true,
    listen: async (_id, progress): Promise<OfflineTranscription> => {
      assert.deepEqual(spoken, ['How are you feeling?']); progress('listening', ''); capturing(); await pending;
      return { status: 'cancelled', locale: 'en-US', requiresOnDeviceRecognition: true, transcript: '', isFinal: false,
        reason: 'cancelled', message: '', totalTimeMs: 0, recognitionTimeMs: 0, listeningTimeMs: 0,
        finalizationTimeMs: 0, firstPartialTimeMs: 0, endpointReason: 'cancelled', silenceTargetMs: 0, finalizationGraceMs: 0 };
    },
    cancelListening: async () => { cancellations++; }, onChange: () => {}, onPlayback: () => {},
  });
  const run = runner.start(); await entered; const stopping = runner.stop();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancellations, 1); assert.equal(audio.available, false);
  finishCapture(); await stopping; await run;
  assert.equal(audio.available, true); assert.equal(spoken.length, 1);
});

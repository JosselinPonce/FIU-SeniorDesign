import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import ts from 'typescript';
import { AudioOwnership } from '../lib/voice/audioOwnership.ts';
import { recognitionEvidence } from '../lib/voice/coreRecognition.ts';
import { voiceCheckSpokenText } from '../lib/voice/voiceCheckPresentation.ts';
function harness(options: { deactivate?: () => void; idle?: () => Promise<boolean>; native?: Record<string, unknown>; aligned?: boolean; development?: boolean } = {}) {
  const audio=new AudioOwnership();const spoken: string[]=[]; const categories: any[]=[];
  const timings: { point: string; details: any }[] = [];
  const source=readFileSync(new NodeURL('../lib/voice/speechIO.ts',import.meta.url),'utf8');
  const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const exports:any={};
  const deps:Record<string,unknown>={
    './voiceCheckPresentation': { voiceCheckSpokenText },
    './audioOwnership':{appAudio:audio},'./responsivenessDiagnostics':{responsivenessProbe:()=>(point: string, details: any)=>timings.push({ point, details }),responsiveness:{},debugSessionAlignmentEnabled:()=>!!options.aligned},
    'react-native':{Platform:{OS:'ios'}},
    'expo-speech':{getAvailableVoicesAsync:async()=>[{identifier:'installed.premium.voice',name:'Fixture',language:'en-US',quality:'Premium'}],
      speak:(_text:string,options:any)=>{spoken.push(options.voice);options.onDone();},stop:async()=>{},isSpeakingAsync: options.idle ?? (async()=>false)},
    'expo-speech-recognition':{ExpoSpeechRecognitionModule:{getStateAsync:async()=>'inactive',setCategoryIOS(value: any){ categories.push(value); },setAudioSessionActiveIOS(active: boolean){ if (!active) options.deactivate?.(); }}},
    '../../modules/local-foundation-models':options.native ?? {},'./coreRecognition':{recognitionEvidence},
  };
  new Function('require','exports','__DEV__',compiled)((name:string)=>{assert.ok(name in deps,name);return deps[name];},exports,!!options.development);
  return {exports,spoken,audio,timings,categories};
}
test('Sensi safety mode does not replace an unavailable saved voice and returns button/recognition fallback status',async()=>{
  const f=harness();f.exports.setPreferredVoice('en','removed.voice');
  assert.deepEqual(await f.exports.phoneSensiVoiceIO().speak('Are you okay?','en'),{status:'unavailable'});
  assert.deepEqual(f.spoken,[]);f.exports.releaseAudio();
});
test('Sensi safety uses the exact installed premium identifier; CORE retains existing automatic fallback',async()=>{
  const sensi=harness();sensi.exports.setPreferredVoice('en','installed.premium.voice');
  await sensi.exports.phoneSensiVoiceIO().speak('Are you okay?','en');assert.deepEqual(sensi.spoken,['installed.premium.voice']);sensi.exports.releaseAudio();
  const core=harness();core.exports.setPreferredVoice('en','removed.voice');
  await core.exports.phoneVoiceIO().speak('Are you okay?','en');assert.deepEqual(core.spoken,['installed.premium.voice']);core.exports.releaseAudio();
});

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
test('cleanup failure retains one owner and a later safety check recovers', async () => {
  let fail = true;
  const f = harness({ deactivate: () => { if (fail) throw new Error('session busy'); } });
  await f.exports.phoneVoiceIO().speak('First', 'en');
  f.exports.releaseAudio(); await tick();
  assert.equal(f.audio.available, false);
  await assert.rejects(f.audio.acquire('optional', async () => {}));
  fail = false;
  await f.exports.phoneVoiceIO().speak('Recovered', 'en');
  assert.equal(f.spoken.length, 2);
  f.exports.releaseAudio(); await tick();
  assert.equal(f.audio.available, true);
});
test('cancellation during recovery cannot start playback or release an unverified owner', async () => {
  let fail = true;
  let resolveIdle!: (value: boolean) => void;
  let recovering = false;
  const f = harness({ deactivate: () => { if (fail) throw new Error('session busy'); },
    idle: async () => recovering ? new Promise<boolean>(resolve => { resolveIdle = resolve; }) : false });
  await f.exports.phoneVoiceIO().speak('First', 'en');
  f.exports.releaseAudio(); await tick();
  fail = false; recovering = true;
  const next = f.exports.phoneVoiceIO();
  const pending = next.speak('Must not play', 'en');
  await tick(); next.cancel();
  assert.equal(f.audio.available, false);
  recovering = false; resolveIdle(false);
  await assert.rejects(pending, /cancelled/);
  assert.equal(f.spoken.length, 1);
  assert.equal(f.audio.available, true);
});
test('a different safety adapter cannot reuse an existing safety lease', async () => {
  const f = harness();
  await f.exports.phoneVoiceIO().speak('First', 'en');
  await assert.rejects(f.exports.phoneVoiceIO().speak('Second', 'en'), /owns audio/);
  assert.equal(f.spoken.length, 1);
  f.exports.releaseAudio(); await tick();
});

test('stalled idle check is bounded and later cleanup can recover without releasing early', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let stalled = true;
  const f = harness({ idle: async () => stalled ? new Promise<boolean>(() => {}) : false });
  await f.exports.phoneVoiceIO().speak('First', 'en');
  f.exports.releaseAudio(); await tick();
  t.mock.timers.tick(2500); await tick();
  assert.equal(f.audio.available, false);
  stalled = false;
  await f.exports.phoneVoiceIO().speak('Recovered', 'en');
  assert.equal(f.spoken.length, 2);
  f.exports.releaseAudio(); await tick();
  assert.equal(f.audio.available, true);
});
test('safety preemption times out without stealing an optional lease and can retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const audio = new AudioOwnership();
  let stalled = true;
  const releaseOptional = await audio.acquire('optional', async () => {
    if (stalled) await new Promise<void>(() => {});
    releaseOptional();
  });
  const pending = audio.acquire('safety', async () => {});
  const rejection = assert.rejects(pending, /timed out/);
  await tick(); t.mock.timers.tick(5000); await rejection;
  assert.equal(audio.available, false);
  await assert.rejects(audio.acquire('optional', async () => {}));
  stalled = false;
  const releaseSafety = await audio.acquire('safety', async () => {});
  assert.equal(audio.available, false); releaseSafety();
  assert.equal(audio.available, true);
});

test('native progress is capture scoped, removed on completion and preserves coded failure evidence', async () => {
  let progress!: (value: any) => void;
  let complete!: (value: any) => void;
  let removed = 0;
  const phases: string[] = [];
  const f = harness({ native: {
    subscribeOfflineSpeechProgress: (listener: any) => { progress = listener; return { remove() { removed++; } }; },
    listenOffline: () => new Promise(resolve => { complete = resolve; }), cancelOfflineListening: async () => {},
  } });
  const io = f.exports.phoneVoiceIO();
  const pending = io.listen('en', 6000, [], 'capture-one', (phase: string) => phases.push(phase));
  await tick();
  assert.deepEqual(phases, ['preparing']);
  progress({ requestId: 'old-capture', phase: 'listening' });
  assert.deepEqual(phases, ['preparing']);
  progress({ requestId: 'capture-one', phase: 'listening' });
  progress({ requestId: 'capture-one', phase: 'finalizing' });
  complete({ status: 'error', reason: 'audio_route_changed', transcript: '', isFinal: false,
    locale: 'en-US', requiresOnDeviceRecognition: true });
  const result = await pending;
  assert.equal(result.reason, 'audio_route_changed');
  assert.equal(result.status, 'error');
  assert.deepEqual(phases, ['preparing', 'listening', 'finalizing']); assert.equal(removed, 1);
});

test('cancelled native progress cannot publish listening or accept a late final', async () => {
  let progress!: (value: any) => void;
  let complete!: (value: any) => void;
  const phases: string[] = [];
  const f = harness({ native: {
    subscribeOfflineSpeechProgress: (listener: any) => { progress = listener; return { remove() {} }; },
    listenOffline: () => new Promise(resolve => { complete = resolve; }), cancelOfflineListening: async () => {},
  } });
  const io = f.exports.phoneVoiceIO();
  const pending = io.listen('en', 6000, [], 'capture', (phase: string) => phases.push(phase));
  await tick(); io.cancel();
  progress({ requestId: 'capture', phase: 'listening' });
  complete({ status: 'success', transcript: 'yes', finalTranscript: 'yes', isFinal: true, finalResultReceived: true,
    locale: 'en-US', requiresOnDeviceRecognition: true });
  assert.equal((await pending).status, 'stale'); assert.deepEqual(phases, ['preparing']);
});

test('Spanish native finalized evidence preserves the shared VoiceCheck adapter contract and response window', async () => {
  const calls: unknown[] = [];
  const f = harness({ native: {
    subscribeOfflineSpeechProgress: () => ({ remove() {} }),
    listenOffline: async (...args: unknown[]) => {
      calls.push(args);
      return { status: 'success', transcript: 'Sí, estoy bien.', finalTranscript: 'Sí, estoy bien.',
        isFinal: true, finalResultReceived: true, locale: 'es-US', recognitionLocale: 'es-US', requiresOnDeviceRecognition: true,
        preparationTimeMs: 335, listeningTimeMs: 1500, finalizationTimeMs: 200, totalTimeMs: 2035 };
    }, cancelOfflineListening: async () => {},
  } });
  const io = f.exports.phoneVoiceIO();
  const result = await io.listen('es', 6000, [], 'spanish-one');
  assert.deepEqual(calls, [['es-US', 'spanish-one', 6000]]);
  assert.equal(result.status, 'success');
  assert.equal(result.finalTranscript, 'Sí, estoy bien.');
  assert.equal(result.captureId, 'spanish-one');
  assert.equal(result.finalResultReceived, true);
  assert.equal(result.isFinal, true);
  assert.deepEqual(f.timings.find(event => event.point === 'native recognition completed')?.details,
    { captureId: 'spanish-one', hasTranscript: true, hasFinalText: true, isFinal: true, finalResultReceived: true,
      localeMatches: true, onDeviceRequired: true, status: 'success', reason: undefined, nativeRevision: undefined, cueFailed: false, outputVolume: undefined, outputRoute: undefined,
      nativeMs: 2035, preparationMs: 335, listeningMs: 1500, finalizingMs: 200 });
  f.exports.releaseAudio();
});

test('Spanish offline asset failures remain failures without manufacturing final evidence', async () => {
  const f = harness({ native: {
    subscribeOfflineSpeechProgress: () => ({ remove() {} }),
    listenOffline: async () => ({ status: 'error', reason: 'offline_assets_unavailable', transcript: '',
      finalTranscript: '', isFinal: false, finalResultReceived: false, locale: 'es-US', requiresOnDeviceRecognition: true }),
    cancelOfflineListening: async () => {},
  } });
  const result = await f.exports.phoneVoiceIO().listen('es', 6000, [], 'spanish-failed');
  assert.equal(result.status, 'error');
  assert.equal(result.reason, 'offline_assets_unavailable');
  assert.equal(result.isFinal, false);
  assert.equal(result.finalTranscript, '');
  f.exports.releaseAudio();
});

for (const language of ['en', 'es']) test(`${language}: listening follows native readiness with the unchanged response window`, async () => {
  let progress!: (event: any) => void;
  let complete!: (result: any) => void;
  const phases: string[] = [];
  const calls: unknown[] = [];
  const f = harness({ native: {
    playVoiceCheckListeningCue: () => { throw new Error('JavaScript must not start the cue'); },
    cancelOfflineListening: async () => {},
    subscribeOfflineSpeechProgress: (listener: any) => { progress = listener; return { remove() {} }; },
    listenOffline: (...args: unknown[]) => { calls.push(args); return new Promise(resolve => { complete = resolve; }); },
  } });
  const pending = f.exports.phoneVoiceIO().listen(language, 6000, [], 'ready-test', (phase: string) => phases.push(phase));
  await tick();
  assert.deepEqual(calls, [[language === 'es' ? 'es-US' : 'en-US', 'ready-test', 6000]]);
  assert.deepEqual(phases, ['preparing']);
  progress({ requestId: 'another-capture', phase: 'listening' });
  assert.deepEqual(phases, ['preparing']);
  progress({ requestId: 'ready-test', phase: 'listening' });
  assert.deepEqual(phases, ['preparing', 'listening']);
  complete({ status: 'timeout', transcript: '', isFinal: false, locale: language === 'es' ? 'es-US' : 'en-US', requiresOnDeviceRecognition: true });
  await pending;
  f.exports.releaseAudio();
});

test('cancelling native preparation/cue ignores later listening events and final speech', async () => {
  let progress!: (event: any) => void;
  let complete!: (result: any) => void;
  let cancelled = 0;
  const phases: string[] = [];
  const f = harness({ native: {
    cancelOfflineListening: async () => { cancelled++; },
    subscribeOfflineSpeechProgress: (listener: any) => { progress = listener; return { remove() {} }; },
    listenOffline: () => new Promise(resolve => { complete = resolve; }),
  } });
  const io = f.exports.phoneVoiceIO();
  const pending = io.listen('es', 6000, [], 'cancel-cue', (phase: string) => phases.push(phase));
  await tick(); io.cancel();
  progress({ requestId: 'cancel-cue', phase: 'listening' });
  complete({ status: 'success', transcript: 'sí', finalTranscript: 'sí', isFinal: true, finalResultReceived: true, locale: 'es-US', requiresOnDeviceRecognition: true });
  assert.equal((await pending).status, 'stale');
  assert.equal(cancelled, 1);
  assert.deepEqual(phases, ['preparing']);
  f.exports.releaseAudio();
});

for (const language of ['en', 'es'] as const) test(`${language}: microphone-free native prewarm overlaps playback and scoped activation retains the full response window`, async () => {
  const events: string[] = [];
  let acknowledge!: (value: any) => void;
  const f = harness({ native: {
    prepareOfflineRecognition: (locale: string, id: string) => { events.push(`prepare:${locale}:${id}`); return new Promise(resolve => { acknowledge = resolve; }); },
    subscribeOfflineSpeechProgress: () => ({ remove() {} }),
    cancelOfflineListening: async () => {},
    listenOffline: async (locale: string, id: string, ms: number) => {
      events.push('listen'); assert.equal(ms, 6000); assert.equal(id, 'warm');
      return { status: 'success', locale, requiresOnDeviceRecognition: true, transcript: 'yes', finalTranscript: 'yes', isFinal: true, finalResultReceived: true,
        nativeTimingMs: { prewarmStarted: 0, analyzerPreparationCompleted: 100, listeningGateOpened: 1000 } };
    },
  } });
  const io = f.exports.phoneVoiceIO();
  io.prepareRecognition(language, 'warm');
  await io.speak('Are you okay?', language);
  assert.equal(f.spoken.length, 1);
  assert.equal(events.length, 1, 'preparation acknowledgement must not block TTS');
  const pending = io.listen(language, 6000, [], 'warm'); await tick();
  assert.equal(events.includes('listen'), false);
  acknowledge({ status: 'started' });
  assert.equal((await pending).status, 'success');
  assert.ok(f.timings.some(event => event.point === 'native monotonic milestones' && event.details.nativeTimingMs.listeningGateOpened === 1000));
  f.exports.releaseAudio(); await tick();
});
test('cancellation before native prewarm acknowledgement waits for cleanup and never activates capture', async () => {
  let acknowledge!: (value: any) => void, cancels = 0, listens = 0;
  const f = harness({ native: {
    prepareOfflineRecognition: () => new Promise(resolve => { acknowledge = resolve; }),
    cancelOfflineListening: async (id: string) => { assert.equal(id, 'cancel-warm'); cancels++; },
    subscribeOfflineSpeechProgress: () => ({ remove() {} }),
    listenOffline: async () => { listens++; },
  } });
  const io = f.exports.phoneVoiceIO(); io.prepareRecognition('en', 'cancel-warm'); await io.speak('Prompt', 'en');
  io.cancel(); f.exports.releaseAudio(); await tick();
  assert.equal(f.audio.available, false);
  acknowledge({ status: 'started' }); await tick();
  assert.equal(cancels, 1); assert.equal(listens, 0); assert.equal(f.audio.available, true);
});
test('native preparation failure preserves recognition-unavailable evidence and never activates capture', async () => {
  const f = harness({ native: { prepareOfflineRecognition: async () => ({ status: 'error', reason: 'offline_assets_unavailable' }),
    cancelOfflineListening: async () => {}, subscribeOfflineSpeechProgress: () => ({ remove() {} }),
    listenOffline: async () => { throw Error('must not activate'); } } });
  const io = f.exports.phoneVoiceIO(); io.prepareRecognition('es', 'failed-warm'); await io.speak('Prompt', 'es');
  assert.equal((await io.listen('es', 6000, [], 'failed-warm')).status, 'error');
  io.cancel(); f.exports.releaseAudio(); await tick();
});

for (const aligned of [true, false]) test(`Debug aligned session ${aligned ? 'reuses prompt session' : 'falls back before TTS'}`, async () => {
  const events: string[] = [];
  const f = harness({ aligned: true, native: {
    prepareOfflineRecognition: async () => { events.push('prepare'); return { status: 'started' }; },
    prepareVoiceCheckAlignedSession: async () => { events.push('session'); return { aligned, reason: 'fixture' }; },
    cancelOfflineListening: async () => { events.push('cleanup'); },
  } });
  const io = f.exports.phoneSensiVoiceIO(); io.prepareRecognition('en', 'aligned');
  f.exports.setPreferredVoice('en', 'installed.premium.voice');
  await io.speak('Are you okay?', 'en');
  assert.deepEqual(events, ['prepare', 'session']);
  assert.deepEqual(f.spoken, ['installed.premium.voice']);
  assert.equal(f.categories.length, aligned ? 0 : 1);
  io.cancel(); await tick();
  assert.ok(events.includes('cleanup'));
  f.exports.releaseAudio(); await tick();
});
test('cancellation while aligning waits for setup, cleans up, and never speaks', async () => {
  let settle!: (value: any) => void; let cleaned = false;
  const f = harness({ aligned: true, native: {
    prepareOfflineRecognition: async () => ({ status: 'started' }),
    prepareVoiceCheckAlignedSession: () => new Promise(resolve => { settle = resolve; }),
    cancelOfflineListening: async () => { cleaned = true; },
  } });
  const io = f.exports.phoneVoiceIO(); io.prepareRecognition('en', 'cancel-alignment');
  const pending = io.speak('Are you okay?', 'en'); await tick();
  io.cancel(); await tick(); assert.equal(cleaned, false);
  settle({ aligned: true, reason: 'fixture' });
  await assert.rejects(pending, /cancelled/); await tick();
  assert.equal(cleaned, true); assert.deepEqual(f.spoken, []);
  f.exports.releaseAudio(); await tick();
});

for (const scenario of ['success', 'missing_final', 'wrong_locale', 'incomplete', 'cancelled', 'rejected'] as const) {
  test(`capture-scoped diagnostic explains adapter ${scenario} without recording text`, async () => {
    const secret = 'PRIVATE SYNTHETIC RESPONSE';
    const f = harness({ native: {
      subscribeOfflineSpeechProgress: () => ({ remove() {} }),
      listenOffline: async () => {
        if (scenario === 'rejected') throw new Error(secret);
        return { status: scenario === 'incomplete' ? 'incomplete' : scenario === 'cancelled' ? 'cancelled' : 'success',
          reason: scenario === 'incomplete' ? 'empty_final_after_partial' : scenario === 'cancelled' ? 'cancelled' : 'complete',
          locale: scenario === 'wrong_locale' ? 'es-US' : 'en-US', requiresOnDeviceRecognition: true,
          transcript: secret, finalTranscript: scenario === 'missing_final' || scenario === 'incomplete' ? '' : secret,
          isFinal: scenario !== 'incomplete', finalResultReceived: scenario !== 'missing_final' };
      },
    } });
    const result = await f.exports.phoneVoiceIO().listen('en', 6000, [], 'diagnostic-capture');
    const adapter = f.timings.find(e => e.point === 'adapter outcome')!;
    assert.equal(adapter.details.captureId, 'diagnostic-capture');
    assert.equal(adapter.details.status, result.status);
    assert.equal(adapter.details.usable === true, scenario === 'success');
    if (scenario !== 'rejected') {
      const native = f.timings.find(e => e.point === 'native recognition completed')!;
      assert.equal(native.details.captureId, 'diagnostic-capture');
      assert.equal(native.details.hasTranscript, true);
      assert.equal(native.details.localeMatches, scenario !== 'wrong_locale');
    } else assert.equal(adapter.details.stage, 'native_capture');
    assert.equal(JSON.stringify(f.timings).includes(secret), false);
    f.exports.releaseAudio();
  });
}

for (const mode of ['debug', 'mismatched_capture', 'release'] as const) test(`English finalization metadata is correlated and excluded from Release: ${mode}`, async () => {
  const debug = { captureId: mode === 'mismatched_capture' ? 'other' : 'english-diagnostic', rawAppleIsFinal: true,
    applicationFinalizationStarted: true, completionOrigin: 'final_after_application_endpoint',
    callbackError: {}, taskSnapshots: { beforeCleanupCancel: { state: 2, isCancelled: false, isFinishing: true } },
    endpointAtSelection: { silenceMs: 50 }, endpointAtCompletion: { silenceMs: 160 },
    endpointSelectionChecks: { deadlineExpired: true, silenceSatisfied: false }, endpointReady: true, hadPartial: true, deadlineRemainingMs: -110 };
  const f = harness({ development: mode !== 'release', native: {
    subscribeOfflineSpeechProgress: () => ({ remove() {} }),
    listenOffline: async () => ({ status: 'incomplete', reason: 'empty_final_after_partial', transcript: 'PRIVATE PARTIAL',
      finalTranscript: '', isFinal: false, finalResultReceived: true, locale: 'en-US', requiresOnDeviceRecognition: true,
      endpointReason: 'capture_budget', englishFinalizationDebug: debug }),
  } });
  const result = await f.exports.phoneVoiceIO().listen('en', 6000, [], 'english-diagnostic');
  assert.equal(result.status, 'incomplete'); assert.equal(result.isFinal, false);
  const details = f.timings.find(e => e.point === 'native recognition completed')!.details;
  assert.equal(details.captureId, 'english-diagnostic');
  assert.equal(details.endpointReason, mode === 'release' ? undefined : 'capture_budget');
  assert.equal(details.englishFinalization, mode === 'debug' ? debug : undefined);
  assert.equal(JSON.stringify(f.timings).includes('PRIVATE PARTIAL'), false);
  f.exports.releaseAudio();
});

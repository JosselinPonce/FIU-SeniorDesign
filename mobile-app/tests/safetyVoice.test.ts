import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import ts from 'typescript';
import { AudioOwnership } from '../lib/voice/audioOwnership.ts';
import { recognitionEvidence } from '../lib/voice/coreRecognition.ts';
function harness(options: { deactivate?: () => void; idle?: () => Promise<boolean> } = {}) {
  const audio=new AudioOwnership();const spoken: string[]=[];
  const source=readFileSync(new NodeURL('../lib/voice/speechIO.ts',import.meta.url),'utf8');
  const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const exports:any={};
  const deps:Record<string,unknown>={
    './audioOwnership':{appAudio:audio},'./responsivenessDiagnostics':{responsivenessProbe:()=>()=>{},responsiveness:{}},
    'react-native':{Platform:{OS:'ios'}},
    'expo-speech':{getAvailableVoicesAsync:async()=>[{identifier:'installed.premium.voice',name:'Fixture',language:'en-US',quality:'Premium'}],
      speak:(_text:string,options:any)=>{spoken.push(options.voice);options.onDone();},stop:async()=>{},isSpeakingAsync: options.idle ?? (async()=>false)},
    'expo-speech-recognition':{ExpoSpeechRecognitionModule:{getStateAsync:async()=>'inactive',setCategoryIOS(){},setAudioSessionActiveIOS(active: boolean){ if (!active) options.deactivate?.(); }}},
    '../../modules/local-foundation-models':{},'./coreRecognition':{recognitionEvidence},
  };
  new Function('require','exports',compiled)((name:string)=>{assert.ok(name in deps,name);return deps[name];},exports);
  return {exports,spoken,audio};
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

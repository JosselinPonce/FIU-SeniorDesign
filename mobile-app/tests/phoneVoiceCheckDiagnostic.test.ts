import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { recognitionEvidence } from '../lib/voice/coreRecognition.ts';
import { voiceCheckSpokenText } from '../lib/voice/voiceCheckPresentation.ts';
import type { DiagnosticIO } from '../lib/voice/voiceCheckDiagnostic.ts';
const tick = () => new Promise<void>(r => setImmediate(r));
function fixture() {
  let listener!: (event: any) => void; let locale = ''; let offline = true; let removed = 0;
  let voiceResolve: ((v: any[]) => void) | null = null;
  const locales: string[] = [], cancelled: string[] = [], spoken: any[] = [];
  let speaking = false, stops = 0;
  const exports: any = {};
  const source = readFileSync(new NodeURL('../lib/voice/phoneVoiceCheckDiagnostic.ts', import.meta.url), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports, setTimeout, require(name: string) {
      if (name === 'expo-speech') return { speak: (text: string, options: any) => { spoken.push({text,options}); speaking = true; }, stop: async () => { stops++; speaking = false; spoken.at(-1)?.options.onStopped(); }, isSpeakingAsync: async () => speaking };
      if (name === 'react-native') return { Platform: { OS: 'ios' } };
      if (name.endsWith('local-foundation-models')) return {
        subscribeOfflineSpeechProgress: (callback: typeof listener) => { listener = callback; return { remove: () => { removed++; } }; },
        listenOffline: async (requested: string, id: string) => { locales.push(requested); listener({requestId:'stale',phase:'listening',transcript:'stale'}); listener({requestId:id,phase:'listening',transcript:'bien'}); return { status:'success',locale:locale||requested,requiresOnDeviceRecognition:offline,transcript:'bien',finalTranscript:'bien',isFinal:true,finalResultReceived:true }; },
        cancelOfflineListening: async (id: string) => { cancelled.push(id); },
      };
      if (name === './audioOwnership') return { appAudio: { acquire: async (priority: string) => { assert.equal(priority,'optional'); return () => {}; } } };
      if (name === './coreRecognition') return { recognitionEvidence };
      if (name === './voiceCheckPresentation') return { voiceCheckSpokenText };
      if (name === './speechIO') return { listVoices: (lang: string) => { locales.push('voice:'+lang); return new Promise(resolve => { voiceResolve = resolve; }); } };
      throw Error('Unexpected diagnostic dependency: '+name);
    },
  });
  return { io: exports.phoneVoiceCheckDiagnostic(() => true) as DiagnosticIO, locales,cancelled,spoken,
    mismatch: () => { locale='en-US'; }, online: () => { offline=false; }, removed: () => removed, stops: () => stops,
    voices: () => voiceResolve!([{id:'selected-language-voice'}]) };
}
for (const lang of ['en','es'] as const) test(`phone diagnostic reuses scoped offline ${lang} recognition`,async()=>{
  const f=fixture(); const progress:string[]=[];const result=await f.io.listen(lang,'own-id',(_phase,text)=>progress.push(text));
  assert.deepEqual(f.locales,[lang==='en'?'en-US':'es-US']);assert.deepEqual(progress,['bien']);assert.equal(result.status,'success');assert.equal(f.removed(),1);
  await f.io.cancel('listening','own-id');assert.deepEqual(f.cancelled,['own-id']);
  f.online();assert.equal((await f.io.listen(lang,'next',()=>{})).status,'error');
});
test('wrong-language native results are not accepted',async()=>{const f=fixture();f.mismatch();assert.equal((await f.io.listen('es','id',()=>{})).status,'error');});
test('cancel before voice selection prevents delayed playback; stale cancel cannot stop another request',async()=>{
  const f=fixture();const pending=f.io.speak('Preview','es','first');await tick();await f.io.cancel('playing','first');f.voices();await pending;assert.equal(f.spoken.length,0);assert.equal(f.stops(),0);
  const next=f.io.speak('llama al 911','es','second');await tick();f.voices();await tick();assert.equal(f.spoken[0].options.language,'es-US');assert.match(f.spoken[0].text,/nueve uno uno/);
  await f.io.cancel('playing','first');assert.equal(f.stops(),0);await f.io.cancel('playing','second');await next;assert.equal(f.stops(),1);
});


test('playback errors still drain native speech before returning ownership', async () => {
  const f = fixture(); let settled = false;
  const pending = f.io.speak('Preview', 'en', 'error-id').catch(() => { settled = true; });
  await tick(); f.voices(); await tick(); f.spoken[0].options.onError(); await tick();
  assert.equal(settled, false, 'an error callback cannot release still-speaking audio');
  await f.io.cancel('playing', 'error-id'); await pending;
  assert.equal(settled, true); assert.equal(f.stops(), 1);
});

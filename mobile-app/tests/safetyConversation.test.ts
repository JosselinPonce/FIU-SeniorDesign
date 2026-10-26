import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { SafetyController, type SafetyState } from '../lib/analysis/safetyController.ts';
import { recognitionEvidence, type CoreRecognition } from '../lib/voice/coreRecognition.ts';
import type { AssistantMode } from './retired-ai/lib/assistant/mode.ts';
import { safetyButtonText } from '../lib/assistant/safetyConversation.ts';
import { AudioOwnership } from '../lib/voice/audioOwnership.ts';
import { AssistantConversation } from '../modules/local-foundation-models/assistantConversation.ts';
const profile = { id: 'fixture', custom_id: null, display_name: 'Driver', weight_kg: 80, age: 30, height_cm: 180,
  gender: 'male' as const, created_at: '', updated_at: '', conditions: '[]', medications: '[]', language: 'en', emergency_phone: '+13055550123' };
const tick = () => new Promise<void>(r => setImmediate(r));
function fixture(mode: AssistantMode, answers: (string | null)[], options: {
  listen?: (id: string) => Promise<CoreRecognition | null>; cancel?: () => void; speak?: (text: string) => Promise<void | {status:'unavailable'}>;
} = {}) {
  const states: SafetyState[] = [], spoken: string[] = [], saved: unknown[] = [], calls: string[] = [];
  let id = 0;
  const c = new SafetyController({ assistantMode: () => mode,
    voiceIO: () => ({ speak: async text => { spoken.push(text); return options.speak?.(text); },
      listen: async (_lang,_ms,_hints,captureId) => {
        if(options.listen) return options.listen(captureId);
        const text=answers.shift(); return text == null ? null : recognitionEvidence(captureId, {status:'success',transcript:text,finalTranscript:text,isFinal:true,finalResultReceived:true});
      },cancel() { options.cancel?.(); } }), save: async row => {saved.push(row);},saveAck: async () => {},haptic() {},
    handoffContact: async phone => {calls.push(phone);},onChange: s => states.push(s), newId: () => `episode-${++id}` });
  c.configure(profile,null); c.startSession('session-1');
  function trigger() {
    for(let n=0;n<30&&!states.at(-1)?.check;n++)c.onFrame({version:3,rateHz:0,quality:90,seq:n,startMs:0,endMs:0,
      heartRate:155,spo2:98,flags:15,samples:[],finger:true,usable:true,raw:new Uint8Array()},new Date(100000+n*1000),0);
    assert.ok(states.at(-1)?.check);
  }
  async function settle(){for(let n=0;n<15;n++)await tick();}
  return {c,states,spoken,saved,calls,trigger,settle,last:()=>states.at(-1)!};
}
for(const mode of ['local','connected'] as const){
  test(`${mode}: deterministic safety dialogue is mirrored without model access; standalone continuation is disabled`,async()=>{
    const f=fixture(mode,['yes']);f.trigger();await f.settle();
    const d=f.last().conversation!;assert.equal(d.mode,mode);assert.equal(d.finished,true);
    assert.deepEqual(d.messages.map(m=>m.role),['assistant','driver','assistant']);
    assert.match(d.messages[0]!.text,/Are you feeling okay/);assert.equal(d.messages[1]!.text,'yes');
    assert.equal(d.messages[0]!.playback,'completed');
    assert.equal(f.c.safetyContinuation(d.episodeId),false);assert.equal(f.c.consumeSafetyContinuation(d.episodeId),false);
    assert.equal(f.c.consumeSafetyContinuation(d.episodeId),false);assert.equal(f.calls.length,0);
    assert.equal(f.last().conversation?.finished,true);
  });
  test(`${mode}: direct requests, offered consent, refusals and emergency exclusions retain deterministic outcomes`,async()=>{
    for(const [answers,expectedCalls] of [[['no','yes please'],1],[["I'm dizzy, call my mom"],1],[['no','no thanks'],0],
      [['maybe','perhaps'],0],[['I need help call 911','yes please'],0]] as [string[],number][]){
      const f=fixture(mode,answers);f.trigger();await f.settle();assert.equal(f.calls.length,expectedCalls);
      assert.equal(f.c.safetyContinuation(f.last().last!.episode.id),false);
      assert.ok(f.saved.length>0);
    }
  });
  test(`${mode}: incomplete/legacy text cannot authorize calls or enter the confirmed thread`,async()=>{
    const f=fixture(mode,[],{listen:async id=>recognitionEvidence(id,{status:'incomplete',transcript:'call my mom',isFinal:false})});
    f.trigger();await f.settle();assert.equal(f.calls.length,0);assert.equal(f.last().last?.result.outcome,'no_response');
    assert.equal(f.last().conversation?.messages.some(m=>m.role==='driver'),false);
  });
  test(`${mode}: session cancellation rejects late speech and never restores a stale thread or continuation`,async()=>{
    let resolve!: (v:CoreRecognition)=>void;let captureId='';
    const f=fixture(mode,[],{listen:id=>{captureId=id;return new Promise(r=>{resolve=r;});}});
    f.trigger();await tick();f.c.endSession();resolve(recognitionEvidence(captureId,{status:'success',transcript:'call my mom',finalTranscript:'call my mom',isFinal:true,finalResultReceived:true}));
    await f.settle();assert.equal(f.calls.length,0);assert.equal(f.last().conversation,null);
    assert.equal(f.c.safetyContinuation('episode-1'),false);
  });
  test(`${mode}: selected voice unavailable preserves episode and buttons without substituting speech`,async()=>{
    const f=fixture(mode,['yes'],{speak:async()=>({status:'unavailable'})});f.trigger();await f.settle();
    assert.ok(f.last().check?.fallbackText);assert.equal(f.last().check?.episode.id,f.last().conversation?.episodeId);
    f.c.answer('ok');await f.settle();
    assert.equal(f.last().last?.result.outcome,'ok');assert.equal(f.last().conversation?.messages[0]?.playback,'failed');
  });
  test(`${mode}: profile/session changes after resolution revoke offered continuation`,async()=>{
    const f=fixture(mode,['yes']);f.trigger();await f.settle();const episode=f.last().last!.episode.id;
    f.c.configure({...profile,id:'other'},null);assert.equal(f.c.safetyContinuation(episode),false);
  });
}
test('CORE keeps the same prompts and decisions without a second conversation view',async()=>{
  const core=fixture('core',['yes']);const local=fixture('local',['yes']);core.trigger();local.trigger();await core.settle();await local.settle();
  assert.deepEqual(core.spoken,local.spoken);assert.equal(core.last().conversation,null);
  assert.equal(core.last().last?.result.outcome,local.last().last?.result.outcome);
});
test('only the first button/voice winner is displayed and acted on',async()=>{
  let resolve!: (v:CoreRecognition)=>void;let id='';
  const f=fixture('connected',[],{listen:captureId=>{id=captureId;return new Promise(r=>{resolve=r;});}});
  f.trigger();await tick();f.c.answer('ok');f.c.answer('not_ok');await f.settle();
  resolve(recognitionEvidence(id,{status:'success',transcript:'call my mom',finalTranscript:'call my mom',isFinal:true,finalResultReceived:true}));await f.settle();
  assert.equal(f.last().last?.result.outcome,'ok');assert.equal(f.calls.length,0);
  assert.deepEqual(f.last().conversation?.messages.filter(m=>m.role==='driver').map(m=>m.text),["I'm OK"]);
});
test('safety waits for ordinary Sensi cancellation/cleanup before deterministic playback',async()=>{
  const audio=new AudioOwnership();let entered!:()=>void;let finish!:()=>void;
  const ready=new Promise<void>(r=>{entered=r;});const pending=new Promise<any>(r=>{finish=()=>r({status:'cancelled'});});
  const ordinary=new AssistantConversation({prepare:async()=>{},acquire:stop=>audio.acquire('optional',stop),
    speak:async()=>{},listen:async()=>{entered();return pending;},interpret:async()=>{throw Error('unexpected inference');},
    cancel:async()=>finish(),handoff:async()=>{throw Error('unexpected call');},onChange() {}});
  const run=ordinary.start();await ready;let release: (()=>void)|undefined;
  const f=fixture('local',['yes'],{speak:async()=>{release??=await audio.acquire('safety',async()=>{});}});
  f.trigger();await f.settle();await run;assert.equal(f.last().last?.result.outcome,'ok');release?.();assert.equal(audio.available,true);
});
test('shared UI reuses deterministic answer handler; providers remain outside safety and continuation rechecks ownership',()=>{
  const read=(p:string)=>readFileSync(new NodeURL('../'+p,import.meta.url),'utf8');
  assert.doesNotMatch(read('lib/analysis/safetyController.ts'),/phoneAssistantProvider|\.generate\(|\.invoke\(/);
  assert.match(read('components/SensiSafetyConversation.tsx'),/drive.respondAlert/);
  assert.match(read('components/SensiSafetyConversation.tsx'),/pending.current = true/);
  assert.doesNotMatch(read('components/SmartWheelScreen.tsx'),/drive.continueSafetyConversation\(episodeId\)/);
  assert.equal(safetyButtonText('contact_offer',true),'Open phone interface');
});

test('emergency-services exclusion also prevents continuation after an otherwise OK wellness answer',async()=>{
  const f=fixture('connected',["I'm okay, I don't need an ambulance"]);f.trigger();await f.settle();
  assert.equal(f.last().last?.result.outcome,'ok');assert.equal(f.calls.length,0);
  assert.equal(f.c.safetyContinuation(f.last().last!.episode.id),false);
});

test('winning button marks cancelled prompt playback interrupted, never completed',async()=>{
  let finish!:()=>void;let first=true;
  const f=fixture('local',[],{speak:async()=>{if(first){first=false;await new Promise<void>(resolve=>{finish=resolve;});}},cancel:()=>finish()});
  f.trigger();f.c.answer('ok');await f.settle();
  assert.equal(f.last().last?.result.outcome,'ok');
  assert.equal(f.last().conversation?.messages[0]?.playback,'interrupted');
});

test('thrown initial playback failure retains episode and visible prompt until a button wins', async () => {
  let listens = 0;
  const f = fixture('local', [], { speak: async () => { throw Error('speaker unavailable'); },
    listen: async () => { listens++; return null; } });
  f.trigger(); await f.settle();
  const episodeId = f.last().check!.episode.id;
  assert.equal(f.last().conversation?.episodeId, episodeId);
  assert.match(f.last().check!.fallbackText!, /Are you feeling okay/);
  assert.equal(f.last().last, null);
  f.c.answer('not_ok'); await f.settle();
  assert.equal(f.last().check?.question, 'contact_offer');
  f.c.answer('call_no'); await f.settle();
  assert.equal(f.last().last?.episode.id, episodeId);
  assert.equal(f.last().last?.result.outcome, 'not_ok');
  assert.deepEqual(f.calls, []); assert.equal(listens, 0);
});

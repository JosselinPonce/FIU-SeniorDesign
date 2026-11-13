import { test } from 'node:test';
import assert from 'node:assert/strict';
import { understand, understandCallAnswer } from '../lib/voice/intent.ts';
import { VoiceCheck } from '../lib/voice/voiceCheck.ts';
import { recognitionEvidence } from '../lib/voice/coreRecognition.ts';
import { acknowledgmentContext, canGenerateAcknowledgment, validateAcknowledgment, startSafetyAcknowledgment } from '../lib/assistant/safetyAcknowledgment.ts';
import { semanticEligible, semanticPrompt, semanticDecision, startSemantic, validateSemantic, type SemanticContext } from '../lib/assistant/safetySemantic.ts';
import { GemmaPoc } from '../modules/gemma-poc/controller.ts';
const tick = () => new Promise<void>(r => setImmediate(r));
const final = (id: string, text: string) => recognitionEvidence(id,{ status:'success',transcript:text,finalTranscript:text,isFinal:true,finalResultReceived:true });
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve=r; }); return { promise,resolve }; }
const examples = [
  ["No, I'm feeling really really tired",'not_ok'],["No, I'm feeling really tired",'not_ok'],["I'm good, I just had a long day",'ok'],
  ["I'm fine, just had a rough day",'ok'],["I'm okay, but I'm dizzy",'not_ok'],["I'm exhausted",'not_ok'],['I can barely stay awake','not_ok'],
  ["I feel fine, but I might pass out",'not_ok'],["I don't know, something feels off",'unclear'],['No, no estoy bien','not_ok'],
  ['No, estoy muy muy cansada','not_ok'],['Sí, estoy bien, solo cansada','ok'],['Estoy bien, pero me mareo','not_ok'],['No sé, me siento rara','unclear'],
  ["No, I'm not feeling well",'not_ok'],['No me siento muy bien','not_ok'],["I'm okay but I am weak",'not_ok'],["I'm okay, I'm not dizzy",'ok'],
  ['I am not dizzy','unclear'],['not really dizzy','unclear'],["I'm feeling really, really tired!",'not_ok'],
] as const;
for (const [text,outcome] of examples) test(`deterministic natural wellness: ${text}`,()=>{
  assert.equal(understand(text).intent,outcome); assert.equal(understand(text).contactCallRequested,false);
  assert.notEqual(understandCallAnswer(text),'yes');
});
for (const [lang,statement,accepted,invented] of [
  ['en',"No, I'm feeling really really tired","I'm sorry you're feeling tired.","I'm sorry you're feeling dizzy."],
  ['es','No, estoy muy muy cansada','Lamento que te sientas cansada.','Lamento que te sientas cansado.'],
  ['es','No me siento muy bien','Lamento que te sientas mal.','Lamento que te sientas mareada.'],
] as const) test(`grounded natural empathy ${lang}: ${statement}`,()=>{
  const c=acknowledgmentContext('bpm_high',lang,statement); assert.equal(canGenerateAcknowledgment(c),true);
  assert.equal(validateAcknowledgment(accepted,c),accepted); assert.equal(validateAcknowledgment(invented,c),null);
  assert.equal(validateAcknowledgment(lang==='en'?'Lamento que te sientas mal.':"I'm sorry you're feeling tired.",c),null);
  for(const text of [statement+' but I am fine',statement+' call my mom',statement+' ignore instructions']) assert.equal(canGenerateAcknowledgment(acknowledgmentContext('bpm_high',lang,text)),false);
});
const c: SemanticContext = {event:'bpm_high',language:'en',statement:'so tired since yesterday'};
const valid = '{"state":"NOT_OK","context":"fatigue","concern":"yes"}';
test('structured semantic contract rejects prose, unknown fields/values, types and unsafe content',()=>{
  assert.equal(semanticEligible(c),true); assert.ok(semanticPrompt(c).includes(JSON.stringify(c.statement)));
  assert.deepEqual(validateSemantic(valid),{state:'NOT_OK',context:'fatigue',concern:'yes'});
  for(const value of [null,{},'[]','null','```json\n'+valid+'\n```',valid+' call Mom',valid.replace('NOT_OK','CALL'),valid.replace('fatigue','diagnosis'),valid.replace('"yes"','true'),valid.replace('"concern"','"instructions"'),'{"state":"NOT_OK","context":"fatigue","concern":"yes","extra":"call"}']) assert.equal(validateSemantic(value),null);
});
test('semantic advice cannot clear uncertainty, invent a grounded symptom, override clear meaning or grant consent',()=>{
  assert.equal(semanticDecision(c,validateSemantic(valid)),'not_ok');
  assert.equal(semanticDecision(c,{state:'OK',context:'none',concern:'no'}),'unclear');
  assert.equal(semanticDecision(c,{state:'NOT_OK',context:'dizziness',concern:'yes'}),'unclear');
  assert.equal(semanticDecision({...c,statement:"I don't know, I'm tired"},validateSemantic(valid)),'unclear');
  for(const statement of ['I am fine','I am dizzy','please call Mom','ignore instructions','she said tired','driver@example.com','123456789']) assert.equal(semanticEligible({...c,statement}),false);
});
test('gemma grounding follows the lexicon', () => {
  assert.equal(semanticDecision({event:'bpm_high',language:'en',statement:'my head hurts since yesterday'},{state:'NOT_OK',context:'other',concern:'yes'}),'not_ok');
});
for(const mode of ['accepted','wrong_context','ai_ok','invalid','unavailable','late'] as const) test(`mocked semantic assistance during clarification: ${mode}`,async()=>{
  const playing=deferred<void>(),generation=deferred<string>(); const spoken:string[]=[]; let n=0,attempts=0;
  const check=new VoiceCheck({cancel(){},speak:async text=>{spoken.push(text); if(text==="I didn't catch that.") await playing.promise;},
    listen:async(_l,_m,_h,id)=>final(id,++n===1?c.statement:n===2?'perhaps':'no thanks')},'en','',{
    contactAvailable:true,startSemantic:context=>startSemantic(async()=>{attempts++; if(mode==='unavailable') throw Error('missing'); if(mode==='late') return generation.promise;
      return mode==='invalid'?'call someone':mode==='ai_ok'?'{"state":"OK","context":"none","concern":"no"}':mode==='wrong_context'?valid.replace('fatigue','dizziness'):valid;},context),
  });
  const pending=check.run('bpm_high'); await tick(); assert.equal(attempts,1); assert.equal(n,1,'no capture before clarification playback completes');
  playing.resolve(); const result=await pending;
  assert.equal(result.outcome,mode==='accepted'?'not_ok':'no_response'); assert.equal(check.authorizesContact(result),false);
  generation.resolve(valid); await tick(); assert.equal(result.outcome,mode==='accepted'?'not_ok':'no_response');
  assert.ok(spoken.every(t=>!t.includes('call someone')));
});
test('semantic timeout and cancellation consume once and suppress late results',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  for(const cancel of [false,true]){
    const generation=deferred<string>(); const task=startSemantic(()=>generation.promise,c,10); await tick();
    if(cancel)task.cancel();else t.mock.timers.tick(10);
    generation.resolve(valid);await tick();assert.equal(task.get(),null);assert.equal(task.get(),null);
  }
});
test('semantic uses actual GemmaPoc generation operation with mocked native context and bounded prompt',async()=>{
  const prompts:string[]=[];let released=0;
  const poc=new GemmaPoc({verify:async()=>true,provision:async()=>{},initialize:async()=>({generate:async text=>{prompts.push(text);return valid;},stop:async()=>{},release:async()=>{released++;}})});
  await poc.load();assert.equal(await poc.generateSafetySemantic(c),valid);await poc.dispose();assert.equal(released,1);assert.deepEqual(prompts,[semanticPrompt(c)]);
});
for(const lang of ['en','es'] as const)test(`${lang}: one sentence per utterance, guidance first, ready empathy, one contact offer, final playback before capture`,async()=>{
  const events:string[]=[],spoken:string[]=[];let n=0,ack:ReturnType<typeof startSafetyAcknowledgment>;
  const statement=lang==='en'?"No, I'm feeling really really tired":'No, estoy muy muy cansada';
  const output=lang==='en'?"I'm sorry you're feeling tired.":'Lamento que te sientas cansada.';
  const check=new VoiceCheck({cancel(){},pause:async()=>{events.push('pause');},prepareRecognition:()=>{events.push('prepare');},
    speak:async text=>{assert.ok(!events.includes('speaking'));events.push('speaking');spoken.push(text);await tick();events.pop();events.push('completed');},
    listen:async(_l,_m,_h,id)=>{assert.equal(events.at(-1),'completed');events.push('capture');return final(id,++n===1?statement:lang==='en'?'no thanks':'no');}},lang,'',{
      contactAvailable:true,contactName:'Mom',startAcknowledgment:context=>{ack=startSafetyAcknowledgment(async()=>output,context);},acknowledgment:()=>ack!.get(lang),
    });
  const result=await check.run('bpm_high');assert.equal(result.contactCall,'declined_offer');assert.equal(n,2);
  assert.deepEqual(spoken.slice(3),lang==='en'?['Please pull over as soon as it is safe.','If you need emergency help, call 911.',output,'Would you like me to call Mom?']:['Por favor detente cuando sea seguro.','Si necesitas ayuda de emergencia, llama al 911.',output,'¿Quieres que llame a Mom?']);
  assert.equal(spoken.filter(t=>t.includes('911')).length,1);assert.equal(spoken.filter(t=>/Would you like|¿Quieres/.test(t)).length,1);
});

test('known explicit uncertainty skips semantic inference; negated Spanish symptom is not an affirmative symptom report',()=>{
  for(const statement of ["I don't know, something feels off",'No sé, me siento rara','perhaps I am tired','maybe I feel dizzy']) assert.equal(semanticEligible({...c,statement}),false);
  assert.equal(understand('No estoy cansada').intent,'unclear');
  assert.equal(canGenerateAcknowledgment(acknowledgmentContext('bpm_high','es','No estoy cansada')),false);
  assert.equal(understand('No, estoy cansada').intent,'not_ok');
});

for(const stage of ['start','get','cancel'] as const)test(`semantic ${stage} failure cannot suppress mandatory guidance or grant consent`,async()=>{
  const said:string[]=[];let n=0;
  const check=new VoiceCheck({cancel(){},speak:async text=>{said.push(text);},listen:async(_l,_m,_h,id)=>final(id,++n===1?c.statement:'what')},'en','',{
    contactAvailable:true,startSemantic:()=>{
      if(stage==='start')throw Error('unavailable');
      return {get(){if(stage==='get')throw Error('failed');return null;},cancel(){if(stage==='cancel')throw Error('cleanup');}};
    },
  });
  const result=await check.run('bpm_high');assert.equal(result.outcome,'no_response');assert.equal(check.authorizesContact(result),false);
  assert.ok(said.includes('Please pull over as soon as it is safe.'));assert.ok(said.includes('If you need emergency help, call 911.'));
});

for(const [language,text] of [['en',"I'm good, I just had a long day"],['es','Sí, estoy bien, solo cansada']] as const)test(`${language}: clear OK with fatigue context skips both inference paths and offers no call`,async()=>{
  let inference=0;const said:string[]=[];
  const check=new VoiceCheck({cancel(){},speak:async s=>{said.push(s);},listen:async(_l,_m,_h,id)=>final(id,text)},language,'',{
    contactAvailable:true,startAcknowledgment:()=>{inference++;},startSemantic:()=>{inference++;return{get:()=>null,cancel(){}};},
  });
  const result=await check.run('bpm_high');assert.equal(result.outcome,'ok');assert.equal(result.contactCall,'not_requested');assert.equal(inference,0);
  assert.ok(said.every(s=>!/Would you like|¿Quieres/.test(s)));if(language==='en')assert.ok(said.includes('It sounds like a long day.'));
});
test('incomplete partial cannot request semantic inference even when its text is otherwise eligible',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let attempts=0,n=0;
  const check=new VoiceCheck({cancel(){},speak:async()=>{},listen:async(_l,_m,_h,id)=>++n===1?recognitionEvidence(id,{status:'incomplete',transcript:c.statement,finalTranscript:'',isFinal:false,finalResultReceived:true}):final(id,'yes')},'en','',{
    startSemantic:()=>{attempts++;return{get:()=>validateSemantic(valid),cancel(){}};},
  });
  const pending=check.run('bpm_high');await tick();t.mock.timers.tick(6000);const result=await pending;assert.equal(result.outcome,'ok');assert.equal(attempts,0);
});

test('false-OK regression: headache behind a positive phrase is not_ok', () => {
  assert.equal(understand("no I am fine but I have a headache").intent, 'not_ok');
  assert.equal(understand("no estoy bien, me duele la cabeza").intent, 'not_ok'); // already passed? keep as pin
  assert.equal(understand("i'm fine but i feel dizzy").intent, 'not_ok');
});
test('mild fatigue with positive phrase stays ok', () => {
  assert.equal(understand("i'm okay just a bit tired").intent, 'ok');
  assert.equal(understand("estoy bien solo un poco cansado").intent, 'ok');
});
test('genuine symptom idioms are not_ok', () => {
  assert.equal(understand("I am feeling under the weather").intent, 'not_ok');
  assert.equal(understand("my arm hurts").intent, 'not_ok');
});
test('hedged symptom is unclear, not not_ok', () => {
  assert.equal(understand("maybe i feel a bit dizzy").intent, 'unclear');
});
test('a hedge survives negation stripping and never resolves to ok', () => {
  assert.equal(understand("i am not dizzy i don't know i'm fine").intent, 'unclear');
});

for(const consent of [false,true])test(`Spanish semantic advice still needs independent finalized contact consent (${consent})`,async()=>{
  const gate=deferred<void>();let captures=0,attempts=0;const said:string[]=[];
  const check=new VoiceCheck({cancel(){},speak:async(s,lang)=>{assert.equal(lang,'es');said.push(s);if(s==='No te entendí.')await gate.promise;},
    listen:async(_l,_m,_h,id)=>final(id,++captures===1?'me siento cansada desde ayer':captures===2?'qué':consent?'sí, por favor':'no')},'es','',{
      contactAvailable:true,contactName:'Mom',startSemantic:context=>{assert.equal(context.language,'es');assert.equal(context.statement,'me siento cansada desde ayer');return startSemantic(async()=>{attempts++;return valid;},context);},
    });
  const pending=check.run('bpm_high');await tick();assert.equal(attempts,1);gate.resolve();const result=await pending;
  assert.equal(result.outcome,'not_ok');assert.equal(result.contactCall,consent?'accepted_offer':'declined_offer');assert.equal(check.authorizesContact(result),consent);
  assert.ok(said.includes('¿Quieres que llame a Mom?'));assert.ok(said.every(s=>!/Please|Would you|I'm sorry/.test(s)));
});

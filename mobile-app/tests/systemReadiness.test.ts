import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { sensorReadiness, recognitionReadiness, systemReadiness, type ReadinessSnapshot } from '../lib/assistant/systemReadiness.ts';
import { translateText } from '../lib/i18n/translate.ts';

const speech = { locale: 'en-US', supportsOnDeviceRecognition: true, recognizerAvailable: true,
  reason: 'supported', message: '', speechPermission: 'authorized', microphonePermission: 'granted' };
const snapshot = (): ReadinessSnapshot => ({ speech: { ...speech }, installedLocales: ['en-US'], responses: 'available', foreground: true });
for (const [connection, status] of [['idle','Not connected'],['scanning','Connecting'],['connecting','Connecting'],['discovering','Connecting'],['waiting','Connecting'],['disconnected','Not connected'],['failed','Connection unavailable'],['connected','Connected']] as const) {
  test(`sensor transport ${connection} uses connectivity, not readings or simulation`, () => {
    assert.equal(sensorReadiness({ connection, source: 'esp32', hasDriver: true }).status, status);
  });
}
test('relay transport is not itself proof of a steering-wheel connection', () => {
  const input = { connection: 'connected', source: 'relay' as const, hasDriver: true };
  assert.equal(sensorReadiness(input).status, 'Connection not verified');
  assert.equal(sensorReadiness({ ...input, relayConnected: false }).status, 'Not connected');
  assert.equal(sensorReadiness({ ...input, relayConnected: true }).status, 'Connected');
  assert.equal(sensorReadiness({ ...input, connection: 'disconnected', relayConnected: true }).status, 'Not connected');
  assert.equal(sensorReadiness({ hasDriver: true }).status, 'Connection not verified');
});
for(const patch of [{speechPermission:'notDetermined'},{speechPermission:'denied'},{microphonePermission:'undetermined'},{microphonePermission:'denied'}])test(`recognition permission is explicit: ${JSON.stringify(patch)}`,()=>{
  assert.equal(recognitionReadiness({...snapshot(),speech:{...speech,...patch}},'en').status,'Permission required');
});
test('recognition and voice output are independent; assets/permissions/locale must agree',()=>{
  assert.equal(recognitionReadiness(snapshot(),'en').status,'Available');
  for(const patch of [{speech:null},{installedLocales:[]},{speech:{...speech,locale:'es-US'}},{speech:{...speech,speechPermission:'unknown'}},{foreground:false}])
    assert.equal(recognitionReadiness({...snapshot(),...patch},'en').status,'Checked when a safety check starts');
  assert.equal(recognitionReadiness({...snapshot(),speech:{...speech,recognizerAvailable:false}},'en').status,'Unavailable');
  const es={...speech,locale:'es-US',engine:'speech_transcriber' as const,installedLocale:true,assetStatus:'installed'};
  assert.equal(recognitionReadiness({...snapshot(),speech:es},'es').status,'Available');
  assert.equal(recognitionReadiness({...snapshot(),speech:{...es,installedLocale:false}},'es').status,'Checked when a safety check starts');
  assert.equal(recognitionReadiness({...snapshot(),speech:{...es,engine:undefined}},'es').status,'Checked when a safety check starts');
});
for(const responses of ['checking','available','unavailable','unknown'] as const)test(`TTS status ${responses} is not microphone readiness`,()=>{
  const r=systemReadiness({hasDriver:true,connection:'connected',source:'esp32',monitoring:'active'},{...snapshot(),speech:null,responses},'en');
  assert.equal(r.items.find(row=>row.id==='responses')?.status,responses==='available'?'Available':responses==='unavailable'?'Unavailable':'Checked when a safety check starts');
  assert.equal(r.items.find(row=>row.id==='recognition')?.status,'Checked when a safety check starts');
  assert.equal(r.items.find(row=>row.id==='manual')?.status,'Available');
});
test('overall readiness follows disconnection, reconnection and fresh monitoring, not optional AI/voice',()=>{
  const s={...snapshot(),responses:'unavailable' as const,speech:null};
  const input={hasDriver:true,source:'esp32' as const,monitoring:'active'};
  assert.equal(systemReadiness({...input,connection:'disconnected'},s,'en').overall,'Sensor connection needed');
  assert.equal(systemReadiness({...input,connection:'connecting'},s,'en').overall,'Connecting sensors');
  assert.equal(systemReadiness({...input,connection:'connected',monitoring:'waiting'},s,'en').overall,'Awaiting valid readings');
  assert.equal(systemReadiness({...input,connection:'connected'},s,'en').overall,'Safety checks available');
  assert.equal(systemReadiness({...input,connection:'connected',monitoring:'unavailable'},s,'en').overall,'Safety monitoring unavailable');
  assert.equal(systemReadiness({...input,hasDriver:false},s,'en').overall,'Select a driver');
});

test('readiness labels and introductory copy have Spanish translations',()=>{
  const labels=new Set<string>(['Meet Sensi','System Readiness','Try Sensi','Your driving safety companion.',"I'm here to help keep you safe. If DriveSense detects unusual health readings while you're driving, I'll check in to see how you're feeling.",'Experience a simulated safety check.','Permission required','Connection not verified','Connection unavailable','Awaiting valid readings','Safety checks available']);
  for(const responses of ['checking','available','unavailable','unknown'] as const){
    const r=systemReadiness({hasDriver:true,connection:'disconnected'},{...snapshot(),responses},'en');
    labels.add(r.overall);for(const row of r.items){labels.add(row.label);labels.add(row.status);if(row.detail)labels.add(row.detail);}
  }
  for(const label of labels)assert.notEqual(translateText(label,'es'),label,label);
});

const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
function observer(language:'en'|'es'='en') {
  let value:any;let effect!:()=>void|(()=>void);let appChanged:(state:string)=>void=()=>{};
  const calls:string[]=[];const app={currentState:'active',addEventListener:(_name:string,fn:typeof appChanged)=>{appChanged=fn;return{remove(){calls.push('remove app')}}}};
  let preferred:string|null=null,voices=[{id:'installed'}];let pending:Promise<any>|null=null;
  const forbidden=()=>{throw Error('Readiness attempted a lifecycle/action operation');};
  const dependencies:Record<string,any>={
    react:{useState:(initial:any)=>{if(value===undefined)value=typeof initial==='function'?initial():initial;return[value,(update:any)=>{value=typeof update==='function'?update(value):update}]},useEffect:(fn:typeof effect)=>{effect=fn}},
    'react-native':{AppState:app},
    '../../modules/local-foundation-models':{checkOfflineSpeechCapability:async(locale:string)=>{calls.push('speech:'+locale);return pending??{...speech,locale,...(locale==='es-US'?{engine:'speech_transcriber',installedLocale:true,assetStatus:'installed'}:{})}},listenOffline:forbidden,prepareOfflineRecognition:forbidden},
    '../voice/speechIO':{listVoices:async(lang:string)=>{calls.push('voices:'+lang);return voices},onDeviceLanguages:async()=>{calls.push('locales');return['en-US']},prepareVoice:forbidden},
    '../db/repositories':{getSetting:async(key:string)=>{calls.push(key);return preferred},setSetting:forbidden},
  };
  const source=readFileSync(new NodeURL('../lib/assistant/useSystemReadiness.ts',import.meta.url),'utf8');const exports:any={};
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:(name:string)=>{assert.ok(name in dependencies,name);return dependencies[name]}});
  return {calls,render:(selected: 'en' | 'es' = language)=>exports.useSystemReadiness(true,selected) as ReadinessSnapshot,mount:()=>effect() as ()=>void,
    background:()=>{app.currentState='background';appChanged('background')},foreground:()=>{app.currentState='active';appChanged('active')},
    savedVoice:(id:string)=>{preferred=id},emptyVoices:()=>{voices=[]},
    pending:(promise:Promise<any>)=>{pending=promise},state:()=>value as ReadinessSnapshot};
}
for(const lang of ['en','es'] as const)test(`passive ${lang} observation subscribes without initialization, inference, downloads or capture`,async()=>{
  const f=observer(lang);f.render();assert.equal(f.calls.length,0,'render cannot perform I/O');const cleanup=f.mount();await tick();
  assert.ok(f.calls.includes('speech:'+(lang==='es'?'es-US':'en-US')));assert.ok(f.calls.includes('voices:'+lang));assert.ok(f.calls.includes('voice:'+lang));
  assert.equal(f.state().responses,'available');assert.equal(recognitionReadiness(f.state(),lang).status,'Available');
  const before=f.calls.length;f.render();await tick();assert.equal(f.calls.length,before,'no polling on repeated render');
  f.background();assert.equal(f.state().speech,null);assert.equal(f.state().foreground,false);
  f.foreground();await tick();assert.equal(f.state().foreground,true);cleanup();assert.ok(f.calls.includes('remove app'));
});
test('voice responses require a present selected voice; permission information cannot substitute for TTS inventory',async()=>{
  const f=observer();f.savedVoice('removed-voice');f.render();const cleanup=f.mount();await tick();assert.equal(f.state().responses,'unavailable');cleanup();
  const empty=observer();empty.emptyVoices();empty.render();const stop=empty.mount();await tick();assert.equal(empty.state().responses,'unavailable');stop();
});
test('late native inventory cannot publish after backgrounding, replacement or unmount',async()=>{
  let resolve!:(v:unknown)=>void;const f=observer();f.pending(new Promise(r=>{resolve=r}));f.render();const cleanup=f.mount();
  f.background();resolve(speech);await tick();assert.equal(f.state().speech,null);cleanup();const before=f.state();f.foreground();await tick();assert.equal(f.state(),before);
});


test('changing the driver language immediately masks prior-language inventory', async () => {
  const f=observer();f.render();const cleanup=f.mount();await tick();assert.equal(f.render().responses,'available');
  const pending=f.render('es');assert.equal(pending.responses,'checking');assert.equal(pending.speech,null);
  cleanup();const next=f.mount();await tick();assert.equal(f.render('es').responses,'available');assert.equal(f.render('es').speech?.locale,'es-US');next();
});

test('compact home copy and model label preserve Spanish localization', () => {
  assert.equal(translateText('Downloaded · Unverified','es'),'Descargado · Sin verificar');
  assert.equal(translateText("If DriveSense detects unusual health readings, I'll check in to see how you're feeling.",'es'),'Si DriveSense detecta lecturas de salud inusuales, te preguntaré cómo te sientes.');
  assert.equal(translateText('Simulated safety check · No live emergency actions','es'),'Revisión de seguridad simulada · Sin acciones de emergencia reales');
});

test('active readiness exposes sensor, voice and manual readiness only', () => {
  const result = systemReadiness({ hasDriver: true, connection: 'connected', source: 'esp32', monitoring: 'active' }, snapshot(), 'en');
  assert.deepEqual(result.items.map(item => item.id), ['sensors', 'recognition', 'responses', 'manual']);
  assert.doesNotMatch(JSON.stringify(result), /Gemma|model|installation/i);
});

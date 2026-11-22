import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { light, dark } from '../lib/theme/tokens.ts';
import { SENSI_PROVIDERS } from '../lib/assistant/sensiPreferences.ts';
import * as presentation from '../lib/ui/sensiPresentation.ts';
import { settingsSwitchColors } from '../lib/ui/settingsSwitch.ts';
const require = createRequire(import.meta.url);
const read = (name: string) => readFileSync(new NodeURL('../'+name, import.meta.url), 'utf8');
function renderer(file: string, theme = light, extra: Record<string, any> = {}, development = false) {
  const values: any[] = [], effects: { deps: unknown[]; cleanup?: () => void }[] = [];
  let index = 0, pending: (() => void)[] = [];
  const deps: Record<string, any> = {
    react: {
      useState(initial: any) { const id=index++; if (!(id in values)) values[id]=typeof initial==='function'?initial():initial;
        return [values[id],(v:any)=>{values[id]=typeof v==='function'?v(values[id]):v;}]; },
      useRef(initial: any) { const id=index++; return values[id]??=( {current:initial} ); },
      useEffect(fn: () => any, inputs: unknown[] = []) { const id=index++; const previous=effects[id];
        if (!previous || inputs.some((v,i)=>v!==previous.deps[i])) pending.push(()=>{previous?.cleanup?.(); effects[id]={deps:inputs,cleanup:fn()};}); },
    },
    'react/jsx-runtime':require('react/jsx-runtime'),
    'react-native':{...Object.fromEntries(['Switch','View','Modal','ScrollView','ActivityIndicator'].map(n=>[n,n])), StyleSheet:{hairlineWidth:1}, AppState:{addEventListener:()=>({remove(){}})}},
    '../lib/i18n/native':{LocalizedText:'Text',LocalizedTextInput:'TextInput'},
    '../lib/theme/ThemeProvider':{useTheme:()=>({tokens:theme})},
    '../lib/ui/sensiPresentation':presentation, '../lib/ui/settingsSwitch':{settingsSwitchColors},
    '../lib/assistant/sensiPreferences':{SENSI_PROVIDERS},
    './SettingsGroup': { SettingsGroup: 'SettingsGroup', SettingsRow: 'SettingsRow', SettingsNote: 'SettingsNote' },
    './ui':Object.fromEntries(['Btn','Card','Row','SectionTitle'].map(n=>[n,n])),
    './Information':{InformationButton:'InformationButton'}, './CloudPrivacyInfo':{CloudPrivacyInfo:'CloudPrivacyInfo'},
    './SimulationProgress':{SimulationProgress:'SimulationProgress'}, ...extra,
  };
  const exports:any={};
  new Function('require','exports','__DEV__',ts.transpileModule(read(file),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText)(
    (name:string)=>{assert.ok(name in deps,name);return deps[name];},exports,development);
  return { render(name:string,props:any) { index=0;pending=[];const tree=exports[name](props);pending.forEach(f=>f());return tree; } };
}
function nodes(n:any):any[] {
  if (!n || typeof n!=='object') return [];
  if (Array.isArray(n)) return n.flatMap(nodes);
  if ((n.type==='Modal'&&!n.props.visible)||n.props?.style?.display==='none') return [n];
  return [n,...nodes(n.props?.children),...nodes(n.props?.right),...nodes(n.props?.trailing)];
}
for (const theme of [light,dark]) {
  test(`${theme===dark?'dark':'light'} signed-in account hides credentials and preserves immediate sign-out while blocked`,async()=>{
    const calls:string[]=[];
    const r=renderer('components/SensiCloudAccess.tsx',theme,{'../lib/assistant/phoneCloudAuth':{sensiCloudAuth:{state:{status:'signed_in'},subscribe:()=>()=>{},cachedCredential:()=>({userId:'test-account-id'}),signOut:async()=>{calls.push('out');return true;}}}});
    const n=nodes(r.render('SensiCloudAccess',{blocked:true,state:{status:'signed_in'}}));
    assert.equal(n.some(v=>v.type==='TextInput'),false); assert.equal(n.some(v=>v.props?.title==='Sign In'),false);
    assert.equal(n.some(v=>JSON.stringify(v.props).includes('test-acc')),false);
    assert.ok(n.some(v=>v.props?.subtitle==='Connected account'));
    const out=n.find(v=>v.props?.title==='Sign Out');assert.ok(out);assert.notEqual(out.props.disabled,true);out.props.onPress();await Promise.resolve();assert.deepEqual(calls,['out']);
    for(const text of n.filter(v=>v.type==='Text'))assert.ok(text.props.style.color);
  });
  test(`${theme===dark?'dark':'light'} signed-out form has themed text and placeholders`,()=>{
    const r=renderer('components/SensiCloudAccess.tsx',theme,{'../lib/assistant/phoneCloudAuth':{sensiCloudAuth:{state:{status:'signed_out'},subscribe:()=>()=>{}}}});
    const n=nodes(r.render('SensiCloudAccess',{blocked:false,state:{status:'signed_out'}}));assert.equal(n.filter(v=>v.type==='TextInput').length,2);
    for(const input of n.filter(v=>v.type==='TextInput')){assert.equal(Object.assign({}, ...[input.props.style].flat()).color,theme.text);assert.equal(input.props.placeholderTextColor,theme.textMuted);}
  });

}
test('consent summary discloses sensitive text and retention before opt-in; full information stays available',()=>{
  assert.match(presentation.CLOUD_PRIVACY_SUMMARY,/240 characters/);assert.match(presentation.CLOUD_PRIVACY_SUMMARY,/sensitive information/);assert.match(presentation.CLOUD_PRIVACY_SUMMARY,/zero retention is not promised/);
  assert.match(presentation.CLOUD_PRIVACY_DETAILS,/Audio, readings, profile\/contact data and conversation history are not included/);
  assert.match(presentation.CLOUD_PRIVACY_DETAILS,/cannot authorize calls/);assert.match(presentation.CLOUD_PRIVACY_DETAILS,/cannot recall text already transmitted/);
  const r=renderer('components/CloudPrivacyInfo.tsx');const n=nodes(r.render('CloudPrivacyInfo',{}));
  assert.ok(n.some(v=>v.props?.children===presentation.CLOUD_PRIVACY_SUMMARY));
  const info=n.find(v=>v.type==='InformationButton');assert.equal(info.props.body,presentation.CLOUD_PRIVACY_DETAILS);assert.equal(info.props.compact,true);
});
test('consent revocation stays available while blocked and never follows mode selection automatically',async()=>{
  const writes:any[]=[];const state={loaded:true,preference:'openai',driverId:'a',accountId:'verified-fixture-account',consent:true};
  const r=renderer('components/SensiProviderSettings.tsx',dark,{
    './GemmaModelSettings':{GemmaModelSettings:'GemmaModelSettings'}, './SensiCloudAccess':{SensiCloudAccess:'SensiCloudAccess',useSensiAccount:()=>({status:'signed_in'})},
    '../lib/assistant/phoneSensiRouting':{sensiPreferences:{state,subscribe:()=>()=>{},boot:async()=>{},selectDriver:async()=>{},saveConsent:async(...args:any[])=>writes.push(args)},isGemmaPreparing:()=>false,isGemmaExplicitlyStopped:()=>false,subscribeGemmaPreparation:()=>()=>{},stopPreparedGemma(){throw Error('unexpected');}},
    '../modules/gemma-poc/phone':{gemmaPoc:{state:{},subscribe:()=>()=>{}},isGemmaAcknowledgmentReady:()=>false},
  });
  const n=nodes(r.render('SensiProviderSettings',{page:'sensi_cloud',driverId:'a',blocked:true}));assert.equal(writes.length,0);
  const consent=n.find(v=>v.type==='Switch');assert.equal(consent.props.disabled,false);consent.props.onValueChange(false);await Promise.resolve();assert.deepEqual(writes,[['a',false]]);
  const modes=nodes(r.render('SensiProviderSettings',{page:'sensi_mode',driverId:'a',blocked:false}));
  assert.equal(modes.some(v=>v.type==='Switch'),false);
  const info=modes.find(v=>v.type==='InformationButton');
  for(const option of SENSI_PROVIDERS)assert.ok(modes.some(v=>v.props?.title===option.label));
  for(const description of Object.values(presentation.RESPONSE_MODE_DESCRIPTIONS))assert.ok(info.props.body.includes(description));
  const switched=nodes(r.render('SensiProviderSettings',{page:'sensi_cloud',driverId:'b',blocked:false}));
  assert.equal(switched.find(v=>v.type==='Switch').props.disabled,true);
  assert.equal(switched.some(v=>v.props?.subtitle==='On for this driver'),false);
});
test('diagnostic expansion preserves evidence and untested status never becomes PASS',()=>{
  const r=renderer('components/DiagnosticUI.tsx',dark);let n=nodes(r.render('DiagnosticDetails',{children:'raw evidence'}));
  assert.equal(n.some(v=>v.props?.children==='raw evidence'&&v.props.style?.display!=='none'),false);
  n.find(v=>v.type==='SettingsRow').props.onPress();n=nodes(r.render('DiagnosticDetails',{children:'raw evidence'}));
  assert.ok(n.some(v=>v.props?.children==='raw evidence'));assert.equal(n.find(v=>v.type==='SettingsRow').props.expanded,true);
  const result=nodes(r.render('DiagnosticResult',{title:'Integrity',status:'NOT TESTED'}));assert.ok(result.some(v=>v.props?.children==='Not Tested'));assert.equal(result.some(v=>v.props?.children==='Passed'),false);
});
test('provider labels are absent from the conversation in Debug and Release',()=>{
  for(const [source,label] of [['openai','OpenAI'],['gemma','On-device Gemma'],['fallback','Basic Offline'],['openai-preferred','Unknown'],[undefined,'Unknown']])assert.equal(presentation.acknowledgmentProviderLabel(source),label);
  const messages=[
    {id:'1',role:'assistant',text:'Mandatory guidance'},
    ...['openai', 'gemma', 'fallback', 'unknown'].map(source => ({id:source,role:'assistant',text:'Acknowledgment',acknowledgmentSource:source})),
    {id:'driver',role:'driver',text:'Driver response',acknowledgmentSource:'gemma'},
  ];
  for(const dev of [false,true]){
    const r=renderer('components/SensiConversationThread.tsx',dark,{
      '../lib/assistant/threadPresentation':{nearThreadBottom:()=>true,playbackLabel:()=>undefined},
    },dev);
    const n=nodes(r.render('SensiConversationThread',{messages,provisional:''}));
    const labels = n.filter(v => v.type === 'Text' && v.props.children?.[0] === 'Acknowledgment provider: ')
      .map(v => v.props.children[1].props.children);
    assert.deepEqual(labels, []);
  }
});

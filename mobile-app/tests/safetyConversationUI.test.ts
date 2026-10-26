import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import ts from 'typescript';
import { light } from '../lib/theme/tokens.ts';
import { safetyButtonText, simulationCompletion } from '../lib/assistant/safetyConversation.ts';
import { contactHandoffMessage } from '../modules/local-foundation-models/conversationPolicy.ts';
const require=createRequire(import.meta.url);
function harness() {
  const source=readFileSync(new NodeURL('../components/SensiSafetyConversation.tsx',import.meta.url),'utf8');
  const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
  const exports:any={};
  const deps:Record<string,unknown>={
    react:{useRef:()=>({current:false}),useState:()=>[false,()=>{}],useEffect:(fn:()=>void)=>fn()},
    'react/jsx-runtime':require('react/jsx-runtime'),
    'react-native':{Platform:{OS:'ios'},KeyboardAvoidingView:'KeyboardAvoidingView',Modal:'Modal',SafeAreaView:'SafeAreaView',Text:'Text',View:'View'},
    '../lib/assistant/safetyConversation':{safetyButtonText,simulationCompletion},
    '../modules/local-foundation-models/conversationPolicy':{contactHandoffMessage},
    '../lib/theme/ThemeProvider':{useTheme:()=>({tokens:light})},
    './SafetyTypedResponse':{SafetyTypedResponse:'TypedResponse'},
    './SensiConversationThread':{SensiConversationThread:'Thread'},'./ui':{Btn:'Btn'},
  };
  new Function('require','exports','__DEV__',compiled)((name:string)=>{assert.ok(name in deps,name);return deps[name];},exports,false);
  return exports.SensiSafetyConversation;
}
test('standby and active safety use one modal host and navigation does not change a check', () => {
  const render = harness(); let closed = 0;
  const standby = render({ drive: { safety: { conversation: null, check: null } }, standby: 'standby sentinel',
    onStandbyClose: () => { closed++; }, onContinue() {} });
  assert.equal(standby.type, 'Modal'); assert.equal(standby.props.children, 'standby sentinel');
  standby.props.onRequestClose(); assert.equal(closed, 1);
  const messages = [{ id: 'prompt', role: 'assistant', text: 'Are you feeling okay?' }];
  const check = Object.freeze({ episode: { id: 'episode' }, captureId: 'capture', question: 'wellness', phase: 'listening' });
  const active = render({ drive: { safety: { conversation: { episodeId: 'episode', mode: 'local', messages, finished: false }, check } },
    standby: 'standby sentinel', onStandbyClose: () => { closed++; }, onContinue() {} });
  assert.equal(active.type, standby.type);
  active.props.onRequestClose(); assert.equal(closed, 1, 'active safety cannot be dismissed by standby navigation');
  const walk = (node: any): any[] => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(walk) : [node, ...walk(node.props?.children)];
  const thread = walk(active).find(node => node.type === 'Thread');
  assert.equal(thread.props.messages, messages); assert.equal(check.captureId, 'capture');
});
test('Sensi safety choices reuse wellness/offer handlers and lock duplicate taps without parsing model prose',()=>{
  const render=harness();
  for(const [question,yes,no] of [['wellness','ok','not_ok'],['contact_offer','call_yes','call_no']]){
    const calls:string[]=[];
    const tree=render({drive:{safety:{conversation:{episodeId:'episode',mode:'connected',messages:[],finished:false},check:{episode:{id:'episode'},question,phase:'listening'}},
      respondAlert:(answer:string)=>calls.push(answer)},onContinue:()=>{throw Error('unexpected continuation');}});
    const nodes:any[]=[];const visit=(n:any)=>{if(!n||typeof n!=='object')return;if(Array.isArray(n)){n.forEach(visit);return;}nodes.push(n);visit(n.props?.children);};visit(tree);
    const buttons=nodes.filter(n=>n.type==='Btn');assert.equal(buttons.length,2);
    assert.equal(buttons[0].props.title,safetyButtonText(question as 'wellness'|'contact_offer',true));
    buttons[0].props.onPress();buttons[0].props.onPress();buttons[1].props.onPress();assert.deepEqual(calls,[yes]);
    assert.notEqual(yes,no);
  }
});
test('completed unwell workflow exposes Close but no automatic or unapproved continuation',()=>{
  const render=harness();let dismissed=0;
  const tree=render({drive:{safety:{conversation:{episodeId:'episode',mode:'local',messages:[],finished:true},check:null,
    last:{episode:{id:'episode'},result:{outcome:'not_ok'}}},canContinueSafetyConversation:()=>false,dismissSafetyConversation:()=>{dismissed++;}},
    onContinue:()=>{throw Error('unexpected continuation');}});
  const nodes:any[]=[];const visit=(n:any)=>{if(!n||typeof n!=='object')return;if(Array.isArray(n)){n.forEach(visit);return;}nodes.push(n);visit(n.props?.children);};visit(tree);
  const buttons=nodes.filter(n=>n.type==='Btn');assert.deepEqual(buttons.map(n=>n.props.title),['Close safety check']);
  buttons[0].props.onPress();assert.equal(dismissed,1);
});

test('completed simulated consent and refusal display simulation results without call actions', () => {
  const render = harness();
  for (const contactCall of ['accepted_offer', 'declined_offer'] as const) {
    const result = { outcome: 'not_ok', contactCall };
    const tree = render({ drive: { safety: {
      conversation: { episodeId: 'rehearsal', mode: 'gemma', simulation: true, messages: [], finished: true },
      check: null, last: { episode: { id: 'rehearsal' }, simulation: true, result },
    }, canContinueSafetyConversation: () => false }, onContinue() { throw Error('Unexpected continuation'); } });
    const nodes: any[] = [];
    const visit = (n: any) => { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) { n.forEach(visit); return; } nodes.push(n); visit(n.props?.children); };
    visit(tree);
    assert.ok(nodes.some(n => n.type === 'Text' && n.props.children === simulationCompletion(result as any)));
    assert.deepEqual(nodes.filter(n => n.type === 'Btn').map(n => n.props.title), ['Close safety check']);
  }
});

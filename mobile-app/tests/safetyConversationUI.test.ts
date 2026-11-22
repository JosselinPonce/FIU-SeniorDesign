import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import ts from 'typescript';
import { acknowledgmentProviderLabel, RESPONSE_MODE_SUMMARIES } from '../lib/ui/sensiPresentation.ts';
import type { SensiPreference } from '../lib/assistant/sensiPreferences.ts';
import type { ConversationMessage } from '../modules/local-foundation-models/assistantConversation.ts';
import { translateText } from '../lib/i18n/translate.ts';
import { light } from '../lib/theme/tokens.ts';
import { safetyButtonText, simulationCompletion } from '../lib/assistant/safetyConversation.ts';
import { contactHandoffMessage } from '../modules/local-foundation-models/conversationPolicy.ts';
const require=createRequire(import.meta.url);
function harness(height = 844, development = false, preference?: SensiPreference, fontScale = 1, width = 390) {
  const preferences = { state: { loaded: preference !== undefined, preference: preference ?? 'gemma' },
    subscribe: () => () => {} };
  const deps:Record<string,unknown>={
    '../lib/i18n/LanguageProvider': { VoiceCheckLanguageScope: 'LanguageScope' },
    './ScreenHeader': { ScreenHeader: 'ScreenHeader' },
    '../lib/ui/profileSummary': { driverInitials: (name: string) => name[0] },
    '../lib/analysis/safetyController': { contactPhone: (phone?: string) => ({phone: phone || null}) },
    './RealContactDemoConfirmation': { RealContactDemoConfirmation: 'RealContactDemoConfirmation' },
    '../lib/voice/responsivenessDiagnostics':{traceVoiceCheckUI:()=>{}, responsivenessProbe: () => () => {}},
    '../lib/i18n/native':{LocalizedText:'Text'},
    '../lib/assistant/phoneSensiRouting': { sensiPreferences: preferences },
    '../lib/ui/sensiPresentation': { acknowledgmentProviderLabel, RESPONSE_MODE_SUMMARIES },
    'expo/node_modules/@expo/vector-icons/Feather': { default: 'Feather' },
    react:{useSyncExternalStore: (_: unknown, read: () => string) => read(), useRef:()=>({current:false}),useState:()=>[false,()=>{}],useEffect:(fn:()=>void)=>fn()},
    'react/jsx-runtime':require('react/jsx-runtime'),
    'react-native':{ScrollView:'ScrollView',useWindowDimensions:()=>({width,height,fontScale}),Platform:{OS:'ios'},KeyboardAvoidingView:'KeyboardAvoidingView',Modal:'Modal',SafeAreaView:'SafeAreaView',Text:'Text',View:'View'},
    '../lib/assistant/safetyConversation':{safetyButtonText,simulationCompletion},
    '../modules/local-foundation-models/conversationPolicy':{contactHandoffMessage},
    '../lib/theme/ThemeProvider':{useTheme:()=>({tokens:light})},
    './EmergencyDialerDemo': { EmergencyDialerDemo: 'EmergencyDialerDemo' },
    './SafetyTypedResponse':{SafetyTypedResponse:'TypedResponse'},
    '../lib/voice/basicOfflineAcknowledgment': { VOICECHECK_BASIC_OFFLINE: true },
    './LiveSensiProvider': { LiveSensiProvider: 'LiveSensiProvider', BasicOfflineStatus: 'BasicOfflineStatus' },
    './SensiConversationThread':{SensiConversationThread:'Thread'},'./ui':{Btn:'Btn'},
  };
  function load(component: string) {
    const source = readFileSync(new NodeURL(`../components/${component}.tsx`, import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022,
    } }).outputText;
    const exports: any = {};
    new Function('require', 'exports', '__DEV__', compiled)((name: string) => {
      if (name === './VoiceCheckListeningIndicator') return load('VoiceCheckListeningIndicator');
      assert.ok(name in deps, name);
      return deps[name];
    }, exports, development);
    return exports;
  }
  return { render: load('SensiSafetyConversation').SensiSafetyConversation, provider: load('VoiceCheckProviderStatus').VoiceCheckProviderStatus };
}
test('standby and active safety use one modal host and navigation does not change a check', () => {
  const { render } = harness(); let closed = 0;
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
  const walk = (node: any): any[] => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(walk) : [node, ...walk(node.props?.children), ...walk(node.props?.footer)];
  const thread = walk(active).find(node => node.type === 'Thread');
  assert.equal(thread.props.messages, messages); assert.equal(check.captureId, 'capture');
});
test('Sensi safety choices reuse wellness/offer handlers and lock duplicate taps without parsing model prose',()=>{
  const { render }=harness();
  for(const [question,yes,no] of [['wellness','ok','not_ok'],['contact_offer','call_yes','call_no']]){
    const calls:string[]=[];
    const tree=render({drive:{safety:{conversation:{episodeId:'episode',mode:'connected',messages:[],finished:false},check:{episode:{id:'episode'},question,phase:'listening'}},
      respondAlert:(answer:string)=>calls.push(answer)},onContinue:()=>{throw Error('unexpected continuation');}});
    const nodes:any[]=[];const visit=(n:any)=>{if(!n||typeof n!=='object')return;if(Array.isArray(n)){n.forEach(visit);return;}nodes.push(n);visit(n.props?.children);visit(n.props?.footer);};visit(tree);
    const buttons=nodes.filter(n=>n.type==='Btn');assert.equal(buttons.length,2);
    assert.equal(buttons[0].props.title,safetyButtonText(question as 'wellness'|'contact_offer',true));
    buttons[0].props.onPress();buttons[0].props.onPress();buttons[1].props.onPress();assert.deepEqual(calls,[yes]);
    assert.notEqual(yes,no);
  }
});
test('completed unwell workflow exposes Close but no automatic or unapproved continuation',()=>{
  const { render }=harness();let dismissed=0;
  const tree=render({drive:{safety:{conversation:{episodeId:'episode',mode:'local',messages:[],finished:true},check:null,
    last:{episode:{id:'episode'},result:{outcome:'not_ok'}}},canContinueSafetyConversation:()=>false,dismissSafetyConversation:()=>{dismissed++;}},
    onContinue:()=>{throw Error('unexpected continuation');}});
  const nodes:any[]=[];const visit=(n:any)=>{if(!n||typeof n!=='object')return;if(Array.isArray(n)){n.forEach(visit);return;}nodes.push(n);visit(n.props?.children);visit(n.props?.footer);};visit(tree);
  const buttons=nodes.filter(n=>n.type==='Btn');assert.deepEqual(buttons.map(n=>n.props.title),['Close safety check']);
  buttons[0].props.onPress();assert.equal(dismissed,1);
});

test('completed simulated consent offers only a separate demo; refusal offers no handoff', () => {
  const { render } = harness();
  for (const contactCall of ['accepted_offer', 'declined_offer'] as const) {
    const result = { outcome: 'not_ok', contactCall };
    const tree = render({ drive: { safety: {
      conversation: { episodeId: 'rehearsal', mode: 'gemma', simulation: true, messages: [{ id: 'status', role: 'system', text: simulationCompletion(result as any) }], finished: true },
      check: null, last: { episode: { id: 'rehearsal' }, simulation: true, result },
    }, canContinueSafetyConversation: () => false }, onContinue() { throw Error('Unexpected continuation'); } });
    const nodes: any[] = [];
    const visit = (n: any) => { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) { n.forEach(visit); return; } nodes.push(n); visit(n.props?.children);visit(n.props?.footer); };
    visit(tree);
    assert.equal(nodes.filter(n => n.type === 'Text' && Array.isArray(n.props.children) && n.props.children.includes(simulationCompletion(result as any))).length, 1);
    assert.deepEqual(nodes.find(n => n.type === 'Thread').props.messages, []);
    assert.equal(nodes.some(n => n.type === 'EmergencyDialerDemo'), false);
    assert.deepEqual(nodes.filter(n => n.type === 'Btn').map(n => n.props.title), ['Close safety check']);
  }
});

test('live consent never exposes the fictional dialer demo', () => {
  const { render } = harness();
  const tree = render({ drive: { safety: { conversation: { episodeId: 'live', messages: [], finished: true, simulation: false }, check: null,
    last: { episode: { id: 'live' }, simulation: false, result: { outcome: 'not_ok', contactCall: 'accepted_offer' } } } }, onContinue() {} });
  const walk = (n: any): any[] => !n || typeof n !== 'object' ? [] : Array.isArray(n) ? n.flatMap(walk) : [n, ...walk(n.props?.children), ...walk(n.props?.footer)];
  assert.equal(walk(tree).some(n => n.type === 'EmergencyDialerDemo'), false);
});

test('response composer is outside transcript scrolling and remains bounded with keyboard avoidance', () => {
  const { render } = harness();
  const tree = render({ drive: { safety: { conversation: { episodeId:'e', messages:[], simulation:true, realContactDemo:true, finished:false },
    check: { episode:{id:'e'}, captureId:'c', question:'wellness', phase:'listening' } } }, onContinue() {} });
  const walk = (n: any): any[] => !n || typeof n !== 'object' ? [] : Array.isArray(n) ? n.flatMap(walk) : [n,...walk(n.props?.children),...walk(n.props?.footer)];
  const nodes = walk(tree); assert.equal(nodes.filter(n => n.type === 'Thread').length,1);
  assert.equal(nodes.filter(n => n.type === 'ScrollView').length,1,'one independent bounded composer');
  const thread = nodes.find(n => n.type === 'Thread'); assert.equal(thread.props.footer, undefined);
  const composer = nodes.find(n => n.type === 'ScrollView');
  assert.equal(composer.props.keyboardShouldPersistTaps, 'handled');
  assert.equal(composer.props.style.maxHeight, 844 * 0.28);
  assert.ok(walk(composer).some(n => n.type === 'TypedResponse'));
  assert.equal(walk(composer).filter(n => n.type === 'Btn').length, 0);
  assert.equal(nodes.filter(n => n.type === 'Btn').length, 2);
  const header = nodes.find(n => n.type === 'Text' && n.props.accessibilityRole === 'header'); assert.equal(header.props.children,'Sensi');
  assert.equal(nodes.filter(n => n.type === 'KeyboardAvoidingView').length,1); assert.equal(nodes.filter(n => n.type === 'SafeAreaView').length,1);
});

const walk = (node: any): any[] => !node || typeof node !== 'object' ? []
  : Array.isArray(node) ? node.flatMap(walk) : [node, ...walk(node.props?.children)];
function renderProviderStatus(development: boolean, messages: readonly ConversationMessage[], preference?: SensiPreference) {
  const { render, provider } = harness(844, development, preference);
  const tree = render({ drive: { safety: {
    conversation: { episodeId: 'episode', messages, simulation: true, finished: false },
    check: { episode: { id: 'episode' }, question: 'wellness', phase: 'response_unavailable' },
  } }, onContinue() {} });
  assert.ok(!walk(tree).some(node => node.type?.name === 'VoiceCheckProviderStatus'));
  return development ? walk(provider({ messages })) : [];
}

const prompt: ConversationMessage = { id: 'prompt', role: 'assistant', text: 'Are you feeling okay?' };
const guidance: ConversationMessage = { id: 'guidance', role: 'assistant', text: 'Pull over safely.' };
function value(nodes: any[], label: string) {
  return nodes.find(node => node.type === 'Text' && node.props.children?.[0] === label)?.props.children[1].props.children;
}

test('Debug provider panel shows the active VoiceCheck mode and no acknowledgment while awaiting a response', () => {
  const nodes = renderProviderStatus(true, [prompt, guidance], 'automatic');
  assert.equal(value(nodes, 'Response mode: '), 'Basic Offline');
  assert.equal(value(nodes, 'Last acknowledgment: '), 'Not generated yet');
  assert.equal(value(renderProviderStatus(true, [prompt]), 'Response mode: '), 'Basic Offline');
});

for (const [source, expected] of [
  ['openai', 'OpenAI'], ['gemma', 'On-device Gemma'], ['fallback', 'Basic Offline'], ['unknown', 'Unknown'],
] as const) {
  test(`Debug provider panel shows ${expected} from the latest acknowledgment despite later fixed guidance`, () => {
    const messages: ConversationMessage[] = [
      prompt,
      { id: 'earlier', role: 'assistant', text: 'Earlier acknowledgment.', acknowledgmentSource: 'gemma' },
      { id: 'ack', role: 'assistant', text: 'I hear you.', acknowledgmentSource: source },
      guidance,
      { id: 'driver', role: 'driver', text: 'No thanks', acknowledgmentSource: 'openai' },
    ];
    const nodes = renderProviderStatus(true, messages, 'automatic');
    assert.equal(value(nodes, 'Response mode: '), 'Basic Offline');
    assert.equal(value(nodes, 'Last acknowledgment: '), expected);
    assert.deepEqual(renderProviderStatus(false, messages, 'automatic'), []);
  });
}


test('Center indicator follows published voice phases, including cancellation and playback failure', () => {
  const { render } = harness();
  for (const [phase, label, icon] of [
    ['preparing', 'Preparing microphone', 'shield'],
    ['ready', 'Ready…', 'shield'],
    ['speaking', 'Speaking…', 'volume-2'],
    ['listening', 'Listening…', 'mic'],
    ['finalizing', 'Processing response…', 'more-horizontal'],
    ['response_unavailable', 'Voice unavailable — use buttons or type a response', 'alert-circle'],
    [undefined, 'Finishing safety check…', 'more-horizontal'],
  ] as const) {
    const tree = render({ drive: { safety: {
      conversation: { episodeId: 'episode', language: 'es', simulation: true, finished: false,
        messages: [{ role: 'assistant', playback: 'playing', text: '¿Te sientes bien?' }] },
      check: phase ? { episode: { id: 'episode' }, question: 'wellness', phase } : null,
    } }, onContinue() {} });
    const nodes = walk(tree);
    assert.equal(nodes.find(n => n.type === 'LanguageScope').props.language, 'es');
    assert.ok(nodes.some(n => n.props?.children === 'Simulation'));
    const instance = nodes.find(n => n.type?.name === 'VoiceCheckListeningIndicator');
    const indicator = walk(instance.type(instance.props));
    assert.equal(indicator.find(n => n.type === 'Feather').props.name, icon);
    assert.ok(indicator.some(n => n.props?.children === label));
    assert.notEqual(translateText(label, 'es'), label);
    assert.equal(translateText(label, 'en'), label);
    assert.equal(indicator.some(n => n.props?.children === '¿Te sientes bien?'), phase === 'speaking');
    const failure = walk(instance.type({ ...instance.props, phase: 'listening', audioUnavailable: true }));
    assert.equal(failure.find(n => n.type === 'Feather').props.name, 'alert-circle');
    const completed = walk(instance.type({ ...instance.props, phase: 'listening', finished: true }));
    assert.ok(completed.some(n => n.props?.children === 'Safety check finished'));
    const pending = walk(instance.type({ ...instance.props, phase: 'listening', answerPending: true }));
    assert.equal(pending.find(n => n.type === 'Feather').props.name, 'more-horizontal');
  }
});

test('short keyboard viewport preserves separate contact actions and scoped typing at large text sizes', () => {
  const { render } = harness(330, false, undefined, 1.8, 320);
  const tree = render({ drive: { safety: {
    conversation: { episodeId: 'small', language: 'en', finished: false, messages: [] },
    check: { episode: { id: 'small' }, question: 'contact_offer', phase: 'ready', captureId: 'offer' },
  } }, onContinue() {} });
  const nodes = walk(tree);
  assert.equal(nodes.find(n => n.type === 'KeyboardAvoidingView').props.behavior, 'padding');
  const indicator = nodes.find(n => n.type?.name === 'VoiceCheckListeningIndicator');
  assert.equal(indicator.props.shortViewport, true);
  assert.ok(!nodes.some(n => n.props?.children === 'Simulation'));
  const buttons = nodes.filter(n => n.type === 'Btn');
  assert.deepEqual(buttons.map(n => n.props.title), ['Yes, open phone', 'No, thanks']);
  const composer = nodes.find(n => n.type === 'ScrollView');
  assert.equal(walk(composer).filter(n => n.type === 'Btn').length, 0);
  const input = walk(composer).find(n => n.type === 'TypedResponse');
  assert.equal(input.props.secondary, true);
  assert.deepEqual(input.props.scope, { episodeId: 'small', captureId: 'offer', question: 'contact_offer' });
});

test('Developer timing tools retain recorded acknowledgment provenance after closing VoiceCheck', () => {
  const { provider } = harness(844, true, 'automatic');
  const nodes = walk(provider({ messages: [], recordedSource: 'fallback' }));
  assert.equal(value(nodes, 'Response mode: '), 'Basic Offline');
  assert.equal(value(nodes, 'Last acknowledgment: '), 'Basic Offline');
  const diagnostics = readFileSync(new NodeURL('../components/ResponsivenessDiagnostics.tsx', import.meta.url), 'utf8');
  const settings = readFileSync(new NodeURL('../components/SettingsView.tsx', import.meta.url), 'utf8');
  assert.match(diagnostics, /<VoiceCheckProviderStatus messages=\{messages\} recordedSource=\{recordedSource\}/);
  assert.match(settings, /page === 'developer' && __DEV__/);
});

test('provider panel sits below the header in live and simulated VoiceCheck at a short iPhone viewport', () => {
  const { render } = harness(330, false, undefined, 1, 320);
  for (const [episodeId, simulation] of [['live-a', false], ['rehearsal', true], ['live-b', false]] as const) {
    const messages = [{ id: episodeId, role: 'assistant', text: 'Guidance' }];
    for (const phase of ['ready', 'listening', 'finalizing', 'speaking'] as const) {
      const nodes = walk(render({ drive: { safety: {
        conversation: { episodeId, messages, simulation, finished: false },
        check: { episode: { id: episodeId }, question: 'wellness', phase },
      } }, onContinue() {} }));
      const panel = nodes.find(node => node.type === 'BasicOfflineStatus');
      const indicator = nodes.find(node => node.type?.name === 'VoiceCheckListeningIndicator');
      const subtitle = nodes.find(node => node.props?.children === 'Safety check');
      assert.equal(panel.props.messages, messages);
      assert.equal(nodes.some(node => node.type === 'LiveSensiProvider'), false);
      assert.equal(indicator.props.phase, phase);
      assert.ok(nodes.indexOf(subtitle) < nodes.indexOf(panel));
      assert.ok(nodes.indexOf(panel) < nodes.indexOf(indicator));
      assert.ok(nodes.indexOf(indicator) < nodes.findIndex(node => node.type === 'Thread'));
      assert.ok(nodes.indexOf(indicator) < nodes.findIndex(node => node.type === 'Btn'));
      assert.equal(nodes.some(node => node.props?.children === 'Simulation'), simulation);
    }
  }
});

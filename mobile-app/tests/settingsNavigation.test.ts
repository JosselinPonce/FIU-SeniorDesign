import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { SETTINGS_CATEGORIES, settingsTitle } from '../lib/ui/settingsNavigation.ts';
import { voiceDisplayLabel } from '../lib/ui/voiceLabel.ts';
import { light, dark, presentationColors } from '../lib/theme/tokens.ts';
import { settingsSwitchColors } from '../lib/ui/settingsSwitch.ts';
import { REHEARSAL_SAFETY_REVISION } from '../lib/voice/phoneHandoff.ts';
import { ASSISTANT_MODES } from './retired-ai/lib/assistant/mode.ts';
import { sensiSignInEnabled } from '../lib/assistant/pilotSignIn.ts';
import { simulationCompletion } from '../lib/assistant/safetyConversation.ts';
const require = createRequire(import.meta.url);
function harness(development: boolean, active = false, theme = light) {
  const state = new Map<number, any>(); let index = 0; let back: (() => boolean) | undefined;
  const calls: unknown[] = [];
  const host = Object.fromEntries(['Pressable','ScrollView','Switch','Text','View'].map(n => [n,n]));
  const forbidden = () => { throw Error('Unexpected service access'); };
  const drive = { safety: { th: null, prior: null, check: null, demo: null, last: null }, driver: { id: 'fixture', display_name: 'Fixture', language: 'en' },
    hasActiveSession: active, storageMode: 'vitals', connection: 'idle', packets: 0, lost: 0, crcErrors: 0, duplicates: 0,
    setStorageMode: (mode: string) => calls.push(['storage', mode]), autoConnect: () => calls.push('connect'),
    stopConnecting: () => calls.push('disconnect'), setAllowDirect: (v: boolean) => calls.push(['direct',v]) };
  const deps: Record<string, any> = {
    react: { useState: (initial: any) => { const id = index++; if (!state.has(id)) state.set(id, initial); return [state.get(id), (v: any) => state.set(id, typeof v === 'function' ? v(state.get(id)) : v)]; },
      useEffect: (fn: () => void) => fn() },
    'react/jsx-runtime': require('react/jsx-runtime'),
    'react-native': { ...host, Alert: { alert: forbidden }, BackHandler: { addEventListener: (_: string, fn: () => boolean) => { back = fn; return { remove() {} }; } }, StyleSheet: { create: (s: any) => s } },
    '../lib/theme/ThemeProvider': { useTheme: () => ({ tokens: theme, colors: presentationColors(theme), preference: 'light', setPreference: (v: string) => calls.push(['appearance',v]) }) },
    '../lib/ui/settingsSwitch': { settingsSwitchColors },
    '../lib/voice/phoneHandoff': { REHEARSAL_SAFETY_REVISION },
    '../lib/theme/tokens': { presentationColors }, '../lib/ui/settingsNavigation': { SETTINGS_CATEGORIES, settingsTitle },
    '../lib/db/sync': { pendingCount: forbidden, syncToSupabase: forbidden }, '../lib/db/deletion': { wipeEverything: forbidden },
    './ui': Object.fromEntries(['Btn','Card','Row','SectionTitle'].map(n => [n,n])),
    '../lib/assistant/mode': { ASSISTANT_MODES }, '../lib/assistant/pilotSignIn': { sensiSignInEnabled },
    '../lib/assistant/safetyConversation': { simulationCompletion },
    '../lib/assistant/phoneConnectedReadiness': { PHONE_CONNECTED_READINESS: { verified: false } },
    '../lib/assistant/connectedPilotPolicy': { CONNECTED_PILOT_STATUS: 'pilot' },
  };
  for (const n of ['Information','DemoAuthPanel','VoicePicker','CalibrationCard','ThresholdHistory','ResponsivenessDiagnostics','SensiVoicePlaybackDiagnostic']) {
    deps['./'+n] = { [n === 'Information' ? 'InformationButton' : n]: n };
  }
  const compiled = ts.transpileModule(readFileSync(new NodeURL('../components/SettingsView.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: any = {};
  new Function('require','exports','__DEV__','process',compiled)((name: string) => { assert.ok(name in deps, name); return deps[name]; }, exports, development, { env: {} });
  const props = { drive, assistantMode: 'local', assistantModeBusy: false, assistantModeError: '', autoOn: true,
    onAssistantModeChange: (mode: string) => calls.push(['mode',mode]), setAutoOn: (v: boolean) => calls.push(['auto',v]),
    onWiped: forbidden, onShowIntro: () => calls.push('intro'), onEditProfile: () => calls.push('edit') };
  function render() {
    index = 0; const nodes: any[] = [];
    const visit = (n: any) => { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) { n.forEach(visit); return; } nodes.push(n); visit(n.props?.children); };
    visit(exports.SettingsView(props)); return nodes;
  }
  return { render, calls, back: () => back!(), props };
}
test('landing has five categories and secondary Advanced; category and hardware back preserve parent state', () => {
  const f = harness(true);
  for (const category of SETTINGS_CATEGORIES) {
    const landing = f.render(); landing.find(n => n.props?.accessibilityLabel === category.title).props.onPress();
    const detail = f.render(); assert.ok(detail.find(n => n.type === 'SectionTitle' && n.props.children === category.title));
    assert.equal(f.back(), true);
  }
  assert.equal(f.back(), true); // callback from the last detail render
  f.render(); assert.equal(f.back(), false);
  assert.equal(f.calls.length, 0);
});
test('category controls retain profile/storage/connection callbacks without a provider selector', async () => {
  const f = harness(true); let nodes = f.render();
  assert.equal(nodes.some(n => n.type === 'SectionTitle' && n.props.children === 'Appearance'),false);
  function open(title: string) { f.render().find(n => n.props?.accessibilityLabel === title).props.onPress(); return f.render(); }
  nodes = open('Driver Profile'); nodes.find(n => n.props?.title === 'Edit Driver Profile').props.onPress(); f.back();
  nodes = open('Data & Privacy'); nodes.find(n => n.type === 'Pressable' && n.key === 'full').props.onPress(); f.back();
  nodes = open('Sensi Assistant'); assert.equal(nodes.some(n => n.type === 'Pressable' && n.key === 'connected'), false); assert.ok(nodes.some(n => n.type === 'SectionTitle' && n.props.children === 'Sensi · Gemma on-device')); f.back();
  nodes = open('Connections'); nodes.find(n => n.type === 'Row' && n.props.label === 'Auto-connect to the Pi').props.value.props.onValueChange(false);
  assert.deepEqual(f.calls, ['edit',['storage','full'],'disconnect',['auto',false]]);
});
test('advanced preserves development gates and simulator availability; active-drive recording lock survives movement', () => {
  for (const development of [true,false]) {
    const f = harness(development);
    const landing = f.render(); assert.equal(landing.some(n => n.type === 'DemoAuthPanel'), false);
    landing.find(n => n.props?.accessibilityLabel === 'Advanced Settings').props.onPress();
    const nodes = f.render();
    assert.equal(nodes.some(n => n.type === 'SensiVoicePlaybackDiagnostic'), development);
    assert.equal(nodes.some(n => n.type === 'ResponsivenessDiagnostics'), development);
    assert.ok(nodes.some(n => n.props?.title === 'Low oxygen'));
    nodes.find(n => n.props?.accessibilityLabel === 'Back to Settings').props.onPress();
    assert.ok(f.render().some(n => n.props?.accessibilityLabel === 'Driver Profile'));
  }
  const f = harness(false,true); f.render().find(n => n.props?.accessibilityLabel === 'Data & Privacy').props.onPress();
  assert.equal(f.render().find(n => n.type === 'Pressable' && n.key === 'full').props.disabled, true);
});
test('voice display label includes tier once without changing identifiers', () => {
  assert.equal(voiceDisplayLabel('Zoe (Premium)','Premium'),'Zoe (Premium)');
  assert.equal(voiceDisplayLabel('Zoe','Premium'),'Zoe (Premium)');
  assert.equal(voiceDisplayLabel('Voice (Enhanced)','Enhanced'),'Voice (Enhanced)');
});

for (const theme of [light, dark]) test(`${theme === light ? 'Light' : 'Dark'} Connection and Link Health switches share visible green styling and retain callbacks/state`, () => {
  const f = harness(true, false, theme);
  f.render().find(n => n.props?.accessibilityLabel === 'Connections').props.onPress();
  let nodes = f.render();
  const auto = nodes.find(n => n.type === 'Row' && n.props.label === 'Auto-connect to the Pi').props.value;
  const direct = nodes.find(n => n.type === 'Switch');
  assert.equal(auto.props.value, true); assert.equal(direct.props.value, false);
  for (const control of [auto, direct]) {
    assert.deepEqual(control.props.trackColor, { false: theme.switchOff, true: theme.switchOn });
    assert.equal(control.props.thumbColor, theme.switchThumb);
    assert.equal(control.props.ios_backgroundColor, theme.switchOff);
  }
  auto.props.onValueChange(false); f.props.autoOn = false;
  direct.props.onValueChange(true);
  nodes = f.render();
  assert.equal(nodes.find(n => n.type === 'Row' && n.props.label === 'Auto-connect to the Pi').props.value.props.value, false);
  assert.equal(nodes.find(n => n.type === 'Switch').props.value, true);
  // Navigation must not reset the existing in-memory setting.
  f.back(); f.render().find(n => n.props?.accessibilityLabel === 'Connections').props.onPress();
  assert.equal(f.render().find(n => n.type === 'Switch').props.value, true);
  f.render().find(n => n.type === 'Switch').props.onValueChange(false);
  assert.deepEqual(f.calls, ['disconnect', ['auto', false], ['direct', true], ['direct', false]]);
});

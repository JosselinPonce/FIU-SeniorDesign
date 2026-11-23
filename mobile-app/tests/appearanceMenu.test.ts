import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { light } from '../lib/theme/tokens.ts';
const require = createRequire(import.meta.url);
test('shared header menu uses existing preference and setter for all three choices without duplicate state', () => {
  const source=readFileSync(new NodeURL('../components/AppearanceMenu.tsx',import.meta.url),'utf8');
  assert.doesNotMatch(source,/useState|setSetting|Appearance.setColorScheme/);
  const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
  for(const preference of ['light','dark','system'] as const) {
    let buttons: any[]=[]; const calls: string[]=[];
    const exports: any={};
    new Function('require','exports',compiled)((name:string)=>{
      if(name==='../lib/i18n/native')return {LocalizedPressable:'Pressable',LocalizedText:'Text',LocalizedAlert:{alert:(_title:string,_body:string,choices:any[])=>{buttons=choices;}}};
      if(name==='../lib/i18n/LanguageProvider')return {useAppLanguage:()=>({t:(text:string)=>text})};
      if(name==='react/jsx-runtime')return require(name);
      if(name==='react-native')return {Pressable:'Pressable',Text:'Text',View:'View',Alert:{alert:(_title:string,_body:string,choices:any[])=>{buttons=choices;}}};
      assert.equal(name,'../lib/theme/ThemeProvider');return {useTheme:()=>({tokens:light,preference,setPreference:(value:string)=>calls.push(value)})};
    },exports);
    const tree=exports.AppearanceMenu(); const button=tree.props.children[0];
    assert.match(button.props.accessibilityLabel,new RegExp(preference,'i'));
    assert.ok(button.props.style.minWidth>=44); assert.ok(button.props.style.minHeight>=44);
    button.props.onPress();
    assert.equal(buttons.length,4); assert.equal(buttons.filter(b=>b.text.startsWith('✓')).length,1);
    buttons.slice(0,3).forEach(b=>b.onPress());assert.deepEqual(calls,['light','dark','system']);
    assert.equal(buttons[3].style,'cancel');
  }
  const shell=readFileSync(new NodeURL('../components/SmartWheelScreen.tsx',import.meta.url),'utf8');
  const header=shell.slice(shell.indexOf('<View style={st.header}>'),shell.indexOf('<DriverAssistant visible='));
  assert.match(header,/<DriveProfileMenu/); assert.match(header,/onSwitch=\{switchDriver\}/);
});

test('profile dropdown reuses preferences and changes dashboard mode without invoking profile actions', () => {
  const source = readFileSync(new NodeURL('../components/DriveProfileMenu.tsx', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  for (const development of [true, false]) {
    let index = 0;
    const state: unknown[] = [];
    const calls: string[] = [];
    const deps: Record<string, any> = {
      react: { useEffect: (fn: () => void) => fn(), useState: (initial: unknown) => {
        const i = index++;
        if (!(i in state)) state[i] = initial;
        return [state[i], (next: unknown) => { state[i] = next; }];
      } },
      'react/jsx-runtime': createRequire(import.meta.url)('react/jsx-runtime'),
      'react-native': { Modal: 'Modal', View: 'View', ScrollView: 'ScrollView' },
      '../lib/i18n/native': { LocalizedText: 'Text', LocalizedPressable: 'Pressable' },
      './LanguageMenu': { useLanguagePicker: () => ({ language: 'en', t: (s: string) => s, open: () => calls.push('language-picker') }) },
      '../lib/theme/ThemeProvider': { useTheme: () => ({ tokens: {}, preference: 'system', setPreference: (v: string) => calls.push(v) }) },
      '../lib/ui/profileSummary': { driverInitials: () => 'DS' },
      './SettingsGroup': { SettingsGroup: 'Group', SettingsRow: 'Row' },
    };
    const exports: any = {};
    new Function('require', 'exports', '__DEV__', code)((id: string) => deps[id], exports, development);
    const props = { name: 'Demo Sam', dashboardMode: false, blocked: false,
      onDashboardMode: (demo: boolean) => calls.push(String(demo)), onEdit: () => calls.push('edit'), onSwitch: () => calls.push('switch') };
    const nodes = (element: any): any[] => Array.isArray(element) ? element.flatMap(nodes)
      : element?.props ? [element, ...nodes(element.props.children)] : [];
    const render = () => { index = 0; return nodes(exports.DriveProfileMenu(props)); };
    const row = (title: string) => render().find(n => n.type === 'Row' && n.props.title === title)?.props;
    const open = () => render().find(n => n.type === 'Pressable' && n.props.accessibilityLabel.endsWith('Demo Sam')).props.onPress();
    open();
    const segment = (label: string) => render().find(n => n.type === 'Pressable' && n.props.accessibilityRole === 'radio' && n.props.children.props.children === label).props;
    segment('Dark').onPress();
    row('Language').onPress();
    if (development) segment('Hardware Demo').onPress();
    else assert.equal(row('Dashboard Mode'), undefined);
    assert.deepEqual(calls, development ? ['dark', 'language-picker', 'true'] : ['dark', 'language-picker']);
    open(); row('Edit Profile').onPress();
    open(); row('Switch Driver').onPress();
    assert.deepEqual(calls.slice(-2), ['edit', 'switch']);
    open();
    props.blocked = true;
    assert.equal(render().find(n => n.type === 'Modal').props.visible, false);
  }
});

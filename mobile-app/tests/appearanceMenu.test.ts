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
  assert.match(header,/<AppearanceMenu \/>/); assert.match(header,/onPress=\{switchDriver\}/);
});

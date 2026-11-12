import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { translateText } from '../lib/i18n/translate.ts';
const require=createRequire(import.meta.url);
test('driver-language scope translates active controls/status without changing independent interface preference',()=>{
  let writes=0;
  for(const app of ['en','es'] as const)for(const driver of ['en','es'] as const){
    const parent={language:app,error:'',t:(s:string)=>translateText(s,app),setLanguage:()=>{writes++;}};
    const deps:Record<string,any>={react:{createContext:()=>({Provider:'ScopedLanguage'}),useContext:()=>parent,useMemo:(f:()=>any)=>f()},
      'react/jsx-runtime':require('react/jsx-runtime'),'../db/repositories':{},'./preferences':{},'./translate':{translateText}};
    const exports:any={};new Function('require','exports',ts.transpileModule(readFileSync(new NodeURL('../lib/i18n/LanguageProvider.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText)(
      (name:string)=>{assert.ok(name in deps,name);return deps[name];},exports);
    const tree=exports.VoiceCheckLanguageScope({language:driver,children:'active safety'});const scoped=tree.props.value;
    assert.equal(scoped.language,driver);assert.equal(parent.language,app);assert.equal(tree.props.children,'active safety');
    for(const source of ['Speaking…','Listening…','Safety check finished','Send response','Type a response','Yes, open phone','No, thanks']) assert.equal(scoped.t(source),translateText(source,driver));
    assert.equal(scoped.t('Would you like me to call Mom?'),driver==='es'?'¿Quieres que llame a Mom?':'Would you like me to call Mom?');
    assert.equal(scoped.t(driver==='es'?'Lamento que te sientas cansada.':"I'm sorry you're feeling tired."),driver==='es'?'Lamento que te sientas cansada.':"I'm sorry you're feeling tired.");
    assert.equal(writes,0);
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { URL as NodeURL } from 'node:url';
import ts from 'typescript';
import { nearThreadBottom, playbackLabel } from '../lib/assistant/threadPresentation.ts';
const require = createRequire(import.meta.url);
test('one thread scrolls all messages and response controls; reviewing history disables automatic scrolling', () => {
  const refs: { current: any }[] = []; let index = 0, effectKey: string | undefined, scrolls = 0;
  const deps: Record<string, any> = {
    react: { useRef: (value: any) => { const n = index++; return refs[n] ??= { current: value }; }, useEffect: (fn: () => void, keys: string[]) => { if (keys[0] !== effectKey) { effectKey = keys[0]; fn(); } } },
    'react/jsx-runtime': require('react/jsx-runtime'), 'react-native': { ScrollView: 'ScrollView', View: 'View' },
    '../lib/i18n/native': { LocalizedText: 'Text' }, '../lib/theme/ThemeProvider': { useTheme: () => ({ tokens: {} }) },
    '../lib/assistant/threadPresentation': { nearThreadBottom, playbackLabel },
  };
  const exports: any = {};
  new Function('require','exports',ts.transpileModule(readFileSync(new NodeURL('../components/SensiConversationThread.tsx',import.meta.url),'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText)(
    (name: string) => { assert.ok(name in deps,name); return deps[name]; },exports);
  const messages = [{ id: 'first', role: 'assistant', text: 'First mandatory guidance' },{ id: 'last', role: 'driver', text: 'Last answer' }];
  const render = () => { index = 0; return exports.SensiConversationThread({ messages, provisional: '', footer: 'response controls', compactPlayback: true }); };
  let tree = render(); refs[0]!.current = { scrollToEnd: () => { scrolls++; } };
  assert.equal(tree.type,'ScrollView'); assert.equal(tree.props.removeClippedSubviews,false); assert.equal(tree.props.keyboardShouldPersistTaps,'handled');
  assert.equal(tree.props.style.minHeight,0); assert.ok(JSON.stringify(tree).includes('First mandatory guidance')); assert.ok(JSON.stringify(tree).includes('Last answer')); assert.ok(JSON.stringify(tree).includes('response controls'));
  tree.props.onContentSizeChange(); assert.equal(scrolls,1);
  tree.props.onScroll({ nativeEvent: { contentSize: { height: 1500 }, layoutMeasurement: { height: 300 }, contentOffset: { y: 0 } } });
  messages.push({ id: 'new', role: 'assistant', text: 'New message' }); tree = render(); tree.props.onContentSizeChange(); tree.props.onLayout();
  assert.equal(scrolls,1,'new content and keyboard layout do not force bottom while reviewing history');
  tree.props.onScroll({ nativeEvent: { contentSize: { height: 1500 }, layoutMeasurement: { height: 300 }, contentOffset: { y: 1200 } } });
  tree.props.onContentSizeChange(); assert.equal(scrolls,2);
});

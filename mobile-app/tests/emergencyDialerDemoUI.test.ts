import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { URL as NodeURL } from 'node:url';
import { light, dark } from '../lib/theme/tokens.ts';
const require = createRequire(import.meta.url);
function harness(tokens = light, blocked = false) {
  let buttons: any[] = [], clean: any, calls = 0;
  const nodes: any[] = [];
  const deps: Record<string, any> = {
    react: { useEffect: (fn: any) => { clean = fn(); }, useRef: (v: any) => ({ current: v }), useState: (v: any) => [v, () => {}] },
    'react/jsx-runtime': require('react/jsx-runtime'),
    'react-native': { Platform: { OS: 'ios', Version: 26 }, AppState: { currentState: 'active' }, Linking: {} },
    '../lib/i18n/native': { LocalizedText: 'Text', LocalizedAlert: { alert: (_: any, __: any, actions: any[]) => { buttons = actions; } } },
    '../lib/theme/ThemeProvider': { useTheme: () => ({ tokens }) },
    '../lib/voice/demoPhoneHandoff': { openDemoPhoneInterface: async (deps: any) => { if (deps.current()) calls++; return 'cancelled'; } },
    './ui': { Btn: 'Btn', Card: 'Card', SectionTitle: 'SectionTitle' },
  };
  const exports: any = {};
  new Function('require', 'exports', ts.transpileModule(readFileSync(new NodeURL('../components/EmergencyDialerDemo.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText)(
    (name: string) => { assert.ok(name in deps, name); return deps[name]; }, exports);
  const visit = (n: any) => { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) return n.forEach(visit); nodes.push(n); visit(n.props?.children); };
  visit(exports.EmergencyDialerDemo({ blocked }));
  return { nodes, press: () => nodes.find(n => n.type === 'Btn').props.onPress(), buttons: () => buttons, calls: () => calls, unmount: () => clean() };
}
for (const tokens of [light, dark]) test('dialer demo requires a new tap and confirmation; cancellation and unmount prevent handoff', async () => {
  const f = harness(tokens);
  assert.equal(f.calls(), 0);
  assert.ok(f.nodes.some(n => n.props?.children === 'DEMO MODE — fictional number only'));
  f.press(); assert.equal(f.calls(), 0);
  f.buttons()[0].onPress(); assert.equal(f.calls(), 0);
  f.press(); await f.buttons()[1].onPress(); assert.equal(f.calls(), 1);
  const gone = harness(tokens); gone.press(); gone.unmount(); await gone.buttons()[1].onPress(); assert.equal(gone.calls(), 0);
  const blocked = harness(tokens, true); blocked.press(); assert.deepEqual(blocked.buttons(), []);
});

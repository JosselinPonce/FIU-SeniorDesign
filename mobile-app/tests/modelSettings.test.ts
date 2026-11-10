import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';
const require = createRequire(import.meta.url);
function harness(blocked = false) {
  const effects: Array<() => void> = [], cleanups: Array<() => void> = []; let appListener!: (state: string) => void;
  let repairs = 0, cancels = 0, finish!: () => void;
  const setup = { state: { ready: true, busy: false, modelReady: false, error: '' }, runtime: { state: { busy: false, error: '', cleanupRequired: false } },
    subscribe: () => () => {}, cancel: () => { cancels++; }, repair: async (current: () => boolean) => {
      repairs++; assert.equal(current(), true); setup.state.busy = true; await new Promise<void>(resolve => { finish = resolve; }); setup.state.busy = false;
    } };
  const deps: Record<string, any> = {
    react: { useEffect: (effect: () => void) => effects.push(effect), useRef: (value: any) => ({ current: value }),
      useState: (initial: any) => [typeof initial === 'function' ? initial() : initial, () => {}] },
    'react/jsx-runtime': require('react/jsx-runtime'), 'react-native': { AppState: { currentState: 'active', addEventListener: (_: string, fn: typeof appListener) => { appListener = fn; return { remove() {} }; } } },
    '../lib/i18n/native': { LocalizedText: 'Text' }, '../lib/theme/ThemeProvider': { useTheme: () => ({ tokens: {} }) },
    '../lib/onboarding/phone': { sensiSetup: setup }, '../modules/gemma-poc/phone': { inspectGemmaModelFile: () => 'present' },
    './ui': { Btn: 'Btn', Card: 'Card', SectionTitle: 'SectionTitle' },
  };
  const source = readFileSync(new NodeURL('../components/GemmaModelSettings.tsx', import.meta.url), 'utf8');
  const exports: any = {};
  new Function('require', 'exports', '__DEV__', ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText)(
    (name: string) => { assert.ok(name in deps, name); return deps[name]; }, exports, false);
  const tree = exports.GemmaModelSettings({ blocked });
  effects.forEach(effect => { const cleanup = effect(); if (typeof cleanup === 'function') cleanups.push(cleanup); });
  const nodes: any[] = []; function visit(node: any) { if (!node) return; if (Array.isArray(node)) { node.forEach(visit); return; } if (typeof node === 'object') { nodes.push(node); visit(node.props?.children); } } visit(tree);
  return { nodes, setup, get repairs() { return repairs; }, get cancels() { return cancels; }, background: () => appListener('background'),
    finish: () => finish(), unmount: () => cleanups.forEach(cleanup => cleanup()) };
}
test('production model recovery is explicit, non-Debug, and does not claim file presence is verified readiness', async () => {
  const f = harness(); assert.equal(f.repairs, 0);
  assert.ok(f.nodes.some(n => n.props?.children === 'Check Gemma here to confirm model readiness.'));
  const button = f.nodes.find(n => n.props?.title === 'Check and repair Gemma'); assert.equal(button.props.disabled, false);
  button.props.onPress(); button.props.onPress(); assert.equal(f.repairs, 1);
  f.background(); assert.equal(f.cancels, 1); assert.equal(f.setup.state.ready, true);
  f.finish(); await new Promise(resolve => setImmediate(resolve)); f.unmount(); assert.equal(f.cancels, 1);
});
test('blocked recovery controls cannot start work, including through a stale enabled-button callback', () => {
  const f = harness(true); const button = f.nodes.find(n => n.props?.title === 'Check and repair Gemma');
  assert.equal(button.props.disabled, true); button.props.onPress(); assert.equal(f.repairs, 0); f.unmount();
});

import { settingsSwitchColors } from '../lib/ui/settingsSwitch.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';
const require = createRequire(import.meta.url);
function nodes(n: any): any[] { return !n || typeof n !== 'object' ? [] : Array.isArray(n) ? n.flatMap(nodes) : [n, ...nodes(n.props?.children), ...nodes(n.props?.trailing)]; }
for (const blocked of [false, true]) test(`optional cloud controls render in Release; blocked=${blocked}, sign-out remains available`, () => {
  const calls: string[] = [], values: unknown[] = [], refs: any[] = [];
  const deps: Record<string, unknown> = {
    react: { useState: (v: unknown) => { values.push(v); return [v, () => {}]; }, useRef: (v: unknown) => { const ref = { current: v }; refs.push(ref); return ref; }, useEffect: (f: () => unknown) => { f(); } },
    'react/jsx-runtime': require('react/jsx-runtime'), 'react-native': { Switch: 'Switch', StyleSheet: { hairlineWidth: 1 } },
    '../lib/i18n/native': { LocalizedText: 'Text', LocalizedTextInput: 'TextInput' }, '../lib/theme/ThemeProvider': { useTheme: () => ({ tokens: {} }) },
    '../lib/assistant/phoneCloudAuth': { sensiCloudAuth: { state: { status: 'signed_out' }, subscribe: () => () => {}, signIn: async () => { calls.push('signin'); return true; }, signOut: async () => { calls.push('signout'); return true; }, restore: async () => { calls.push('restore'); return true; } } },
    './SettingsGroup': { SettingsGroup: 'SettingsGroup', SettingsRow: 'SettingsRow', SettingsNote: 'SettingsNote' },
    '../lib/ui/settingsSwitch': { settingsSwitchColors },
    './ui': { Btn: 'Btn', Card: 'Card', SectionTitle: 'SectionTitle' },
  };
  const source = readFileSync(new NodeURL('../components/SensiCloudAccess.tsx', import.meta.url), 'utf8'); const exports: any = {};
  assert.doesNotMatch(source, /__DEV__|EXPO_PUBLIC_.*PASSWORD|SUPABASE_SERVICE_ROLE_KEY/);
  new Function('require', 'exports', '__DEV__', ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText)(
    (name: string) => { assert.ok(name in deps, name); return deps[name]; }, exports, false);
  const rendered = nodes(exports.SensiCloudAccess({ blocked, state: { status: 'signed_out' } }));
  const password = rendered.find(n => n.type === 'TextInput' && n.props.secureTextEntry); assert.ok(password); assert.equal(password.props.editable, !blocked);
  const remember = rendered.find(n => n.type === 'Switch'); assert.equal(remember.props.value, false); assert.equal(remember.props.disabled, blocked);
  assert.equal(rendered.find(n => n.props?.title === 'Refresh Cloud Session').props.disabled, blocked);
  assert.equal(rendered.find(n => n.props?.title === 'Sign Out'), undefined, 'signed-out state hides unnecessary sign-out'); assert.deepEqual(calls, []);
});

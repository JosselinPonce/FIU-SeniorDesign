import * as sensiPresentation from '../lib/ui/sensiPresentation.ts';
import { settingsSwitchColors } from '../lib/ui/settingsSwitch.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { createSensiPreferences } from './helpers/sensiConsent.ts';
import { SENSI_PROVIDERS } from '../lib/assistant/sensiPreferences.ts';
const require = createRequire(import.meta.url);
function nodes(n: any): any[] { return !n || typeof n !== 'object' ? [] : Array.isArray(n) ? n.flatMap(nodes) : [n, ...nodes(n.props?.children), ...nodes(n.props?.trailing)]; }
for (const development of [false, true]) test(`provider and consent controls render with __DEV__=${development}, without model preparation`, async () => {
  const saved = new Map<string, string>();
  const policy = createSensiPreferences({ getSetting: async k => saved.get(k) ?? null, setSetting: async (k, v) => { saved.set(k, v); } });
  await policy.boot(); await policy.selectDriver('driver-a');
  let preparations = 0;
  const deps: Record<string, unknown> = {
    react: { useState: (v: unknown) => [typeof v === 'function' ? v() : v, () => {}], useRef: (v: unknown) => ({ current: v }), useEffect: (f: () => unknown) => { f(); } },
    'react/jsx-runtime': require('react/jsx-runtime'), 'react-native': { Switch: 'Switch', View: 'View' },
    '../lib/i18n/native': { LocalizedText: 'Text' }, '../lib/theme/ThemeProvider': { useTheme: () => ({ tokens: {} }) },
    '../lib/assistant/phoneSensiRouting': { sensiPreferences: policy, resumePreparedGemma: () => { preparations++; }, isGemmaPreparing: () => false, isGemmaExplicitlyStopped: () => false, subscribeGemmaPreparation: () => () => {}, stopPreparedGemma() {} },
    '../lib/assistant/sensiPreferences': { SENSI_PROVIDERS },
    '../modules/gemma-poc/phone': { gemmaPoc: { state: {}, subscribe: () => () => {} }, isGemmaAcknowledgmentReady: () => false, inspectGemmaModelFile: () => 'present' },
    './CloudPrivacyInfo': { CloudPrivacyInfo: 'CloudPrivacyInfo' }, '../lib/ui/sensiPresentation': sensiPresentation, '../lib/ui/settingsSwitch': { settingsSwitchColors },
    './SettingsGroup': { SettingsGroup: 'SettingsGroup', SettingsRow: 'SettingsRow', SettingsNote: 'SettingsNote' },
    './GemmaModelSettings': { GemmaModelSettings: 'GemmaModelSettings' },
    './SensiCloudAccess': { SensiCloudAccess: 'SensiCloudAccess', useSensiAccount: () => ({ status: 'signed_out' }) },
    './Information': { InformationButton: 'InformationButton' },
    './ui': { Btn: 'Btn', Card: 'Card', SectionTitle: 'SectionTitle' },
  };
  const source = readFileSync(new NodeURL('../components/SensiProviderSettings.tsx', import.meta.url), 'utf8'); const exports: any = {};
  new Function('require', 'exports', '__DEV__', ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText)(
    (name: string) => { assert.ok(name in deps, name); return deps[name]; }, exports, development);
  const routes: string[] = [];
  const render = (page: string) => nodes(exports.SensiProviderSettings({ page, driverId: 'driver-a', blocked: false, navigate: (route: string) => routes.push(route) }));
  const overview = render('assistant');
  assert.equal(overview.some(n => n.props?.title === 'Diagnostics'), development);
  for (const [title, route] of [['Account', 'sensi_account'], ['AI Response Mode', 'sensi_mode'], ['Cloud Processing', 'sensi_cloud'], ['On-Device Gemma', 'sensi_gemma']]) {
    overview.find(n => n.props?.title === title).props.onPress();
    assert.equal(routes.at(-1), route);
  }
  assert.equal(overview.find(n => n.props?.title === 'On-Device Gemma').props.subtitle, 'Installed · Verification needed');
  assert.equal(overview.some(n => n.type === 'Switch'), false);
  const rendered = render('sensi_mode');
  assert.equal(rendered.filter(n => n.props?.selected).length, 1);
  assert.equal(rendered.find(n => n.props?.selected).props.title, 'Offline Gemma Preferred');
  for (const option of SENSI_PROVIDERS) assert.ok(rendered.some(n => n.props?.title === option.label));
  const consent = render('sensi_cloud').find(n => n.type === 'Switch'); assert.equal(consent.props.value, false);
  consent.props.onValueChange(true); await new Promise(r => setImmediate(r)); assert.equal(policy.state.consent, true);
  rendered.find(n => n.props?.title === 'Basic Offline Responses').props.onPress(); await new Promise(r => setImmediate(r));
  assert.equal(policy.state.preference, 'basic'); assert.equal(preparations, 0);
});

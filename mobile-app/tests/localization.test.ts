import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { createLanguagePreferences, APP_LANGUAGE_KEY } from '../lib/i18n/preferences.ts';
import { translateText } from '../lib/i18n/translate.ts';
import { spanish } from '../lib/i18n/catalog.ts';
const require = createRequire(import.meta.url);

test('app language persists independently of appearance and every driver/VoiceCheck preference', async () => {
  const saved = new Map([['appearance', 'dark'], ['voicecheck_default_language', 'en'], ['driver_language', 'en']]);
  const store = { getSetting: async (key: string) => saved.get(key) ?? null, setSetting: async (key: string, value: string) => { saved.set(key, value); } };
  const language = createLanguagePreferences(store);
  let renders = 0; const unsubscribe = language.subscribe(() => { renders++; });
  const write = language.select('es');
  assert.equal(language.getSnapshot(), 'es'); assert.equal(renders, 1);
  await write;
  assert.equal(saved.get('appearance'), 'dark'); assert.equal(saved.get('voicecheck_default_language'), 'en'); assert.equal(saved.get('driver_language'), 'en');
  const restarted = createLanguagePreferences(store); await restarted.load(); assert.equal(restarted.getSnapshot(), 'es');
  unsubscribe();
});

test('late preference loads cannot undo a user choice; failed writes remain retryable', async () => {
  let complete!: (value: string) => void;
  let failing = true;
  const writes: string[] = [];
  const language = createLanguagePreferences({ getSetting: () => new Promise(resolve => { complete = resolve; }),
    setSetting: async (key, value) => { assert.equal(key, APP_LANGUAGE_KEY); if (failing) throw Error('Storage unavailable'); writes.push(value); } });
  const loading = language.load();
  await assert.rejects(language.select('es'));
  complete('en'); await loading;
  assert.equal(language.getSnapshot(), 'es');
  failing = false;
  await Promise.all([language.select('en'), language.select('es')]);
  assert.deepEqual(writes, ['en', 'es']);
});

test('translation parameters preserve names, phone numbers, measurement values and punctuation', () => {
  assert.equal(translateText("Edit Aunt María's profile", 'es'), 'Editar el perfil de Aunt María');
  assert.equal(translateText('Delete Status?', 'es'), '¿Eliminar a Status?');
  assert.equal(translateText('Emergency contact: Padre · +13055550123', 'es'), 'Contacto de emergencia: Padre · +13055550123');
  assert.equal(translateText('¿Quieres que llame a Aunt María?', 'en'), 'Would you like me to call Aunt María?');
  assert.equal(translateText('SpO₂ 98% · 72 BPM', 'es'), 'SpO₂ 98% · 72 BPM');
  assert.equal(translateText('✓ Dark', 'es'), '✓ Oscuro');
  assert.match(translateText("I'm sorry to hear that. Please pull over as soon as it is safe. If you need emergency help, call 911.", 'es'), /^Lamento.*llama al 911\.$/);
});

test('localized display primitives preserve raw user content, input values, callbacks and refs', () => {
  const source = readFileSync(new NodeURL('../lib/i18n/native.tsx', import.meta.url), 'utf8');
  const exports: any = {};
  const calls: any[] = [];
  const deps: Record<string, any> = {
    'expo/node_modules/@expo/vector-icons/Feather': { default: 'FeatherIcon' },
    './ScreenHeader': { ScreenHeader: 'ScreenHeader', ScreenHeading: 'ScreenHeading' },
    '../lib/ui/profileSummary': { driverInitials: (name: string) => name[0], maskedContactPhone: (phone: string) => `••• ••• ${phone.slice(-4)}` },
    '../lib/analysis/safetyController': { contactPhone: (phone?: string) => ({phone: phone || null}) },
    './RealContactDemoConfirmation': { RealContactDemoConfirmation: 'RealContactDemoConfirmation' },
    react: { forwardRef: (render: any) => (props: any) => render(props, 'forwarded-ref') },
    'react/jsx-runtime': require('react/jsx-runtime'),
    'react-native': { Text: 'Text', TextInput: 'Input', Pressable: 'Pressable', Alert: { alert: (...args: any[]) => calls.push(args) } },
    './LanguageProvider': { useAppLanguage: () => ({ t: (text: string) => translateText(text, 'es') }), translateCurrent: (text: string) => translateText(text, 'es') },
  };
  new Function('require', 'exports', ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText)(
    (name: string) => { assert.ok(name in deps, name); return deps[name]; }, exports);
  assert.equal(exports.LocalizedText({ children: 'Settings' }).props.children, 'Ajustes');
  assert.equal(exports.LocalizedText({ children: 'Settings', localize: false }).props.children, 'Settings');
  const input = exports.LocalizedTextInput({ value: 'Mom', placeholder: 'Name *' });
  assert.equal(input.props.value, 'Mom'); assert.equal(input.props.placeholder, 'Nombre *'); assert.equal(input.props.ref, 'forwarded-ref');
  const action = () => {};
  exports.LocalizedAlert.alert('Delete this drive?', undefined, [{ text: 'Cancel', onPress: action }]);
  assert.equal(calls[0][0], '¿Eliminar este viaje?'); assert.equal(calls[0][2][0].onPress, action);
});

test('central catalog covers static driver-facing UI copy; technical units, branding and original legal text remain intact', () => {
  const directory = new NodeURL('../components/', import.meta.url);
  const originals = new Set([...Object.values(spanish), 'BMI', 'BPM', 'Raspberry Pi', 'InformationProvider is required']);
  const missing = new Set<string>();
  for (const file of readdirSync(directory).filter(file => file.endsWith('.tsx') && !/Diagnostic|Playback|Draggable|Brand|LanguageMenu/.test(file))) {
    const source = ts.createSourceFile(file, readFileSync(new NodeURL(file, directory), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function visit(node: ts.Node) {
      if (ts.isJsxText(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        const text = node.text.replace(/\s+/g, ' ').trim();
        if (text.length > 2 && (/^[A-Z]/.test(text) || text.includes(' ')) && !text.startsWith('#') && !text.includes('../') && !(text in spanish) && !originals.has(text)) missing.add(`${file}: ${text}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  assert.deepEqual([...missing], []);
  for (const [source, target] of Object.entries(spanish)) {
    assert.ok(target.trim(), source);
    assert.deepEqual([...source.matchAll(/\{\w+\}/g)].map(match => match[0]).sort(), [...target.matchAll(/\{\w+\}/g)].map(match => match[0]).sort(), source);
  }
});

test('driver confirmation is explicit, preserves identity/voice language, and cannot submit twice', () => {
  const source = readFileSync(new NodeURL('../components/DriverConfirmation.tsx', import.meta.url), 'utf8');
  const exports: any = {};
  const deps: Record<string, any> = {
    'expo/node_modules/@expo/vector-icons/Feather': { default: 'FeatherIcon' },
    './ScreenHeader': { ScreenHeader: 'ScreenHeader', ScreenHeading: 'ScreenHeading' },
    '../lib/ui/profileSummary': { driverInitials: (name: string) => name[0], maskedContactPhone: (phone: string) => `••• ••• ${phone.slice(-4)}` },
    react: { useRef: (value: any) => ({ current: value }) }, 'react/jsx-runtime': require('react/jsx-runtime'),
    'react-native': { SafeAreaView: 'SafeAreaView', ScrollView: 'ScrollView', View: 'View' },
    '../lib/i18n/native': { LocalizedText: 'Text', LocalizedPressable: 'Pressable' }, '../lib/theme/ThemeProvider': { useTheme: () => ({ tokens: {} }) },
    './LanguageMenu': { LanguageMenu: 'LanguageMenu' }, './ui': { Btn: 'Btn', Card: 'Card' },
  };
  new Function('require', 'exports', ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText)(
    (name: string) => { assert.ok(name in deps, name); return deps[name]; }, exports);
  let selected = 0, backed = 0;
  const tree = exports.DriverConfirmation({ profile: { id: 'profile-two', display_name: 'Settings', language: 'es', emergency_name: 'Padre', emergency_phone: '+13055550123' },
    onConfirm: () => { selected++; }, onBack: () => { backed++; } });
  const nodes: any[] = [];
  function visit(node: any) { if (!node || typeof node !== 'object') return; if (Array.isArray(node)) { node.forEach(visit); return; } nodes.push(node); visit(node.props?.children); }
  visit(tree);
  assert.equal(selected, 0);
  assert.ok(nodes.some(node => node.type === 'Text' && node.props.localize === false && node.props.children === 'Settings'));
  assert.ok(nodes.some(node => node.type === 'Text' && node.props.children === 'Español'));
  const confirm = nodes.find(node => node.type === 'Btn' && node.props.title === 'Confirm & Continue'); confirm.props.onPress(); confirm.props.onPress();
  assert.equal(selected, 1);
  nodes.find(node => node.type === 'ScreenHeader').props.onBack(); assert.equal(backed, 1);
});

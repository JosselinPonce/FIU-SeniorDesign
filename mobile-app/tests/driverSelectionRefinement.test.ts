import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { URL as NodeURL } from 'node:url';
import ts from 'typescript';
import * as measurements from '../lib/db/profileMeasurements.ts';
import * as summary from '../lib/ui/profileSummary.ts';
import { profileFormValues } from '../lib/db/profileEditing.ts';
import { CONDITIONS, MEDICATIONS, bmiCategory } from '../lib/analysis/profileModel.ts';
import { light, presentationColors } from '../lib/theme/tokens.ts';
import { translateText } from '../lib/i18n/translate.ts';
const require = createRequire(import.meta.url);
const profile = { id: 'driver-a', custom_id: 'INTERNAL-ONLY', display_name: 'Alex Rivera', language: 'es', age: 35,
  emergency_name: 'Saved contact', emergency_phone: '+13055550123', height_cm: 165, weight_kg: 65,
  gender: 'female' as const, conditions: '[]', medications: '[]', created_at: '', updated_at: 'revision-a' };
function nodes(tree: any): any[] {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...nodes(tree.props?.children)];
}
function harness() {
  const hooks: any[] = []; let cursor = 0;
  const selected: any[] = [], saved: any[] = [], help: any[] = [];
  let reloads = 0;
  const deps: Record<string, any> = {
    'expo/node_modules/@expo/vector-icons/Feather': { __esModule: true, default: 'FeatherIcon' },
    react: { createContext: () => ({}), useContext: () => ({ open: (value: unknown) => help.push(value) }),
      useState(initial: any) { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof initial === 'function' ? initial() : initial;
        return [hooks[i], (value: any) => { hooks[i] = typeof value === 'function' ? value(hooks[i]) : value; }]; },
      useRef(value: any) { const i = cursor++; return hooks[i] ??= { current: value }; },
      useEffect(fn: () => void, dependencies: any[]) { const i = cursor++; const previous = hooks[i];
        if (!previous || dependencies.some((value, index) => value !== previous[index])) { hooks[i] = dependencies; fn(); } },
    },
    'react/jsx-runtime': require('react/jsx-runtime'),
    'react-native': { ...Object.fromEntries(['SafeAreaView','ScrollView','View','Modal'].map(name => [name,name])), StyleSheet: { create: (s: any) => s } },
    '../lib/i18n/native': { LocalizedText: 'Text', LocalizedPressable: 'Pressable', LocalizedTextInput: 'TextInput', LocalizedAlert: { alert() { throw Error('Unexpected alert'); } } },
    '../lib/theme/ThemeProvider': { useTheme: () => ({ tokens: light, colors: presentationColors(light) }) },
    '../lib/theme/tokens': { presentationColors }, '../lib/db/profileMeasurements': measurements,
    '../lib/db/profileEditing': { profileFormValues }, '../lib/ui/profileSummary': summary,
    '../lib/analysis/profileModel': { CONDITIONS, MEDICATIONS, bmiCategory },
    '../lib/db/repositories': { getSetting: async () => 'en', parseList: (value: string) => JSON.parse(value),
      updateProfile: async (...args: any[]) => { saved.push(args); } },
    '../lib/db/deletion': { deleteDriverEverywhere() { throw Error('Unexpected deletion'); } },
    '../lib/ui/information': {}, './LanguageMenu': { LanguageMenu: 'LanguageMenu' },
    './ui': { Btn: 'Btn', Card: 'Card', SectionTitle: 'SectionTitle' },
  };
  function load(name: string) {
    const source = readFileSync(new NodeURL('../components/'+name+'.tsx', import.meta.url), 'utf8');
    const exports: any = {};
    new Function('require','exports',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText)(
      (key: string) => { assert.ok(key in deps, key); return deps[key]; }, exports);
    return exports;
  }
  deps['./Information'] = load('Information'); deps['./ScreenHeader'] = load('ScreenHeader');
  const picker = load('DriverPicker').DriverPicker, confirmation = load('DriverConfirmation').DriverConfirmation;
  const profiles = [profile, { ...profile, id: 'driver-b', display_name: 'Blair Test', updated_at: 'revision-b' }];
  return { profiles, selected, saved, help, reloads: () => reloads,
    picker() { cursor = 0; return picker({ profiles, onPick: (value: unknown) => selected.push(value), onCreated: async () => { reloads++; } }); },
    confirmation(props: any) { cursor = 0; return confirmation(props); },
    renderElement(element: any) { return element.type(element.props); },
  };
}

test('profile help scrolls beside the page title while compact navigation retains language access', () => {
  const f = harness(); const tree = f.picker(); const header = tree.props.children[0];
  assert.equal(header.props.title, "Who's driving?"); assert.equal(header.props.right.type, 'LanguageMenu');
  const scroll = tree.props.children[1], heading = scroll.props.children[0];
  assert.equal(heading.props.title, "Who's driving?");
  const rendered = f.renderElement(heading);
  assert.equal(rendered.props.children[0].props.children, "Who's driving?");
  assert.equal(rendered.props.children[1], heading.props.accessory);
  const info = f.renderElement(heading.props.accessory); info.props.onPress();
  assert.deepEqual(f.help, [{ title: 'Driver profiles', body: 'Readings belong to the confirmed driver. Edit profile details before monitoring.' }]);
  assert.equal(nodes(scroll).some(node => node.type === heading.props.accessory.type), false);
  assert.ok(info.props.style.minHeight >= 44 && info.props.style.minWidth >= 44);
  assert.equal(nodes(f.renderElement(header)).some(node => node.props?.accessibilityRole === 'header'), false);
});

test('card selection and internal Edit are sibling targets; editing saves the correct driver without selecting it', async () => {
  const f = harness(); let tree = f.picker();
  const cards = nodes(tree).filter(node => ['driver-a','driver-b'].includes(node.key));
  assert.equal(cards.length, 2);
  for (const card of cards) {
    const [selection, edit] = card.props.children;
    assert.equal(selection.type, 'Pressable'); assert.equal(edit.type, 'Pressable');
    assert.ok(card.props.style.backgroundColor); assert.ok(edit.props.style.minHeight >= 44 && edit.props.style.minWidth >= 44);
    assert.equal(nodes(selection).includes(edit), false);
  }
  cards[0].props.children[0].props.onPress(); assert.deepEqual(f.selected, [f.profiles[0]]);
  cards[1].props.children[1].props.onPress(); assert.equal(f.selected.length, 1);
  tree = f.picker();
  assert.equal(nodes(tree).find(node => node.type === 'TextInput' && node.props.placeholder === 'Name *').props.value, 'Blair Test');
  assert.equal(nodes(tree).some(node => node.props?.placeholder?.includes('Subject')), false);
  await nodes(tree).find(node => node.props?.title === 'Save driver').props.onPress();
  assert.equal(f.saved.length, 1); assert.equal(f.saved[0][0], 'driver-b'); assert.equal(f.saved[0][1].custom_id, 'INTERNAL-ONLY');
  assert.equal(f.saved[0][2], 'revision-b'); assert.equal(f.reloads(), 1); assert.equal(f.selected.length, 1);
  tree = f.picker(); assert.ok(nodes(tree).some(node => node.type === 'Text' && node.props.children === 'Add a driver'));
});

test('compact confirmation keeps navigation and one-shot confirmation while rendering only masked contact digits', () => {
  const f = harness(); const frozen = Object.freeze({ ...profile }); const before = JSON.stringify(frozen);
  let confirmed = 0, edited = 0, backed = 0, actualPhone = '';
  const tree = f.confirmation({ profile: frozen, onConfirm: () => { confirmed++; actualPhone = frozen.emergency_phone; },
    onEdit: () => { edited++; }, onBack: () => { backed++; } });
  const all = nodes(tree), card = all.find(node => node.type === 'Card');
  assert.equal(tree.props.children[0].props.title, 'Confirm driver');
  assert.equal(tree.props.children[0].props.right.type, 'LanguageMenu');
  tree.props.children[0].props.onBack(); assert.equal(backed, 1);
  const edit = nodes(card).find(node => node.type === 'Pressable');
  assert.equal(edit.props.accessibilityLabel, "Edit Alex Rivera's profile"); edit.props.onPress();
  assert.equal(edited, 1); assert.equal(confirmed, 0);
  assert.ok(edit.props.style.minHeight >= 44); assert.ok(edit.props.style.minWidth >= 44);
  assert.equal(nodes(card).some(node => node.type === 'Btn'), false);
  assert.equal(all.filter(node => node.type === 'Btn').length, 1);
  const mask = all.find(node => node.props?.children === '••• ••• 0123');
  assert.equal(mask.props.accessibilityLabel, 'Phone number ending in 0123');
  assert.equal(JSON.stringify(tree).includes(frozen.emergency_phone), false);
  assert.ok(all.some(node => node.props?.children === 'Español'));
  const button = all.find(node => node.props?.title === 'Confirm & Continue'); button.props.onPress(); button.props.onPress();
  assert.equal(confirmed, 1); assert.equal(actualPhone, '+13055550123'); assert.equal(JSON.stringify(frozen), before);
  const name = all.find(node => node.props?.children === frozen.display_name);
  assert.equal(name.props.numberOfLines, undefined); assert.equal(name.props.allowFontScaling, undefined);
});

test('phone masking is display-only and handles missing, short and formatted values conservatively', () => {
  for (const value of [null, undefined, '', '   ']) assert.equal(summary.maskedContactPhone(value), '—');
  for (const value of ['911', '1234', 'invalid']) assert.equal(summary.maskedContactPhone(value), '••••');
  assert.equal(summary.maskedContactPhone('+1 (305) 555-0123'), '••• ••• 0123');
  assert.equal(summary.maskedContactPhone('+34 612 345 678'), '••• ••• 5678');
});

test('new confirmation labels and masked-number accessibility are localized without translating driver data', () => {
  assert.equal(translateText('Confirm your driver', 'es'), 'Confirma tu conductor');
  assert.equal(translateText('Make sure these details are correct.', 'es'), 'Comprueba que estos datos sean correctos.');
  assert.equal(translateText('Selected driver', 'es'), 'Conductor seleccionado');
  assert.equal(translateText('Phone number ending in 0123', 'es'), 'Número de teléfono terminado en 0123');
  assert.equal(translateText('Phone number hidden', 'es'), 'Número de teléfono oculto');
});

test('confirmation uses matching monochrome outline icons rather than emoji, without changing the data rows', () => {
  const f = harness(); const tree = f.confirmation({ profile, onConfirm() {}, onBack() {} });
  const all = nodes(tree);
  const icons = all.filter(node => typeof node.type === 'function' && ['microphone','phone'].includes(node.props?.name));
  assert.deepEqual(icons.map(node => node.props.name), ['microphone','phone']);
  for (const icon of icons) {
    assert.equal(icon.props.color, light.textSecondary);
    const drawn = f.renderElement(icon);
    assert.deepEqual(drawn.props.style, { width: 22, height: 22, flexShrink: 0 });
    if (icon.props.name === 'phone') {
      const phone = drawn.props.children;
      assert.equal(phone.type, 'FeatherIcon'); assert.equal(phone.props.name, 'phone');
      assert.equal(phone.props.size, 22); assert.equal(phone.props.color, light.textSecondary);
      assert.equal(phone.props.allowFontScaling, false);
    }
    assert.equal(drawn.props.pointerEvents, 'none'); assert.equal(drawn.props.accessibilityElementsHidden, true);
    for (const part of nodes(drawn).slice(1)) {
      if (part.props?.style?.borderColor) assert.equal(part.props.style.borderColor, light.textSecondary);
      if (part.props?.style?.backgroundColor && part.props.style.backgroundColor !== 'transparent') assert.equal(part.props.style.backgroundColor, light.textSecondary);
    }
  }
  assert.equal(/[🎙☎]/u.test(JSON.stringify(tree)), false);
  assert.ok(all.some(node => node.props?.children === 'VoiceCheck language'));
  assert.ok(all.some(node => node.props?.children === 'Emergency contact'));
  assert.ok(all.some(node => node.props?.children === '••• ••• 0123'));
});

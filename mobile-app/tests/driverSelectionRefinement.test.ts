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
import * as driverProgress from '../lib/onboarding/driverProgress.ts';
import * as setup from '../lib/onboarding/setup.ts';
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
function harness(initialProfiles = [profile, { ...profile, id: 'driver-b', display_name: 'Blair Test', updated_at: 'revision-b' }]) {
  const hooks: any[] = []; let cursor = 0;
  const selected: any[] = [], saved: any[] = [], help: any[] = [], alerts: any[] = [], used: any[] = [];
  let reloads = 0;
  let profiles = initialProfiles;
  const settings = new Map<string, string>();
  const deletes: string[] = [];
  const drive = {
    driver: null as typeof profile | null, safety: { check: null as unknown, demo: null, conversation: null },
    hasActiveSession: false, setSafetyPresentationEnabled() {}, closeProfileEdit() {},
    selectDriver(value: typeof profile) { drive.driver = value; },
    async beginProfileEdit() { return drive.driver; },
    async leaveDriver() { drive.driver = null; },
  };
  let shellCursor = 0;
  const shellHooks: any[] = [];
  const effects: Array<() => unknown> = [];
  const deps: Record<string, any> = {
    '../lib/buildProfile': { STANDALONE_DEMO: false },
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
    '../lib/i18n/native': { LocalizedText: 'Text', LocalizedPressable: 'Pressable', LocalizedTextInput: 'TextInput', LocalizedAlert: { alert(...args: any[]) { alerts.push(args); } } },
    '../lib/theme/ThemeProvider': { useTheme: () => ({ tokens: light, colors: presentationColors(light) }) },
    '../lib/theme/tokens': { presentationColors }, '../lib/db/profileMeasurements': measurements,
    '../lib/db/profileEditing': { profileFormValues }, '../lib/ui/profileSummary': summary,
    '../lib/analysis/profileModel': { CONDITIONS, MEDICATIONS, bmiCategory },
    '../lib/db/repositories': { getSetting: async () => 'en', parseList: (value: string) => JSON.parse(value),
      createProfile: async (input: any) => {
        const created = { ...profile, ...input, id: 'created', conditions: JSON.stringify(input.conditions), medications: JSON.stringify(input.medications) };
        profiles = [...profiles, created];
        settings.set(driverProgress.driverIntroKey(created.id), driverProgress.newDriverIntro);
        return created;
      },
      listProfiles: async () => profiles,
      setSetting: async (key: string, value: string) => { settings.set(key, value); },
      updateProfile: async (...args: any[]) => { saved.push(args); } },
    '../lib/db/deletion': { async deleteDriverEverywhere(id: string, onLocalDeleted: () => Promise<void>) {
      assert.ok(profiles.some(row => row.id === id));
      deletes.push(id);
      profiles = profiles.filter(row => row.id !== id);
      settings.delete(driverProgress.driverIntroKey(id));
      await onLocalDeleted();
      return 'local';
    } },
    '../lib/i18n/LanguageProvider': { useAppLanguage: () => ({ t: (text: string) => text }) },
    '../lib/ui/information': {}, './LanguageMenu': { LanguageMenu: 'LanguageMenu' },
    './SettingsGroup': { SettingsGroup: 'SettingsGroup', SettingsRow: 'SettingsRow', SettingsNote: 'SettingsNote' },
    './ui': { Btn: 'Btn', Card: 'Card', SectionTitle: 'SectionTitle' },
  };
  function load(name: string, modules = deps, path = 'components/' + name + '.tsx') {
    const source = readFileSync(new NodeURL('../' + path, import.meta.url), 'utf8');
    const exports: any = {};
    new Function('require','exports','__DEV__',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText)(
      (key: string) => { assert.ok(key in modules, key); return modules[key]; }, exports, false);
    return exports;
  }
  deps['./Information'] = load('Information'); deps['./ScreenHeader'] = load('ScreenHeader');
  const picker = load('DriverPicker').DriverPicker, confirmation = load('DriverConfirmation').DriverConfirmation;
  return { get profiles() { return profiles; }, selected, saved, help, alerts, used, drive, deletes, settings,
    reloads: () => reloads,
    remountPicker() { hooks.length = 0; },
    picker(activeDriverId?: string, props = {}) {
      cursor = 0;
      return picker({ profiles, activeDriverId, onUseCreated: (value: any) => used.push(value),
        onPick: (value: unknown) => selected.push(value), onCreated: async () => { reloads++; }, ...props });
    },
    shell() {
      const shellReact = {
        useState(initial: any) {
          const i = shellCursor++; if (!(i in shellHooks)) shellHooks[i] = typeof initial === 'function' ? initial() : initial;
          return [shellHooks[i], (value: any) => { shellHooks[i] = typeof value === 'function' ? value(shellHooks[i]) : value; }];
        },
        useRef(value: any) { return shellHooks[shellCursor++] ??= { current: value }; },
        useCallback(callback: () => unknown) { return callback; },
        useLayoutEffect() {},
        useEffect(callback: () => unknown) { shellCursor++; if (!shellMounted) effects.push(callback); },
      };
      const onboarding = load('setup', { './driverProgress': driverProgress, './setup': setup,
        '../db/repositories': { ...deps['../lib/db/repositories'], getSetting: async (key: string) => settings.get(key) ?? null },
      }, 'lib/onboarding/builtInPhone.ts');
      const components = ['SensiStandby', 'SensiSafetyConversation', 'VitalsDetailView', 'BrandMark',
        'DraggableSensiLauncher', 'DriveProfileMenu', 'DashboardAssistantEntry', 'HistoryView', 'SettingsView', 'Onboarding'];
      const { default: Shell } = load('SmartWheelScreen', {
        ...deps, ...Object.fromEntries(components.map(name => ['./' + name, { [name]: name }])),
        react: shellReact, '../lib/buildProfile': { STANDALONE_DEMO: true },
        'react-native': { ...deps['react-native'], Platform: { OS: 'ios' }, ActivityIndicator: 'ActivityIndicator' },
        'expo-secure-store': {}, 'expo-status-bar': { StatusBar: 'StatusBar' },
        '../lib/assistant/phoneCloudAuth': { sensiCloudAuth: { cachedCredential: () => null } },
        '../lib/assistant/askSensiClient': {}, '../lib/assistant/mode': {},
        '../lib/onboarding/builtInPhone': onboarding,
        '../lib/assistant/sensiStandby': {}, '../lib/ui/dashboard': {},
        '../lib/hooks/useDriveSession': { useDriveSession: () => drive },
        './DriverPicker': { DriverPicker: 'DriverPicker' }, './DriverConfirmation': { DriverConfirmation: 'DriverConfirmation' },
        './DriveView': { DriveView: 'DriveView', VoiceCheckModal: 'VoiceCheckModal' },
      });
      let shellMounted = false;
      function render() {
        shellCursor = 0;
        const tree = Shell();
        if (!shellMounted) {
          shellMounted = true;
          for (const effect of effects) {
            const cleanup = effect();
            if (typeof cleanup === 'function') cleanup();
          }
        }
        return nodes(tree);
      }
      return render;
    },
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
  tree = f.picker(); assert.ok(nodes(tree).some(node => node.type === 'Text' && node.props.children === 'Add New Driver'));
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

test('creating a driver opens the setup route without directly selecting the profile', async () => {
  const f = harness();
  let tree = nodes(f.picker('driver-a'));
  assert.ok(tree.some(n => n.props?.children === 'Active driver'));
  const add = tree.find(n => n.type === 'Pressable' && n.props?.children?.props?.children === 'Add New Driver');
  add.props.onPress();
  tree = nodes(f.picker('driver-a'));
  assert.equal(tree.find(n => n.type?.name === 'ScreenHeader').props.title, 'Create Driver Profile');
  assert.ok(!tree.some(n => ['driver-a', 'driver-b'].includes(n.key)));
  const name = tree.find(n => n.props?.placeholder === 'Name *');
  assert.equal(name.props.value, '');
  name.props.onChangeText('New driver');
  await nodes(f.picker('driver-a')).find(n => n.props?.title === 'Create Profile').props.onPress();
  assert.deepEqual(f.selected, []);
  assert.deepEqual(f.used.map(profile => profile.id), ['created']);
  assert.deepEqual(f.alerts, []);
});

test('create, complete onboarding and delete the new active driver in one mounted shell', async () => {
  for (const remaining of [[], [profile]]) {
    const f = harness(remaining);
    const render = f.shell();
    const find = (name: string) => render().find(node => node.type === name);
    const flush = () => new Promise<void>(resolve => setImmediate(resolve));
    render();
    await flush();
    const picker = find('DriverPicker').props;
    if (remaining.length) {
      nodes(f.picker(undefined, picker)).find(node => node.type === 'Pressable' && node.props.children?.props?.children === 'Add New Driver').props.onPress();
    }
    nodes(f.picker(undefined, picker)).find(node => node.props?.placeholder === 'Name *').props.onChangeText('Synthetic driver');
    await nodes(f.picker(undefined, picker)).find(node => node.props?.title === 'Create Profile').props.onPress();
    await flush();
    const onboarding = find('Onboarding').props;
    assert.equal(onboarding.driverId, 'created');
    assert.equal(f.drive.driver?.id ?? null, null);
    for (let page = 1; page <= 5; page++) await onboarding.controller.go(page);
    await onboarding.controller.acknowledge(true);
    assert.equal(await onboarding.controller.complete(), true);
    onboarding.onDone();
    assert.equal(f.drive.driver?.id, 'created');

    find('DriveProfileMenu').props.onSwitch();
    const activePicker = find('DriverPicker').props;
    const activeRow = nodes(f.picker(undefined, activePicker)).find(node => node.key === 'created');
    activeRow.props.children[1].props.onPress();
    await flush();
    f.remountPicker();
    let editor = find('DriverPicker').props;
    assert.equal(editor.editProfile.id, 'created');
    f.drive.hasActiveSession = true;
    editor = find('DriverPicker').props;
    assert.equal(nodes(f.picker(undefined, editor)).find(node => node.props?.title === 'Delete Driver Profile').props.disabled, true);
    f.drive.hasActiveSession = false;
    editor = find('DriverPicker').props;
    const remove = nodes(f.picker(undefined, editor)).find(node => node.props?.title === 'Delete Driver Profile');
    assert.equal(remove.props.disabled, false);
    remove.props.onPress();
    const confirmation = f.alerts.at(-1)[2].find((action: any) => action.style === 'destructive');
    assert.equal(confirmation.text, 'Delete from this phone');
    f.drive.safety.check = {};
    render();
    await confirmation.onPress();
    assert.deepEqual(f.deletes, []);
    f.drive.safety.check = null;
    render();
    await confirmation.onPress();
    assert.deepEqual(f.deletes, ['created']);
    assert.equal(f.drive.driver?.id ?? null, null);
    assert.equal(f.settings.has(driverProgress.driverIntroKey('created')), false);
    const pickerAfterDelete = find('DriverPicker').props;
    assert.deepEqual(pickerAfterDelete.profiles, remaining);
    assert.equal(pickerAfterDelete.editProfile, undefined);
    if (!remaining.length) {
      const empty = harness([]).picker(undefined, pickerAfterDelete);
      assert.ok(nodes(empty).some(node => node.props?.title === 'Create Profile'));
    }
    await confirmation.onPress();
    assert.deepEqual(f.deletes, ['created']);
  }
});

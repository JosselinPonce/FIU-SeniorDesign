import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { URL as NodeURL } from 'node:url';
import ts from 'typescript';
import { translateText } from '../lib/i18n/translate.ts';
const require = createRequire(import.meta.url);
function harness() {
  const source = readFileSync(new NodeURL('../components/ScreenHeader.tsx', import.meta.url), 'utf8');
  const exports: any = {};
  const deps: Record<string, any> = { 'react/jsx-runtime': require('react/jsx-runtime'), 'react-native': { View: 'View' },
    '../lib/i18n/native': { LocalizedText: 'Text', LocalizedPressable: 'Pressable' }, '../lib/theme/ThemeProvider': { useTheme: () => ({ tokens: {} }) } };
  new Function('require', 'exports', ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }).outputText)(
    (name: string) => { assert.ok(name in deps, name); return deps[name]; }, exports);
  return exports;
}
function nodes(tree: any): any[] {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...nodes(tree.props?.children)];
}
test('persistent navigation has accessible Back without a sticky page heading or fixed height', () => {
  const { ScreenHeader } = harness(); let back = 0;
  const tree = ScreenHeader({ title: 'Safety Testing', onBack: () => { back++; } });
  const button = tree.props.children[0];
  assert.equal(tree.type, 'View'); assert.equal(button.props.accessibilityRole, 'button');
  assert.ok(button.props.style.minHeight >= 44 && button.props.style.minWidth >= 44);
  button.props.onPress(); assert.equal(back, 1);
  assert.equal(button.props.accessibilityHint, 'Back from Safety Testing');
  assert.equal(tree.props.style.height, undefined); assert.equal(tree.props.style.paddingVertical, undefined);
  assert.equal(nodes(tree).some(node => node.props?.accessibilityRole === 'header'), false);
  assert.equal(nodes(tree).some(node => node.type === 'Text' && node.props.children === 'Safety Testing'), false);
});
test('standalone language navigation stays accessible and a branding-only parent gets no redundant fixed bar', () => {
  const { ScreenHeader } = harness(); const language = { type: 'LanguageMenu', props: {} };
  assert.equal(ScreenHeader({ title: 'Settings' }), null);
  const standalone = ScreenHeader({ title: "Who's driving?", right: language });
  assert.equal(standalone.props.children[1], language);
  assert.equal(nodes(standalone).some(node => node.props?.accessibilityRole === 'header'), false);
  assert.equal(translateText('Back from Settings', 'es'), 'Volver desde Ajustes');
});
test('full headings belong to scroll content with wrapping text and adjacent optional help', () => {
  const { ScreenHeading } = harness(); const help = { type: 'Help', props: {} };
  const tree = ScreenHeading({ title: 'Safety Testing', accessory: help });
  const title = tree.props.children[0];
  assert.equal(title.props.accessibilityRole, 'header'); assert.equal(title.props.children, 'Safety Testing');
  assert.equal(title.props.numberOfLines, undefined); assert.equal(tree.props.children[1], help);
  for (const file of ['SettingsView.tsx','DriverPicker.tsx']) {
    const text = readFileSync(new NodeURL('../components/'+file, import.meta.url), 'utf8');
    assert.ok(text.indexOf('<ScreenHeader') < text.indexOf('<ScrollView '), file);
    assert.ok(text.indexOf('<ScreenHeading') > text.indexOf('<ScrollView '), file);
  }
  for (const [file, heading] of [['SensiStandby.tsx', "Hi, I'm Sensi!"], ['DriverConfirmation.tsx','Confirm your driver'], ['VitalsDetailView.tsx','>Detailed Vitals</Text>']] as const) {
    const text = readFileSync(new NodeURL('../components/'+file, import.meta.url), 'utf8');
    assert.ok(text.indexOf(heading) > text.indexOf('<ScrollView '), file);
  }
  const settings = readFileSync(new NodeURL('../components/SettingsView.tsx', import.meta.url), 'utf8');
  assert.equal(settings.includes('<SectionTitle>Sensi Assistant</SectionTitle>'), false);
});

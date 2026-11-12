import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { URL as NodeURL } from 'node:url';
import ts from 'typescript';
import { hasSystemPhoneConfirmation } from '../lib/voice/phoneHandoff.ts';
import { maskedContactPhone } from '../lib/ui/profileSummary.ts';
const require = createRequire(import.meta.url);
for (const supported of [true, false]) test(`demo confirmation: system safeguard=${supported}; no redundant alert and phone is masked`, async () => {
  const confirmed: string[] = [];
  const drive = { safety: { pendingDemoContact: { confirmationId: 'run-confirmation', episodeId: 'demo-episode', phone: '+12025550124', name: 'Saved contact' } },
    confirmRealContactDemo: async (id: string) => { confirmed.push(id); return 'requested'; }, cancelRealContactDemo() {} };
  const deps: Record<string, any> = { react: { useEffect: (fn: () => void) => fn(), useRef: (current: unknown) => ({ current }), useState: () => ['', () => {}] },
    'react/jsx-runtime': require('react/jsx-runtime'), '../lib/i18n/native': { LocalizedText: 'Text' },
    'react-native': { Platform: { OS: 'ios', Version: supported ? 26 : 10 } },
    '../lib/voice/phoneHandoff': { hasSystemPhoneConfirmation }, '../lib/ui/profileSummary': { maskedContactPhone },
    '../lib/theme/ThemeProvider': { useTheme: () => ({ tokens: {} }) }, './ui': { Btn: 'Btn', Card: 'Card', SectionTitle: 'SectionTitle' } };
  const source = readFileSync(new NodeURL('../components/RealContactDemoConfirmation.tsx', import.meta.url), 'utf8');
  const exports: any = {};
  new Function('require','exports',ts.transpileModule(source,{ compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText)(
    (name: string) => { assert.ok(name in deps, name); return deps[name]; }, exports);
  const tree = exports.RealContactDemoConfirmation({ drive });
  if (supported) { assert.equal(tree, null); assert.deepEqual(confirmed, []); return; }
  const nodes = tree.props.children;
  assert.ok(!JSON.stringify(tree).includes(drive.safety.pendingDemoContact.phone));
  const button = nodes.find((n: any) => n?.props?.title === 'Yes, open phone');
  assert.deepEqual(confirmed, []); await button.props.onPress(); assert.deepEqual(confirmed, ['run-confirmation']);
  assert.ok(!source.includes('Alert.alert'));
});

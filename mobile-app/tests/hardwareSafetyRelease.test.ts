import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import ts from 'typescript';

const metroMinify = createRequire(import.meta.url)('metro-minify-terser');

test('Release constant folding removes the hardware test module edges and confirmation UI', async () => {
  for (const [path, marker] of [
    ['lib/hooks/useDriveSession.ts', '../diagnostics/hardwareSafetyTest'],
    ['lib/hooks/useDriveSession.ts', '../diagnostics/homeHardwareDemo'],
    ['lib/hooks/useDriveSession.ts', 'homeDemoWaveform'],
    ['components/DriveView.tsx', './HomeHardwareDemo'],
    ['components/CompactVitalCard.tsx', 'Simulation unavailable'],
    ['components/CompactVitalCard.tsx', 'Actual sensor history'],
    ['components/DriveProfileMenu.tsx', 'Dashboard Mode'],
    ['components/SensiSafetyConversation.tsx', 'Confirm saved test contact'],
    ['components/SensiSafetyConversation.tsx', 'Saying yes or tapping Yes opens the iPhone dialer and may start a real call.'],
    ['components/SensiSafetyConversation.tsx', 'Hardware Demo Mode · Simulated biometric abnormality'],
    ['components/SettingsView.tsx', './HardwareSafetyDiagnostic'],
    ['components/SensiSafetyConversation.tsx', 'Open iPhone Dialer'],
    ['components/SensiSafetyConversation.tsx', 'markConfirmationVisible'],
    ['components/SensiSafetyConversation.tsx', 'markListeningVisible'],
    ['components/SensiSafetyConversation.tsx', 'Request contact handoff again'],
  ] as const) {
    const source = readFileSync(new NodeURL(`../${path}`, import.meta.url), 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022,
    } }).outputText;
    const minify = (dev: boolean) => metroMinify({ code, filename: path, reserved: [],
      config: { compress: { global_defs: { __DEV__: dev }, passes: 2 }, mangle: false } });
    assert.ok((await minify(true)).code.includes(marker), `${path} includes the Debug entry`);
    assert.ok(!(await minify(false)).code.includes(marker), `${path} excludes the Release entry`);
  }
});

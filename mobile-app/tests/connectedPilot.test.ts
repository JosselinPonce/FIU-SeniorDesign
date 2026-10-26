import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import ts from 'typescript';
import { connectedPilotReadiness, connectedUnavailableMessage, CONNECTED_PILOT_UNAVAILABLE } from './retired-ai/lib/assistant/connectedPilotPolicy.ts';
import { CONNECTED_BACKEND_READINESS } from './retired-ai/lib/assistant/connectedReadiness.ts';
import { snapshotAssistantLaunch } from './retired-ai/lib/assistant/mode.ts';

const source = (path: string) => readFileSync(new NodeURL(path, import.meta.url), 'utf8');

test('only exact opt-in on iOS development permits Connected launch; production gate remains frozen off', () => {
  for (const development of [false, true]) for (const platform of ['ios', 'android', 'web'])
    for (const flag of [undefined, '', 'false', 'TRUE', '1', 'true']) {
      const gate = connectedPilotReadiness(development, platform, flag);
      const expected = development && platform === 'ios' && flag === 'true';
      assert.equal(gate.verified, expected); assert.ok(Object.isFrozen(gate));
      assert.equal(snapshotAssistantLaunch('connected', gate).destination, expected ? 'connected' : 'unavailable');
      assert.equal(snapshotAssistantLaunch('local', gate).destination, 'local');
      assert.equal(snapshotAssistantLaunch('core', gate).destination, 'core-tools');
    }
  assert.equal(CONNECTED_BACKEND_READINESS.verified, false);
  assert.equal(snapshotAssistantLaunch('connected').destination, 'unavailable');
});

test('actual phone readiness module enforces __DEV__, platform and the Expo build flag', () => {
  const compiled = ts.transpileModule(source('./retired-ai/lib/assistant/phoneConnectedReadiness.ts'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  for (const [development, platform, flag, expected] of [
    [true, 'ios', 'true', true], [false, 'ios', 'true', false],
    [true, 'android', 'true', false], [true, 'ios', undefined, false],
  ] as const) {
    const exports: Record<string, { verified: boolean }> = {};
    new Function('require', 'exports', '__DEV__', 'process', compiled)((name: string) => {
      if (name === 'react-native') return { Platform: { OS: platform } };
      assert.equal(name, './connectedPilotPolicy'); return { connectedPilotReadiness };
    }, exports, development, { env: { EXPO_PUBLIC_SENSI_CONNECTED_PILOT: flag } });
    assert.equal(exports.PHONE_CONNECTED_READINESS.verified, expected);
  }
});

test('phone launch, dashboard and provider consume the same guarded readiness', () => {
  const shell = source('../components/SmartWheelScreen.tsx');
  assert.doesNotMatch(shell, /<DriverAssistant/);
  assert.doesNotMatch(shell, /PHONE_CONNECTED_READINESS/);
  const entry = source('../components/DashboardAssistantEntry.tsx');
  assert.doesNotMatch(entry, /PHONE_CONNECTED_READINESS|checkDriverAssistantAvailability/);
  assert.match(source('./retired-ai/lib/assistant/phoneAssistantProvider.ts'), /readiness: PHONE_CONNECTED_READINESS/);
  const ui = source('./retired-ai/components/DriverAssistant.tsx');
  assert.match(ui, /props.mode === 'connected' \? connectedUnavailableMessage/);
  assert.match(ui, /Backend access is checked when you send a response/);
});

test('unavailable display never pretends success or leaks backend bodies; other errors retain their existing path', () => {
  for (const message of ['Connected AI is unavailable. Please try again when it is safe.',
    'Invalid Connected AI advisory response.'])
    assert.equal(connectedUnavailableMessage('error', message), CONNECTED_PILOT_UNAVAILABLE);
  assert.match(CONNECTED_PILOT_UNAVAILABLE, /unavailable/); assert.match(CONNECTED_PILOT_UNAVAILABLE, /No automatic retry/);
  assert.equal(connectedUnavailableMessage('complete', 'Connected AI is unavailable.'), undefined);
  assert.equal(connectedUnavailableMessage('error', 'No successful final offline transcript'), undefined);
});

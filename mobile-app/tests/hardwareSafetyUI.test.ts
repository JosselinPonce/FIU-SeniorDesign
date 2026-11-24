import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { URL as NodeURL } from 'node:url';
import ts from 'typescript';
import * as limits from '../lib/diagnostics/personalizedHardwareThreshold.ts';
import { BASELINE_MIN_READINGS } from '../lib/analysis/baseline.ts';

test('Start shows the evaluator blocker and enables as soon as readiness returns', () => {
  const filename = new NodeURL('../components/HardwareSafetyDiagnostic.tsx', import.meta.url);
  const { outputText } = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } });
  const require = createRequire(import.meta.url);
  const exports: any = {};
  const mocks: Record<string, unknown> = {
    react: { useState: (value: unknown) => [value, () => {}], useEffect() {} },
    'react/jsx-runtime': require('react/jsx-runtime'),
    'react-native': { AppState: {}, Switch: 'Switch' },
    '../lib/i18n/native': { LocalizedText: 'Text' },
    './ui': { Btn: 'Btn', Row: 'Row', SectionTitle: 'Heading' },
    '../lib/analysis/baseline': { BASELINE_MIN_READINGS },
    '../lib/diagnostics/personalizedHardwareThreshold': limits,
    './DiagnosticUI': { DiagnosticDetails: 'Details' },
    './SettingsGroup': { SettingsNote: 'Note' },
  };
  new Function('require', 'exports', outputText)((name: string) => { assert.ok(name in mocks, name); return mocks[name]; }, exports);
  for (const [startBlock, expected] of [
    ['baseline', 'A personalized HR baseline is required. Save drives with qualifying readings first.'],
    ['hardware', 'Connect the wheel sensor to start.'],
    ['cooldown', 'Waiting for the 10-second cooldown after the last warning.'],
    ['cleanup', 'Waiting for the previous safety check to finish cleanup.'],
    [null, null],
  ] as const) {
    const nodes = exports.HardwareSafetyDiagnostic({ drive: {
      hardwareTest: { phase: 'idle', count: 0, required: 6, startBlock, contactReady: true },
      hardwareTestControls: {},
      isConnected: startBlock !== 'hardware',
      safety: { monitoring: 'waiting' }, // A separate production status must not re-disable Start.
    } }).props.children;
    assert.equal(nodes.find((node: any) => node?.props.title === 'Start real hardware test').props.disabled, startBlock !== null);
    const status = nodes.find((node: any) => node?.props.label === 'Test status');
    assert.equal(status.props.value, startBlock ? 'Start unavailable' : 'Ready to start');
    if (expected) assert.ok(nodes.some((node: any) => node?.props.children === expected));
  }
  const summary = exports.HardwareSafetyDiagnostic({ drive: {
    driver: { display_name: 'Fixture Driver' },
    baseline: { established: true, bpmP10: 74, bpmMedian: 78, bpmP90: 82 },
    hardwareTest: { phase: 'collecting', startBlock: 'active', contactReady: true, continuityResets: 1,
      limits: { typical: 78, p10: 74, p90: 82, low: 76, high: 80,
        production: { lowWarn: 45, highWarn: 105, lowCrit: 40, highCrit: 131, spo2Warn: 93, spo2Crit: 91 } },
      detection: { filteredBpm: 81, rejected: 2, tracks: [], cooldowns: [] },
    },
    hardwareTestControls: {}, isConnected: true,
  } }).props.children;
  const row = (label: string) => summary.find((node: any) => node?.props.label === label).props.value;
  assert.equal(row('Active driver'), 'Fixture Driver');
  assert.equal(row('Diagnostic HR boundaries'), '≤ 76 / ≥ 80 BPM');
  assert.equal(row('Production HR warning boundaries'), '≤ 45 / ≥ 105 BPM');
  assert.equal(row('Filtered heart rate'), '81 BPM');
  assert.equal(row('Continuity resets'), '1');
});

test('hardware badge replaces Simulation only for the matching real-hardware conversation', () => {
  const source = readFileSync(new NodeURL('../components/SensiSafetyConversation.tsx', import.meta.url), 'utf8');
  assert.match(source, /\(__DEV__ \|\| STANDALONE_DEMO\) && dialogue && drive\.hardwareTest\?\.safety\?\.conversation\?\.episodeId === dialogue\.episodeId/);
  assert.match(source, /dialogue\.simulation && !hardware \? <Text[^]*?>Simulation<\/Text>/);
  assert.match(source, /hardware \? <Text[^]*?>Real Hardware Safety Test<\/Text>/);
  assert.match(source, /\(dialogue\.realContactDemo \|\| homeDemo\) && !hardware \? <Text[^]*?Real-contact demo · iOS confirmation required/);
  assert.match(source, /homeDemo\?\.liveEpisode && check\.question === 'contact_offer'[^]*?may start a real call/);
  assert.match(source, /dialogue\.finished && hardware \?[^]*?Confirm saved emergency contact[^]*?Open iPhone Dialer/);
  assert.match(source, /dialogue\.finished && last\?\.simulation && !hardware && !homeDemo \? <RealContactDemoConfirmation/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acknowledgmentContext, startSafetyAcknowledgment } from '../lib/assistant/safetyAcknowledgment.ts';
import { responsiveness } from '../lib/voice/responsivenessDiagnostics.ts';
const tick = () => new Promise<void>(r => setImmediate(r));
test('runtime empathy diagnostics are opt-in, Debug-only, metadata-only and distinguish skipped from attempted inference', async () => {
  const host = globalThis as typeof globalThis & { __DEV__?: boolean };
  const before = host.__DEV__;
  const context = acknowledgmentContext('bpm_high', 'en', "I'm dizzy");
  try {
    for (const [debug, enabled] of [[false, true], [true, false], [true, true]]) {
      host.__DEV__ = debug; responsiveness.setEnabled(enabled!);
      let generated = 0;
      const skipped = startSafetyAcknowledgment(async () => { generated++; return "I'm sorry you're feeling dizzy."; }, context);
      skipped.get('en'); await tick(); assert.equal(generated, 0);
      const ready = startSafetyAcknowledgment(async () => "I'm sorry you're feeling dizzy.", context);
      await tick(); assert.equal(ready.get('en'), "I'm sorry you're feeling dizzy.");
      const invalid = startSafetyAcknowledgment(async () => 'Call someone.', context);
      await tick(); assert.equal(invalid.get('en'), "I'm sorry to hear that.");
      const records = responsiveness.snapshot();
      if (!debug || !enabled) { assert.equal(records.length, 0); continue; }
      const events = records.flatMap(r => r.events);
      assert.ok(events.some(e => e.point === 'inference skipped'));
      assert.ok(events.some(e => e.point === 'inference attempted'));
      assert.ok(events.some(e => e.details.reason === 'accepted'));
      assert.ok(events.some(e => e.details.reason === 'output_contract_rejected'));
      const serialized = JSON.stringify(records);
      assert.ok(!serialized.includes('dizzy')); assert.ok(!serialized.includes('Call someone.'));
      responsiveness.setEnabled(false); assert.equal(responsiveness.snapshot().length, 0);
    }
  } finally { responsiveness.setEnabled(false); host.__DEV__ = before; }
});

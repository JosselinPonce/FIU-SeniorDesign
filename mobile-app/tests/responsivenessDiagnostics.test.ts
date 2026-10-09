import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResponsivenessRecorder, responsivenessProbe } from '../lib/voice/responsivenessDiagnostics.ts';

test('timing capture is opt-in, monotonic, first-occurrence-only and snapshot isolated', () => {
  let now = 100;
  const recorder = new ResponsivenessRecorder(() => now);
  recorder.begin('warning', 'disabled')('ignored');
  assert.deepEqual(recorder.snapshot(), []);
  recorder.setEnabled(true);
  now = 120;
  const mark = recorder.begin('warning', 'recognition');
  now = 150;
  mark('microphone capture started', { locale: 'en-US' });
  now = 160;
  mark('microphone capture started');
  const snapshot = recorder.snapshot();
  assert.equal(snapshot[0].startedMs, 20);
  assert.equal(snapshot[0].events.length, 1);
  assert.equal(snapshot[0].events[0].elapsedMs, 30);
  snapshot[0].events[0].details.locale = 'changed';
  assert.equal(recorder.snapshot()[0].events[0].details.locale, 'en-US');
});

test('clearing/disabling rejects late callbacks; records and progress are bounded', () => {
  const recorder = new ResponsivenessRecorder(() => 0);
  recorder.setEnabled(true);
  const stale = recorder.begin('assistant', 'old operation');
  recorder.clear();
  stale('late result');
  assert.deepEqual(recorder.snapshot(), []);
  for (let n = 0; n < 100; n++) recorder.begin('assistant', 'playback')('completed');
  assert.equal(recorder.snapshot().length, 80);
  const progress = recorder.begin('assistant', 'recognition');
  for (let n = 0; n < 100; n++) progress(`point ${n}`);
  assert.equal(recorder.snapshot().at(-1)?.events.length, 24);
  recorder.setEnabled(false);
  progress('late event');
  assert.deepEqual(recorder.snapshot(), []);
});

test('release/non-React hosts do not activate the developer probe', () => {
  assert.doesNotThrow(() => responsivenessProbe('assistant', 'noop')('done'));
});

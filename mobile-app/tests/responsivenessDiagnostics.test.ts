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

test('UI commit metadata correlates by capture and remains opt-in and disabled in Release', async () => {
  const { responsiveness, traceVoiceCheckUI } = await import('../lib/voice/responsivenessDiagnostics.ts');
  const host = globalThis as typeof globalThis & { __DEV__?: boolean };
  const previous = host.__DEV__;
  const check = { captureId: 'core-fixture-2', question: 'wellness', phase: 'response_unavailable', fallbackText: 'PRIVATE PROMPT' };
  try {
    host.__DEV__ = false; responsiveness.setEnabled(true);
    traceVoiceCheckUI(check, 'conversation');
    assert.deepEqual(responsiveness.snapshot(), []);
    host.__DEV__ = true;
    traceVoiceCheckUI(check, 'conversation');
    const event = responsiveness.snapshot()[0].events[0];
    assert.equal(event.details.captureId, check.captureId);
    assert.equal(event.details.phase, 'response_unavailable');
    assert.equal(event.details.fallbackText, true);
    assert.equal(JSON.stringify(responsiveness.snapshot()).includes('PRIVATE PROMPT'), false);
    responsiveness.setEnabled(false); traceVoiceCheckUI(check, 'conversation');
    assert.deepEqual(responsiveness.snapshot(), []);
  } finally { responsiveness.setEnabled(false); host.__DEV__ = previous; }
});

test('repeated listening publications retain the unfinished capture chain through delayed completion', async () => {
  let now = 0;
  const recorder = new ResponsivenessRecorder(() => now);
  recorder.setEnabled(true);
  const captureId = 'core-delayed-2';
  const decision = recorder.begin('warning', 'VoiceCheck decision');
  decision('question opened', { captureId, question: 'wellness' });
  const controller = recorder.begin('warning', 'VoiceCheck controller capture');
  controller('capture registered', { captureId });
  const recognition = recorder.begin('warning', 'recognition');
  recognition('audio ownership acquired', { captureId });
  const listening = { captureId, question: 'wellness', phase: 'listening', fallbackText: false };
  recorder.voiceCheckPublication(listening);
  recorder.begin('warning', 'VoiceCheck UI commit')('state committed', listening);
  let complete!: () => void;
  const delayed = new Promise<void>(resolve => { complete = resolve; }).then(() => {
    recognition('native recognition completed', { captureId, status: 'incomplete', reason: 'empty_final_after_partial', hasTranscript: true, hasFinalText: false });
    recognition('adapter outcome', { captureId, status: 'incomplete', usable: false });
    controller('capture settled', { captureId, current: true, captureMatches: true });
    decision('result received', { captureId, status: 'incomplete', usable: false });
    decision('unavailable requested', { captureId, status: 'incomplete' });
  });
  // Far beyond the old 80-record eviction threshold, without wall-clock waiting.
  for (let i = 0; i < 1000; i++) { now += 100; recorder.voiceCheckPublication({ ...listening }); }
  await Promise.resolve();
  assert.equal(recorder.snapshot().length, 5);
  recorder.voiceCheckPublication({ ...listening, phase: 'finalizing' });
  now += 107; complete(); await delayed;
  const unavailable = { ...listening, phase: 'response_unavailable' };
  recorder.voiceCheckPublication(unavailable);
  recorder.begin('warning', 'VoiceCheck UI commit')('state committed', unavailable);
  for (let i = 0; i < 1000; i++) { now += 100; recorder.voiceCheckPublication({ ...unavailable }); }
  decision('answer selected', { captureId, channel: 'none' });
  decision('question closed', { captureId });
  const snapshot = recorder.snapshot();
  assert.equal(snapshot.length, 8);
  assert.equal(snapshot.filter(r => r.operation === 'VoiceCheck UI publication').length, 3);
  for (const point of ['native recognition completed', 'adapter outcome', 'capture settled', 'result received',
    'unavailable requested', 'answer selected', 'question closed']) {
    assert.ok(snapshot.some(r => r.events.some(e => e.point === point && e.details.captureId === captureId)), point);
  }
  assert.ok(snapshot.find(r => r.operation === 'recognition')!.events.at(-1)!.elapsedMs >= 100000);
});

test('publication deduplication preserves capture, question, phase, fallback and return transitions', () => {
  const recorder = new ResponsivenessRecorder(() => 0); recorder.setEnabled(true);
  const first = { captureId: 'core-1-1', question: 'wellness', phase: 'listening' };
  const states: { captureId: string; question: string; phase: string; fallbackText?: boolean }[] = [first, { ...first, captureId: 'core-1-2' },
    { ...first, captureId: 'core-1-2', question: 'contact_offer' },
    { ...first, phase: 'finalizing' }, { ...first, phase: 'response_unavailable' },
    { ...first, fallbackText: true }, { ...first, fallbackText: false },
    { ...first, phase: 'cleared' }, first];
  for (const state of states) {
    recorder.voiceCheckPublication(state);
    recorder.voiceCheckPublication({ ...state });
  }
  const actual = recorder.snapshot().map(r => r.events[0].details);
  assert.deepEqual(actual, states.map(s => ({ ...s, fallbackText: !!s.fallbackText })));
});

test('clearing and enabling reset publication dedup state; disabled input is not retained', () => {
  const recorder = new ResponsivenessRecorder(() => 0);
  const state = { captureId: 'core-reset-1', question: 'wellness', phase: 'listening' };
  recorder.voiceCheckPublication(state); assert.deepEqual(recorder.snapshot(), []);
  recorder.setEnabled(true); recorder.voiceCheckPublication(state);
  assert.equal(recorder.snapshot().length, 1);
  recorder.clear(); recorder.voiceCheckPublication(state);
  assert.equal(recorder.snapshot().length, 1);
  recorder.setEnabled(false); recorder.voiceCheckPublication(state);
  assert.deepEqual(recorder.snapshot(), []);
  recorder.setEnabled(true); recorder.voiceCheckPublication(state);
  assert.equal(recorder.snapshot().length, 1);
});

test('publication helper is Debug-only and opt-in, stores only diagnostic fields, and resets on clear', async () => {
  const { responsiveness, traceVoiceCheckPublication } = await import('../lib/voice/responsivenessDiagnostics.ts');
  const host = globalThis as typeof globalThis & { __DEV__?: boolean };
  const previous = host.__DEV__;
  const details = { captureId: 'core-debug-1', question: 'wellness', phase: 'listening', fallbackText: false,
    transcript: 'PRIVATE DRIVER TEXT', profile: 'PRIVATE PROFILE' };
  try {
    host.__DEV__ = false; responsiveness.setEnabled(true);
    traceVoiceCheckPublication(details); assert.deepEqual(responsiveness.snapshot(), []);
    host.__DEV__ = true; responsiveness.setEnabled(false);
    traceVoiceCheckPublication(details); assert.deepEqual(responsiveness.snapshot(), []);
    responsiveness.setEnabled(true);
    for (let i = 0; i < 1000; i++) traceVoiceCheckPublication(details);
    assert.equal(responsiveness.snapshot().length, 1);
    assert.equal(JSON.stringify(responsiveness.snapshot()).includes('PRIVATE'), false);
    responsiveness.clear(); traceVoiceCheckPublication(details);
    assert.equal(responsiveness.snapshot().length, 1);
  } finally { responsiveness.setEnabled(false); host.__DEV__ = previous; }
});

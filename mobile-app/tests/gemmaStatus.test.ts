import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gemmaStatusLabels } from '../lib/ui/gemmaStatus.ts';
import type { PocState } from '../modules/gemma-poc/controller.ts';
const idle: PocState = { installed: false, loaded: false, busy: false, phase: 'Not checked', error: '', progress: null, response: '', loadMs: null, inferenceMs: null };
test('Gemma status never presents unchecked storage as verified or loaded as inference authorization', () => {
  assert.equal(gemmaStatusLabels(idle).model, 'Not verified in this app session');
  assert.equal(gemmaStatusLabels({ ...idle, loaded: true }).session, 'Model loaded');
  assert.equal(gemmaStatusLabels({ ...idle, installed: true }).model, 'Verified · 241 MB');
});
test('Gemma status keeps release pending until native completion and surfaces cleanup failure', () => {
  assert.equal(gemmaStatusLabels({ ...idle, loaded: true, busy: true, phase: 'Unloading model', cleanupRequired: true }).session, 'Releasing Gemma…');
  assert.equal(gemmaStatusLabels({ ...idle, loaded: true, cleanupRequired: true }).session, 'Needs attention');
  assert.equal(gemmaStatusLabels({ ...idle, error: 'Release failed' }).session, 'Needs attention');
  assert.equal(gemmaStatusLabels(idle).session, 'Not prepared');
});
test('Gemma status distinguishes hashing, preparation and cancellation without starting work', () => {
  assert.equal(gemmaStatusLabels({ ...idle, busy: true, phase: 'Verifying SHA-256' }).session, 'Checking model…');
  assert.equal(gemmaStatusLabels({ ...idle, busy: true, phase: 'Loading model' }).session, 'Preparing Gemma…');
  assert.equal(gemmaStatusLabels({ ...idle, busy: true, phase: 'Stopping' }).session, 'Stopping; waiting for native cleanup…');
});

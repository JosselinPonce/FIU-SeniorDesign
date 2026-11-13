import { test } from 'node:test';
import assert from 'node:assert/strict';
import { symptomScan } from '../lib/voice/symptomLexicon.ts';
import { normalise } from '../lib/voice/intent.ts';

test('affirmative symptom wins', () => {
  assert.deepEqual(symptomScan(normalise("I'm okay but I have a headache")),
    { kind: 'affirmative', hedged: false, categories: ['neural'] });
});
test('all-negated symptoms are negated_only', () => {
  assert.equal(symptomScan(normalise("I'm not dizzy")).kind, 'negated_only');
  assert.equal(symptomScan(normalise('no longer dizzy since I slept')).kind, 'negated_only');
});
test('no symptoms', () => {
  assert.deepEqual(symptomScan(normalise('yes everything is fine')),
    { kind: 'none', hedged: false, categories: [] });
});
test('hedges are reported', () => {
  assert.equal(symptomScan(normalise('maybe I am fine')).hedged, true);
});
test('negation needs proximity (far-away negation does not negate)', () => {
  assert.equal(symptomScan(normalise("I said no to lunch, my head hurts a lot")).kind, 'affirmative');
});
test('Spanish affirmative', () => {
  const s = symptomScan(normalise('me duele la cabeza'));
  assert.equal(s.kind, 'affirmative'); assert.ok(s.categories.includes('neural'));
});
test('Spanish negated', () => { assert.equal(symptomScan(normalise('no estoy mareado')).kind, 'negated_only'); });
test('fatigue-word tokens in English and Spanish', () => {
  const s = symptomScan(normalise('fatigue this evening'));
  assert.equal(s.kind, 'affirmative'); assert.ok(s.categories.includes('fatigue'));
  const es = symptomScan(normalise('cansancio'));
  assert.equal(es.kind, 'affirmative'); assert.ok(es.categories.includes('fatigue'));
});

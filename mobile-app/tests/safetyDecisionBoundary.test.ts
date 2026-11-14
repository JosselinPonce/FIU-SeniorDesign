import { test } from 'node:test';
import assert from 'node:assert/strict';
import { understand, understandCallAnswer } from '../lib/voice/intent.ts';
import { symptomScan } from '../lib/voice/symptomLexicon.ts';

const cases = [
  ["I don't need help but I have a headache", 'not_ok'],
  ['I do not need help I feel under the weather', 'not_ok'],
  ['no necesito ayuda pero me duele la cabeza', 'not_ok'],
  ['quiza estoy bien', 'unclear'], ['quizás estoy bien', 'unclear'],
  ["I think I'm okay", 'unclear'], ['creo que estoy bien', 'unclear'],
  ['I am fine without a headache', 'ok'],
  ['no tengo dolor de cabeza', 'unclear'],
  ['estoy bien sin dolor de cabeza', 'ok'],
  ["I'm okay I'm not dizzy", 'ok'],
  ['estoy bien no estoy mareada', 'ok'],
  ['I am not dizzy', 'unclear'], ['no estoy mareada', 'unclear'],
  ['maybe I feel dizzy', 'not_ok'], ['quizá me siento mareada', 'not_ok'],
  ['I do not need help but maybe I feel dizzy', 'not_ok'],
  ['I had a headache yesterday', 'unclear'],
  ['ayer estaba mareada', 'unclear'],
  ['I was dizzy yesterday but now I am weak', 'not_ok'],
  ['I am fine but my face is drooping', 'unclear'],
  ['I am fine my face is drooping', 'unclear'],
  ['estoy bien pero veo doble', 'unclear'],
  ['I am fine without a headache but I am weak', 'not_ok'],
  ['not dizzy but weak', 'not_ok'],
  ["I don't need help", 'ok'], ['no necesito ayuda', 'ok'],
  ['I am fine', 'ok'], ['sí estoy bien', 'ok'],
  ["I'm good I just had a long day", 'ok'],
  ['I feel dizzy', 'not_ok'], ['me duele la cabeza', 'not_ok'],
] as const;
for (const [text, intent] of cases) test(`final wellness boundary: ${text}`, () => {
  const result = understand(text);
  assert.equal(result.intent, intent);
  assert.equal(result.contactCallRequested, false);
  assert.notEqual(understandCallAnswer(text), 'yes');
});

test('scanner distinguishes present, negated, historical and mixed evidence', () => {
  assert.equal(symptomScan('I have a headache').kind, 'affirmative');
  assert.equal(symptomScan('without a headache').kind, 'negated_only');
  assert.equal(symptomScan('no tengo dolor de cabeza').kind, 'negated_only');
  assert.equal(symptomScan('I had a headache yesterday').kind, 'historical_only');
  assert.equal(symptomScan('I am tired since yesterday').kind, 'affirmative');
  assert.equal(symptomScan('not dizzy but weak').kind, 'affirmative');
  assert.equal(symptomScan('not dizzy weak').kind, 'affirmative');
  assert.equal(symptomScan('No, estoy cansada').kind, 'affirmative');
  assert.equal(symptomScan('No estoy cansada').kind, 'negated_only');
});

test('urgent guidance and explicit contact consent stay separate', () => {
  for (const text of ['call 911', 'llama al 911', 'I might pass out', 'no puedo respirar']) {
    const result = understand(text);
    assert.equal(result.intent, 'not_ok');
    assert.equal(result.urgent, true);
    assert.equal(result.contactCallRequested, false);
  }
  assert.equal(understand('please call my mom').contactCallRequested, true);
  for (const text of ['maybe call my mom', 'no llames a mi mama', 'what if you call my mom']) {
    assert.equal(understand(text).contactCallRequested, false);
  }
});

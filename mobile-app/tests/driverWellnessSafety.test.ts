import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportedDrivingConcern } from '../modules/local-foundation-models/driverWellnessSafety.ts';

test('actual symptom reports and wellness-answer fragments receive deterministic guidance cues', () => {
  for (const text of ["I'm a little dizzy", "I'm feeling faint", 'I feel unwell', 'I feel lightheaded', 'Feeling sick',
    "I don't feel well", "I'm not feeling well", "I'm not feeling okay", "I'm not okay", 'I might faint', "I'm drowsy", "I can't breathe", 'I have chest pain'])
    assert.ok(reportedDrivingConcern(text).symptoms.length, text);
});
test('negated, hypothetical, quoted and other-person statements do not become symptom reports', () => {
  for (const text of ["I'm not dizzy", "I don't feel dizzy", "I'm no longer faint", 'If I feel dizzy call Mom',
    '"I feel dizzy"', 'My mom feels dizzy', 'She is faint', 'I feel fine', "I'm not sick"])
    assert.deepEqual(reportedDrivingConcern(text).symptoms, [], text);
  assert.equal(reportedDrivingConcern("I'm getting worse").worsening, true);
});

test('clear first-person heat discomfort is deterministic, including clauses before contact requests', () => {
  for (const text of ["I'm feeling hot", "I'm overheating.", 'I am overheating', 'I feel very hot', "I'm too hot", "I'm feeling overheated", "I'm feeling hot, can you call my mom?", "I'm overheating and I feel sick"])
    assert.ok(reportedDrivingConcern(text).symptoms.includes('heat_discomfort'), text);
});
test('heat concerns exclude weather, cabin, neutral, negated, quoted, hypothetical and other-person reports', () => {
  for (const text of ['It is hot outside', 'The cabin is overheating', 'My car is hot', 'Hot weather today', 'I feel hot air from the vents',
    "I'm feeling hot air", "I'm not feeling hot", "I'm not overheating", "I'm no longer overheating", "I don't feel hot", "I never feel hot",
    '"I am overheating"', "She said 'I am overheating'", 'If I feel hot call Mom', "Suppose I'm overheating", "I might be overheating",
    'My mother is overheating', 'She feels hot', 'I think the cabin is hot', "I'm feeling fine and the car is hot"])
    assert.deepEqual(reportedDrivingConcern(text).symptoms, [], text);
});

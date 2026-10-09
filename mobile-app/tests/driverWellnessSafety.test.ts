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

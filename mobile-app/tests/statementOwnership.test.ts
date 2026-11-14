import { test } from 'node:test';
import assert from 'node:assert/strict';
import { understand } from '../lib/voice/intent.ts';
import { assertedWellnessClauses, statementSegments } from '../lib/voice/symptomLexicon.ts';
import { semanticCombinedDecision } from '../lib/assistant/safetySemantic.ts';
import { VoiceCheck, type Lang } from '../lib/voice/voiceCheck.ts';
import { recognitionEvidence } from '../lib/voice/coreRecognition.ts';

async function dialogue(lang: Lang, text: string) {
  let captures = 0, semantics = 0;
  const said: string[] = [];
  const check = new VoiceCheck({ cancel() {}, speak: async sentence => { said.push(sentence); },
    listen: async (_lang, _ms, _hints, id) => {
      const answer = captures++ === 0 ? text : lang === 'es' ? 'qué' : 'what';
      return recognitionEvidence(id, { status: 'success', transcript: answer, finalTranscript: answer, isFinal: true, finalResultReceived: true });
    },
  }, lang, '', { contactAvailable: true, startSemantic: () => {
    semantics++;
    return { get: () => ({ state: 'OK', context: 'none', concern: 'no' }), cancel() {}, completion: Promise.resolve() };
  } });
  const result = await check.run('bpm_high');
  return { result, said, semantics, authorized: check.authorizesContact(result) };
}

const complaints = [
  ['en', "I can't breathe", 'she says stay calm', 'she says "stay calm"'],
  ['en', 'my chest hurts', 'my wife told me to relax', 'my wife told me "relax"'],
  ['es', 'no puedo respirar', 'ella dice tranquila', 'ella dice «tranquila»'],
  ['es', 'me duele el pecho', 'ella dijo que todo está bien', 'ella dijo “todo está bien”'],
] as const;
for (const [lang, symptom, report, quotedReport] of complaints) {
  const and = lang === 'en' ? ' and ' : ' y ';
  const but = lang === 'en' ? ' but ' : ' pero ';
  const refusal = lang === 'en' ? 'I do not need help but ' : 'no necesito ayuda pero ';
  for (const text of [symptom + and + report, refusal + symptom + and + report,
    symptom + and + quotedReport, quotedReport + and + symptom,
    report + but + symptom, quotedReport + but + symptom,
    symptom + '. ' + report, report + '. ' + symptom,
    refusal + quotedReport + but + symptom]) {
    test(`driver urgent ownership survives reporting: ${text}`, async () => {
      const u = understand(text);
      assert.equal(u.intent, 'not_ok'); assert.equal(u.urgent, true); assert.equal(u.contactCallRequested, false);
      const f = await dialogue(lang, text);
      assert.equal(f.result.outcome, 'not_ok'); assert.equal(f.result.urgent, true);
      assert.equal(f.semantics, 0); assert.equal(f.authorized, false);
      assert.ok(f.said.includes(lang === 'en' ? 'Pull over as soon as it is safe and call 911 now.' : 'Detente en cuanto sea seguro y llama al 911 ahora.'));
      assert.ok(!f.said.some(s => /Drive safely|Maneja con cuidado/.test(s)));
    });
  }
  test(`unquoted reporting coordination is unresolved: ${report + and + symptom}`, async () => {
    const text = report + and + symptom;
    assert.equal(understand(text).intent, 'unclear'); assert.equal(understand(text).urgent, false);
    assert.ok(statementSegments(text).some(s => s.ownership === 'unresolved'));
    const f = await dialogue(lang, text);
    assert.equal(f.result.outcome, 'no_response'); assert.equal(f.result.urgent, false); assert.equal(f.authorized, false);
  });
}

for (const [lang, text] of [
  ['en', "'I CAN'T BREATHE'"], ['en', '‘I CAN’T BREATHE’'], ['en', '‘I CAN\'T BREATHE’'],
  ['en', '"I CAN’T BREATHE"'], ['en', '“I CAN\'T BREATHE”'], ['en', "'I can't breathe'"],
  ['en', `she said "I can't breathe"`], ['en', "SHE SAID 'I CAN'T BREATHE'"],
  ['es', '«NO PUEDO RESPIRAR»'], ['es', "'NO PUEDO RESPIRAR'"], ['es', '‘NO PUEDO RESPIRAR’'],
  ['es', 'ella dijo "NO PUEDO RESPIRAR"'],
  ['en', "'I CAN'T BREATHE"], ['es', '“NO PUEDO RESPIRAR'],
  ['en', 'she said I cannot breathe and I have chest pain'],
  ['es', 'ella dijo no puedo respirar y tengo dolor en el pecho'],
] as const) test(`quoted/reported/unresolved symptoms cannot own urgent evidence: ${text}`, async () => {
  assert.equal(understand(text).intent, 'unclear'); assert.equal(understand(text).urgent, false);
  assert.deepEqual(assertedWellnessClauses(text), []);
  const f = await dialogue(lang, text);
  assert.equal(f.result.outcome, 'no_response'); assert.equal(f.result.urgent, false); assert.equal(f.authorized, false);
  assert.ok(!f.said.some(s => /call 911 now|llama al 911 ahora|Drive safely|Maneja con cuidado/.test(s)));
  for (const state of ['OK', 'NOT_OK'] as const) {
    assert.equal(semanticCombinedDecision({ event: 'bpm_high', language: lang, statement: text }, { state, context: 'other', concern: 'yes' }).intent, 'unclear');
  }
});

for (const text of ["I CAN'T BREATHE", 'I CAN’T BREATHE', "MY CHEST HURTS AND MY WIFE'S SAYING RELAX"]) {
  test(`word-internal apostrophes are not quotation delimiters: ${text}`, async () => {
    assert.equal(statementSegments(text)[0]?.ownership, 'driver');
    const f = await dialogue('en', text);
    assert.equal(f.result.outcome, 'not_ok'); assert.equal(f.result.urgent, true); assert.equal(f.authorized, false);
  });
}

test('ownership retains earlier driver evidence while later reporting remains ambiguous', async () => {
  const text = "I can't breathe. She said I am fine and I have chest pain";
  assert.deepEqual(statementSegments(text).map(s => s.ownership), ['driver', 'reported', 'unresolved']);
  const f = await dialogue('en', text);
  assert.equal(f.result.outcome, 'not_ok'); assert.equal(f.result.urgent, true); assert.equal(f.semantics, 0);
});

// Ownership boundaries do not depend on enumerating every possible subject name.
for (const [lang, text] of [
  ['en', "I can't breathe and Sarah says stay calm"],
  ['en', 'my chest hurts and his brother told me to rest'],
  ['es', 'no puedo respirar y Ana dice tranquila'],
  ['es', 'me duele el pecho y su hermano dijo tranquila'],
] as const) test(`coordination separates arbitrary reported subjects: ${text}`, async () => {
  const f = await dialogue(lang, text);
  assert.equal(understand(text).urgent, true);
  assert.equal(f.result.outcome, 'not_ok'); assert.equal(f.result.urgent, true); assert.equal(f.semantics, 0); assert.equal(f.authorized, false);
});

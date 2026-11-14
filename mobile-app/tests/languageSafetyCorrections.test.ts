import { test } from 'node:test';
import assert from 'node:assert/strict';
import { understand, understandCallAnswer } from '../lib/voice/intent.ts';
import { symptomScan } from '../lib/voice/symptomLexicon.ts';
import { VoiceCheck, type Lang } from '../lib/voice/voiceCheck.ts';
import { recognitionEvidence } from '../lib/voice/coreRecognition.ts';

async function dialogue(language: Lang, answers: readonly string[]) {
  let captures = 0, semantics = 0;
  const said: string[] = [];
  const check = new VoiceCheck({ cancel() {}, speak: async (text, lang) => {
    assert.equal(lang, language); said.push(text);
  }, listen: async (lang, _ms, _hints, captureId) => {
    assert.equal(lang, language);
    const text = answers[captures++] ?? (language === 'es' ? 'no' : 'no thanks');
    return recognitionEvidence(captureId, { status: 'success', transcript: text, finalTranscript: text, isFinal: true, finalResultReceived: true });
  } }, language, '', { contactAvailable: true, startSemantic: () => {
    semantics++;
    return { get: () => null, cancel() {}, completion: Promise.resolve() };
  } });
  const result = await check.run('bpm_high');
  return { result, captures, semantics, said, authorized: check.authorizesContact(result) };
}

const corrections = [
  ['es', 'estoy bien, no, estoy mareada'],
  ['es', 'estoy bien—no—estoy mareada'],
  ['es', 'estoy bien. ¡No! Estoy mareada.'],
  ['es', 'No, estoy mareada'],
  ['en', "I'm fine—no, I'm dizzy"],
  ['en', "I'm fine, no, I'm weak"],
  ['en', "I'm not dizzy. I feel weak"],
  ['es', 'no estoy mareada, pero estoy débil'],
] as const;
for (const [language, text] of corrections) test(`current concern after a correction/negation: ${text}`, async () => {
  assert.equal(understand(text).intent, 'not_ok');
  assert.equal(understand(text).contactCallRequested, false);
  const f = await dialogue(language, [text]);
  assert.equal(f.result.outcome, 'not_ok'); assert.equal(f.result.attempts, 1);
  assert.equal(f.semantics, 0); assert.equal(f.authorized, false);
  assert.ok(f.said.some(s => /pull over|detente/.test(s)));
  assert.ok(!f.said.some(s => /Drive safely|Maneja con cuidado/.test(s)));
});
for (const [language, text] of [
  ['en', "I'm dizzy—no, I'm fine"], ['es', 'estoy mareada, no, estoy bien'],
  ['en', "I'm fine—no, something is wrong"], ['es', 'estoy bien, no, algo anda mal'],
] as const) test(`a positive or unknown correction does not erase a concern: ${text}`, async () => {
  assert.notEqual(understand(text).intent, 'ok');
  const f = await dialogue(language, [text, language === 'es' ? 'qué' : 'what']);
  assert.notEqual(f.result.outcome, 'ok'); assert.equal(f.authorized, false);
  assert.ok(!f.said.some(s => /Drive safely|Maneja con cuidado/.test(s)));
});

for (const text of ['bien', 'muy bien', 'todo está bien', 'estoy perfectamente bien',
  'me siento muy bien', 'me encuentro bien', 'sí, todo está bien', 'muy bien gracias', 'No, todo está bien']) {
  test(`complete Spanish affirmation resolves once, even with a repeated answer queued: ${text}`, async () => {
    assert.equal(understand(text).intent, 'ok');
    const f = await dialogue('es', [text, text]);
    assert.equal(f.result.outcome, 'ok'); assert.equal(f.result.attempts, 1);
    assert.equal(f.captures, 1); assert.equal(f.semantics, 0); assert.equal(f.authorized, false);
    assert.ok(f.said.includes('Maneja con cuidado.'));
    assert.ok(!f.said.some(s => /No te entendí|911|detente|¿Quieres/.test(s)));
  });
}
for (const text of ['no bien', 'no muy bien', 'no todo está bien', 'no estoy perfectamente bien',
  'no me encuentro perfectamente bien', 'sí no muy bien', 'no necesito ayuda no estoy perfectamente bien']) {
  test(`negated Spanish wellness cannot borrow a positive prefix: ${text}`, async () => {
    assert.equal(understand(text).intent, 'not_ok');
    const f = await dialogue('es', [text]);
    assert.equal(f.result.outcome, 'not_ok'); assert.equal(f.semantics, 0);
    assert.equal(f.authorized, false);
    assert.ok(!f.said.some(s => /Maneja con cuidado/.test(s)));
  });
}
for (const text of ['bien pero veo doble', 'muy bien pero algo no está normal',
  'todo está bien excepto algo raro', 'estoy perfectamente bien pero no sé',
  'quizá estoy perfectamente bien', 'creo que todo está bien']) {
  test(`Spanish positive prefix cannot clear qualification or unknown text: ${text}`, async () => {
    assert.notEqual(understand(text).intent, 'ok');
    const f = await dialogue('es', [text, 'qué']);
    assert.notEqual(f.result.outcome, 'ok'); assert.equal(f.authorized, false);
  });
}

const negations = [
  ['I have no headache', 'unclear'], ['I do not have a headache', 'unclear'],
  ["I don't have a headache", 'unclear'], ['I am fine but I do not have a headache', 'ok'],
  ["I'm fine and I don't have a headache", 'ok'], ['I am fine but I have no headache', 'ok'],
  ['I am fine without a headache', 'ok'], ['I might not have a headache', 'unclear'],
  ['I have no headache but I feel dizzy', 'not_ok'],
  ['I do not have a headache. I feel weak', 'not_ok'],
  ['I have no headache and I feel weak', 'not_ok'],
  ['I have no headache—no, I have a headache', 'not_ok'],
] as const;
for (const [text, intent] of negations) test(`bounded English symptom negation: ${text}`, async () => {
  assert.equal(understand(text).intent, intent);
  assert.equal(understand(text).contactCallRequested, false);
  const f = await dialogue('en', [text, 'what']);
  assert.equal(f.result.outcome, intent === 'unclear' ? 'no_response' : intent);
  assert.equal(f.authorized, false);
  if (intent !== 'unclear') assert.equal(f.semantics, 0);
});

test('raw clause boundaries distinguish corrective no from actual symptom negation', () => {
  assert.equal(symptomScan('estoy bien, no, estoy mareada').kind, 'affirmative');
  assert.equal(symptomScan('estoy bien, no estoy mareada').kind, 'negated_only');
  assert.equal(understand('estoy bien, no estoy mareada').intent, 'ok');
  assert.equal(symptomScan("I'm fine, not dizzy").kind, 'negated_only');
  assert.equal(symptomScan('I do not have a headache').kind, 'negated_only');
  assert.equal(symptomScan('I have no headache but I feel weak').kind, 'affirmative');
});

for (const [language, text] of [
  ['en', "I don't need help but I can't breathe"],
  ['en', "I don't need help I can't breathe"],
  ['en', "I do not need help but my chest hurts"],
  ['en', "I don't need help but I might pass out"],
  ['en', "I don't need help, my chest doesn't hurt, but I can't breathe"],
  ['es', 'no necesito ayuda pero no puedo respirar'],
  ['es', 'no necesito ayuda no puedo respirar'],
  ['es', 'no necesito ayuda pero me duele el pecho'],
  ['es', 'no necesito ayuda pero me voy a desmayar'],
] as const) test(`help refusal cannot suppress independent urgent symptoms: ${text}`, async () => {
  const u = understand(text);
  assert.equal(u.intent, 'not_ok'); assert.equal(u.urgent, true);
  assert.equal(u.contactCallRequested, false); assert.notEqual(understandCallAnswer(text), 'yes');
  const f = await dialogue(language, [text]);
  assert.equal(f.result.outcome, 'not_ok'); assert.equal(f.result.urgent, true);
  assert.equal(f.semantics, 0); assert.equal(f.authorized, false);
  assert.ok(f.said.includes(language === 'en' ? 'Pull over as soon as it is safe and call 911 now.' : 'Detente en cuanto sea seguro y llama al 911 ahora.'));
  assert.ok(!f.said.some(s => /Drive safely|Maneja con cuidado/.test(s)));
});

for (const text of ["I don't need help", "don't call my mom", 'no necesito ayuda', 'no llames a mi mama',
  "I don't need help but I am not having chest pain", "I don't need help but I can breathe",
  "I don't need help, my chest doesn't hurt", "I don't need help, I do not have chest pain",
  'no necesito ayuda, no me duele el pecho', 'no necesito ayuda, no tengo dolor en el pecho',
  "I don't need help, she said I can't breathe", "I don't need help, I had chest pain yesterday",
  'no necesito ayuda, ayer me dolía el pecho', 'no necesito ayuda, ella dijo que no puedo respirar',
  'I do not need help, "I cannot breathe" is a quotation']) {
  test(`help/call refusal alone does not create urgency or consent: ${text}`, () => {
    assert.equal(understand(text).urgent, false);
    assert.equal(understand(text).contactCallRequested, false);
  });
}

for (const [language, text, outcome] of [
  ['es', 'estoy bien, no, estoy mareada', 'not_ok'],
  ['en', "I'm fine—no, I'm dizzy", 'not_ok'],
  ['es', 'bien', 'ok'],
] as const) test(`scoped typed answer uses the same language safety boundary: ${text}`, async () => {
  let scope!: { question: 'wellness' | 'contact_offer'; captureId: string };
  let inference = 0;
  const check = new VoiceCheck({ speak: async () => {}, listen: async () => new Promise(() => {}), cancel() {} }, language, '', {
    onQuestion: (question, captureId) => { scope = { question, captureId }; },
    startSemantic: () => { inference++; throw Error('clear manual answer must not consult a model'); },
  });
  const pending = check.run('bpm_high');
  assert.equal(check.answerByText(text, scope), true);
  const result = await pending;
  assert.equal(result.channel, 'typed'); assert.equal(result.outcome, outcome);
  assert.equal(inference, 0); assert.equal(check.authorizesContact(result), false);
});

// Acceptance-audit boundary hardening: ambiguity must not borrow positive words.
const boundaryCases = [
  ['en', 'no good', 'not_ok', false], ['en', 'not good', 'not_ok', false],
  ['en', 'no good thanks', 'not_ok', false],
  ['en', 'no, good', 'no_response', false], ['en', 'good, no', 'no_response', false],
  ['en', 'good no', 'no_response', false], ['en', 'no good but I am fine', 'not_ok', false],
  ['en', 'good', 'ok', false], ['en', "I'm good", 'ok', false],
  ['es', 'bien', 'ok', false], ['es', 'muy bien', 'ok', false],
  ['es', 'todo está bien', 'ok', false], ['es', 'no muy bien', 'not_ok', false],
  ['es', 'no todo está bien', 'not_ok', false],
  ['en', "I'm good, no, I'm dizzy", 'not_ok', false],
  ['en', "I'm good no I'm dizzy", 'not_ok', false],
  ['es', 'estoy bien, no, estoy mareada', 'not_ok', false],
  ['es', 'estoy bien no estoy mareada pero estoy débil', 'not_ok', false],
  ['en', 'I have no headache', 'no_response', false],
  ['en', 'I have no headache but I feel weak', 'not_ok', false],
  ['en', "I'm fine but I can't breathe", 'not_ok', true],
  ['en', "I don't need help but I can't breathe", 'not_ok', true],
  ['en', `I don't need help, she said "stay calm", but I can't breathe`, 'not_ok', true],
  ['en', `she said "stay calm" but I can't breathe`, 'not_ok', true],
  ['en', "she said stay calm but I can't breathe", 'not_ok', true],
  ['en', `she said "I can't breathe"`, 'no_response', false],
  ['en', "she said I can't breathe", 'no_response', false],
  ['en', `"I can't breathe but I have chest pain"`, 'no_response', false],
  ['en', `she said "stay calm" but I feel dizzy`, 'not_ok', false],
  ['en', "she said stay calm I can't breathe", 'no_response', false],
  ['es', 'no necesito ayuda ella dijo tranquila pero no puedo respirar', 'not_ok', true],
  ['es', 'no necesito ayuda ella dijo "tranquila" pero no puedo respirar', 'not_ok', true],
  ['es', 'ella dijo "no puedo respirar"', 'no_response', false],
  ['es', 'ella dijo no puedo respirar', 'no_response', false],
  ['es', 'ella dijo tranquila pero estoy mareada', 'not_ok', false],
  ['es', 'ella dijo tranquila no puedo respirar', 'no_response', false],
  ['en', `I don't need help, "stay calm", but I can't breathe`, 'not_ok', true],
  ['en', `I don't need help, she said "I can't breathe"`, 'no_response', false],
  ['en', `she said "stay calm" but I am fine`, 'no_response', false],
  ['es', 'bien pero veo doble', 'no_response', false],
  ['en', 'good except the dashboard is purple', 'no_response', false],
  ['en', 'maybe good', 'no_response', false],
  ['en', "no, I'm fine", 'ok', false],
  ['en', "'I can't breathe but I have chest pain'", 'no_response', false],
  ['en', '“I cannot breathe”', 'no_response', false],
  ['es', '«no puedo respirar»', 'no_response', false],
  ['en', `she said 'stay calm' but I can't breathe`, 'not_ok', true],
  ['es', 'ella dijo «tranquila» pero no puedo respirar', 'not_ok', true],

] as const;
for (const [lang, text, expected, urgent] of boundaryCases) test(`hardened assertion boundary: ${text}`, async () => {
  const u = understand(text);
  assert.equal(u.intent, expected === 'no_response' ? 'unclear' : expected);
  assert.equal(u.urgent, urgent);
  assert.equal(u.contactCallRequested, false);
  const f = await dialogue(lang, [text, lang === 'es' ? 'qué' : 'what']);
  assert.equal(f.result.outcome, expected); assert.equal(f.result.urgent, urgent);
  assert.equal(f.authorized, false);
  if (urgent) {
    assert.equal(f.semantics, 0);
    assert.ok(f.said.includes(lang === 'en' ? 'Pull over as soon as it is safe and call 911 now.' : 'Detente en cuanto sea seguro y llama al 911 ahora.'));
  }
  if (expected !== 'ok') assert.ok(!f.said.some(s => /Drive safely|Maneja con cuidado/.test(s)));
});

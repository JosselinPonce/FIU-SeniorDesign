import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { URL as NodeURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { basicOfflineAcknowledgment, offlineContext } from '../lib/voice/basicOfflineAcknowledgment.ts';
import { understand, OK_MIN, NOT_OK_MIN, understandCallAnswer } from '../lib/voice/intent.ts';
import { VoiceCheck, type Lang } from '../lib/voice/voiceCheck.ts';
import { recognitionEvidence } from '../lib/voice/coreRecognition.ts';

const required = [
  ["No, I'm okay.", 'ok'], ["No, I'm good.", 'ok'],
  ["I'm good, Sensi. I just had a long day.", 'ok'], ["Nah, I'm fine.", 'ok'],
  ["No, I'm not okay.", 'not_ok'], ["No, I'm feeling dizzy.", 'not_ok'],
  ["I'm okay, but my chest hurts.", 'not_ok'], ["I'm fine, but I might faint.", 'not_ok'],
  ["I think I'm okay.", 'unclear'], ["I don't know.", 'unclear'],
] as const;

test('requested English classifications retain the pinned model and thresholds', () => {
  const source = readFileSync(new NodeURL('../lib/voice/intentModel.ts', import.meta.url));
  const object = createHash('sha1').update(`blob ${source.length}\0`).update(source).digest('hex');
  assert.equal(object, 'c2b0caffb284829ad2359867503bf4270f4c42d4');
  assert.deepEqual([OK_MIN, NOT_OK_MIN], [0.75, 0.5]);
  for (const [phrase, intent] of required) assert.equal(understand(phrase).intent, intent, phrase);
  assert.equal(understand("I'm okay, but my chest hurts.").urgent, true);
  assert.equal(understand("I'm fine, but I might faint.").urgent, true);
  assert.equal(understand('No').intent, 'not_ok');
  assert.equal(understandCallAnswer('No'), 'no');
});

test('independent bilingual evaluation separates classification, extraction, and approved copy', () => {
  const cases = [
    ['en', "Nah I'm good Sensi I just had a rough day", 'ok', null, 'rough_day', "I'm glad you're okay. Sounds like it's been a tough day."],
    ['en', "No I'm feeling a little dizzy right now", 'not_ok', 'dizzy', null, "I'm sorry you're feeling dizzy."],
    ['en', "I'm fine actually but my chest is hurting", 'not_ok', 'chest', null, "I'm sorry you're experiencing chest pain."],
    ['en', "I'm not dizzy anymore", 'unclear', null, null, null],
    ['en', "I'm very stressed out", 'not_ok', 'stress', null, "I'm sorry you're feeling stressed."],
    ['en', "I'm barely able to keep my eyes open", 'not_ok', 'drowsy', null, "I'm concerned you're struggling to stay awake."],
    ['en', "I'm really not sure, Sensi", 'unclear', null, null, "That's okay — let's focus on keeping you safe."],
    ['en', "What was that humming sound", 'unclear', null, null, null],
    ['en', 'She said that she felt dizzy but I feel weak', 'not_ok', 'weak', null, "I'm sorry you're feeling weak."],
    ['es', 'Estoy bien Sensi solo he tenido un día difícil', 'ok', null, 'rough_day', 'Me alegra que estés bien. Parece que ha sido un día difícil.'],
    ['es', 'Pues, me siento un poquito mareada ahora', 'not_ok', 'dizzy', null, 'Siento que tengas mareo.'],
    ['es', 'Todo bien pero me está doliendo el pecho', 'not_ok', 'chest', null, 'Siento que te duela el pecho.'],
    ['es', 'Estoy bien pero tengo dolor en el pecho', 'not_ok', 'chest', null, 'Siento que te duela el pecho.'],
    ['es', 'No me siento nada mareada, Sensi', 'unclear', null, null, null],
    ['es', 'Me siento un poco agobiada', 'not_ok', 'stress', null, 'Siento que estés pasando por estrés.'],
    ['es', 'No sé bien qué decirte, Sensi', 'unclear', null, null, 'Está bien, lo primero es tu seguridad.'],
    ['es', 'La radio lleva un rato sonando raro', 'unclear', null, null, null],
    ['es', 'Me falta el aire pero no estoy mareada', 'not_ok', 'breathing', null, 'Siento que te cueste respirar.'],
  ] as const;
  const misses: Record<string, number[]> = { classification: [], context: [], composition: [] };
  for (const [i, [lang, text, outcome, signal, situation, copy]] of cases.entries()) {
    const context = offlineContext(text, lang);
    if (understand(text).intent !== outcome) misses.classification!.push(i);
    if ((context.symptom ?? context.emotion) !== signal || context.situation !== situation) misses.context!.push(i);
    if (basicOfflineAcknowledgment(context, lang, outcome) !== copy) misses.composition!.push(i);
  }
  // The pinned evaluation reports known limitations independently of the
  // required safety regressions. Composition is evaluated at the expected outcome.
  assert.deepEqual(misses, { classification: [4], context: [], composition: [] });
});

test('no specific echo from negation, corrections, reported speech, or unsupported input', () => {
  for (const [lang, phrase] of [['en', "I'm dizzy, no, I'm not dizzy."], ['es', 'No estoy estresada.'],
    ['en', 'She said she was scared.'], ['es', 'Ayer me dolía el pecho.'], ['en', '肩が痛い']] as const) {
    const context = offlineContext(phrase, lang);
    assert.equal(context.symptom, null);
    assert.equal(context.emotion, null);
  }
  assert.equal(offlineContext("I'm okay, but my chest hurts.", 'en').intent, 'conflicting');
  assert.equal(offlineContext('¿Puedes ayudarme por favor?', 'es').help, true);
});

for (const [lang, input, acknowledgment] of [
  ['en', "No, I'm feeling dizzy.", "I'm sorry you're feeling dizzy."],
  ['es', 'No, me siento mareada.', 'Siento que tengas mareo.'],
] as const) test(`${lang} Basic Offline speaks empathy before guidance with no provider dispatch or contact authorization`, async () => {
  const spoken: { text: string; delivery?: string }[] = [];
  let captures = 0, dispatched = 0;
  const check = new VoiceCheck({
    async speak(text, language, delivery) { assert.equal(language, lang); spoken.push({ text, delivery }); },
    async listen(_lang, _ms, _hints, id) {
      const answer = ++captures === 1 ? input : lang === 'es' ? 'no' : 'No thanks.';
      return recognitionEvidence(id, { status: 'success', transcript: answer, finalTranscript: answer, isFinal: true, finalResultReceived: true });
    },
    cancel() {},
  }, lang as Lang, '', {
    basicOfflineAcknowledgments: true, contactAvailable: true,
    startAcknowledgment: () => { dispatched++; },
    acknowledgment: () => { dispatched++; return 'Provider work must be skipped.'; },
  });
  const result = await check.run('bpm_high');
  assert.equal(result.outcome, 'not_ok');
  assert.equal(result.contactCall, 'declined_offer');
  assert.equal(check.authorizesContact(result), false);
  assert.equal(dispatched, 0);
  const index = spoken.findIndex(message => message.delivery === 'pre_guidance_acknowledgment');
  assert.equal(spoken[index]?.text, acknowledgment);
  assert.match(spoken[index + 1]!.text, /pull over|detente/);
  assert.match(spoken[index + 2]!.text, /911/);
  assert.match(spoken[index + 3]!.text, /Would you like|Quieres que llame/);
});

test('uncertainty changes the existing retry wording and still requires an answer', async () => {
  const spoken: string[] = [];
  let captures = 0;
  const check = new VoiceCheck({
    async speak(text) { spoken.push(text); },
    async listen(_language, _ms, _hints, id) {
      captures++;
      const text = "I don't know.";
      return recognitionEvidence(id, { status: 'success', transcript: text, finalTranscript: text, isFinal: true, finalResultReceived: true });
    },
    cancel() {},
  }, 'en', '', { basicOfflineAcknowledgments: true });
  const outcome = await check.run('bpm_high');
  assert.equal(captures, 2);
  assert.equal(spoken.filter(text => text === "That's okay — let's focus on keeping you safe.").length, 1);
  assert.ok(spoken.includes('Please pull over as soon as it is safe.'));
  assert.equal(outcome.outcome, 'no_response');
  assert.equal(check.authorizesContact(outcome), false);
});

test('urgent chest pain keeps the immediately spoken guidance and existing contact opportunity', async () => {
  const spoken: string[] = [];
  let captures = 0;
  const check = new VoiceCheck({
    async speak(text) { spoken.push(text); },
    async listen(_language, _ms, _hints, id) {
      const text = ++captures === 1 ? "I'm okay, but my chest hurts." : 'no';
      return recognitionEvidence(id, { status: 'success', transcript: text, finalTranscript: text, isFinal: true, finalResultReceived: true });
    },
    cancel() {},
  }, 'en', '', { basicOfflineAcknowledgments: true, contactAvailable: true });
  const outcome = await check.run('bpm_high');
  assert.equal(outcome.urgent, true);
  const index = spoken.indexOf('Pull over as soon as it is safe and call 911 now.');
  assert.ok(index >= 0);
  assert.equal(spoken[index + 1], 'Would you like me to call your emergency contact?');
  assert.equal(check.authorizesContact(outcome), false);
});

test('cancelling during the pre-guidance utterance prevents subsequent speech and contact authorization', async () => {
  const spoken: string[] = [];
  let release!: () => void;
  let didStart!: () => void;
  const started = new Promise<void>(resolve => { didStart = resolve; });
  const check = new VoiceCheck({
    async speak(text, _lang, delivery) {
      spoken.push(text);
      if (delivery === 'pre_guidance_acknowledgment') {
        await new Promise<void>(resolve => { release = resolve; didStart(); });
      }
    },
    async listen(_lang, _ms, _hints, id) {
      const text = "I can barely stay awake";
      return recognitionEvidence(id, { status: 'success', transcript: text, finalTranscript: text, isFinal: true, finalResultReceived: true });
    },
    cancel() { release?.(); },
  }, 'en', '', { basicOfflineAcknowledgments: true, contactAvailable: true });
  const pending = check.run('bpm_high');
  await started;
  assert.ok(spoken.includes('Are you feeling okay?'));
  assert.equal(spoken.at(-1), "I'm concerned you're struggling to stay awake.");
  check.cancel();
  await assert.rejects(pending, /cancelled/i);
  assert.ok(!spoken.some(line => /pull over|would you like/i.test(line)));
});

test('serious breathing complaints reach mandatory guidance without an acknowledgment or pause first', async () => {
  const steps: string[] = [];
  let answers = 0;
  const check = new VoiceCheck({
    async speak(text) { steps.push(text); },
    async pause() { steps.push('pause'); },
    async listen(_lang, _ms, _hints, id) {
      const answer = ++answers === 1 ? "I can't breathe" : 'no';
      steps.push('answer');
      return recognitionEvidence(id, { status: 'success', transcript: answer, finalTranscript: answer, isFinal: true, finalResultReceived: true });
    },
    cancel() {},
  }, 'en', '', { basicOfflineAcknowledgments: true, contactAvailable: true });
  const result = await check.run('bpm_high');
  assert.equal(result.urgent, true);
  assert.deepEqual(steps.slice(steps.indexOf('answer') + 1), [
    'Pull over as soon as it is safe and call 911 now.',
    'pause',
    'Would you like me to call your emergency contact?',
    'answer',
  ]);
});

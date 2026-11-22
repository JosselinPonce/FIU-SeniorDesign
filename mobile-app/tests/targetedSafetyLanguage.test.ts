import assert from 'node:assert/strict';
import { test } from 'node:test';
import { understand } from '../lib/voice/intent.ts';
import { offlineContext, basicOfflineAcknowledgment } from '../lib/voice/basicOfflineAcknowledgment.ts';
import { recognitionEvidence } from '../lib/voice/coreRecognition.ts';
import { VoiceCheck } from '../lib/voice/voiceCheck.ts';

const cases = [
  ['Me está doliendo el pecho', 'not_ok', true],
  ['Me sigue doliendo el pecho ahora mismo', 'not_ok', true],
  ['Sí me está doliendo el pecho', 'not_ok', true],
  ['No, me está doliendo el pecho', 'not_ok', true],
  ['Todo bien, pero me está doliendo el pecho', 'not_ok', true],
  ['Ella dice que no pasa nada, pero me está doliendo el pecho', 'not_ok', true],
  ['Mi mamá dice que ella está bien. Me sigue doliendo el pecho', 'not_ok', true],
  ['Estoy bien, no me está doliendo el pecho', 'unclear', false],
  ['No me está doliendo el pecho', 'unclear', false],
  ['Ya no me sigue doliendo el pecho', 'unclear', false],
  ['Me estaba doliendo el pecho anoche', 'unclear', false],
  ['Si me está doliendo el pecho, ¿qué hago?', 'unclear', false],
  ['En caso de que me esté doliendo el pecho, ¿qué hago?', 'unclear', false],
  ['Ella dijo: «Me está doliendo el pecho»', 'unclear', false],
  ['A mi hermano le está doliendo el pecho', 'unclear', false],
  ['Mi hermano tiene dolor en el pecho', 'unclear', false],
  ['No sé si me está doliendo el pecho', 'unclear', false],
  ['Si tengo dolor en el pecho, ¿qué hago?', 'unclear', false],
  ["I'm barely able to keep my eyes open", 'not_ok', false],
  ["I'm okay, but I keep nodding off while driving", 'not_ok', false],
  ["I'm not dizzy, but I'm having trouble staying awake", 'not_ok', false],
  ['No me duele la cabeza pero me cuesta mantenerme despierta', 'not_ok', false],
  ["I'm having trouble staying awake", 'not_ok', false],
  ["I'm fighting to stay awake right now", 'not_ok', false],
  ['Me está costando mantenerme despierto', 'not_ok', false],
  ['Me cuesta mucho mantenerme despierta ahora mismo', 'not_ok', false],
  ['Estoy bien, pero apenas puedo mantener los ojos abiertos', 'not_ok', false],
  ['Se me están cerrando los ojos al volante', 'not_ok', false],
  ["I'm not struggling to stay awake", 'unclear', false],
  ['No estoy luchando por mantenerme despierta', 'unclear', false],
  ['Si no puedo mantenerme despierto, ¿qué hago?', 'unclear', false],
  ['Mi amigo dijo: «Me cuesta mantenerme despierto»', 'unclear', false],
  ["My partner is fighting to stay awake", 'unclear', false],
  ["I'm fine, Sensi. I just had a long day.", 'ok', false],
  ['Estoy bien Sensi solo he tenido un día difícil', 'ok', false],
  ['Estoy bien, ha sido un día largo', 'ok', false],
  ['No sé si estoy bien. Ha sido un día difícil', 'unclear', false],
  ["I'm very stressed out", 'unclear', false],
  ['No sé si estoy bien, tengo mucho estrés', 'unclear', false],
] as const;

for (const [phrase, intent, urgent] of cases) test(`targeted coverage: ${phrase}`, () => {
  const result = understand(phrase);
  assert.deepEqual([result.intent, result.urgent, result.contactCallRequested], [intent, urgent, false]);
});

test('grounded stress can change clarification wording without establishing wellbeing', () => {
  for (const [lang, text] of [['en', "I'm under a lot of stress"], ['es', 'Tengo mucho estrés']] as const) {
    const context = offlineContext(text, lang);
    assert.equal(context.emotion, 'stress');
    assert.ok(basicOfflineAcknowledgment(context, lang, 'unclear'));
    assert.notEqual(understand(text).intent, 'ok');
  }
  const conditional = offlineContext('Si me está doliendo el pecho, ¿qué hago?', 'es');
  assert.equal(conditional.symptom, null);
});

test('Spanish progressive chest complaint proceeds directly to urgent guidance and the existing contact question', async () => {
  const speech: string[] = [];
  const answers = ['Todo bien, pero me está doliendo el pecho', 'no'];
  const check = new VoiceCheck({
    async speak(text) { speech.push(text); },
    async listen(_language, _duration, _hints, id) {
      const answer = answers.shift() ?? '';
      return recognitionEvidence(id, { status: 'success', transcript: answer, finalTranscript: answer, isFinal: true, finalResultReceived: true });
    },
    cancel() {},
  }, 'es', '', { contactAvailable: true, basicOfflineAcknowledgments: true });
  const result = await check.run('bpm_high');
  const urgent = speech.indexOf('Detente en cuanto sea seguro y llama al 911 ahora.');
  assert.ok(urgent >= 0);
  assert.equal(speech[urgent + 1], '¿Quieres que llame a tu contacto de emergencia?');
  assert.equal(result.contactCall, 'declined_offer');
  assert.equal(check.authorizesContact(result), false);
});

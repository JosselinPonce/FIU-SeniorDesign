import { test } from 'node:test';
import assert from 'node:assert/strict';
import { understand } from '../lib/voice/intent.ts';
import { VoiceCheck } from '../lib/voice/voiceCheck.ts';
import { recognitionEvidence, type CoreRecognition } from '../lib/voice/coreRecognition.ts';

const cases = [
  ['en', "I'm OK thank you Sensi", 'ok'],
  ['en', "I'm fine, thank you", 'ok'],
  ['en', "I'm good", 'ok'],
  ['en', "No, I'm okay", 'ok'],
  ['en', 'No, nothing is wrong', 'ok'],
  ['en', "I'm not feeling well", 'not_ok'],
  ['en', "I don't think I'm okay", 'not_ok'],
  ['en', "I'm fine, but I can't focus", 'not_ok'],
  ['en', "I'm okay, my vision just went dark", 'not_ok'],
  ['en', "I'm okay thank you Sensi but my chest hurts", 'not_ok', true],
  ['en', "I'm okay thank you Sensi but I'm not feeling well", 'not_ok'],
  ['en', 'Could be better', 'unclear'],
  ['en', "I'm feeling better now", 'unclear'],
  ['en', "I'm feeling better now and yes", 'unclear'],
  ['en', "I'm feeling better now and I'm not okay", 'not_ok'],
  ['en', "I'm okay and I'm feeling better now", 'ok'],
  ['en', "I'm having trouble breathing", 'not_ok', true],
  ['en', "I can't breathe", 'not_ok', true],
  ['en', 'I can breathe', 'unclear'],
  ['en', "I'm not having trouble breathing", 'unclear'],
  ['en', "I don't have chest pain", 'unclear'],
  ['en', 'My chest hurts', 'not_ok', true],
  ['en', 'I had chest pain yesterday', 'unclear'],
  ['en', 'I had chest pain a week ago', 'unclear'],
  ['en', "Since yesterday I've had chest pain", 'not_ok', true],
  ['en', "I can't catch my breath", 'not_ok', true],
  ['en', "I'm fine, but my chest hurts", 'not_ok', true],
  ['en', "I don't have chest pain but I can't breathe", 'not_ok', true],
  ['en', 'I had chest pain yesterday but my chest hurts now', 'not_ok', true],
  ['en', "I can't breathe now I had chest pain yesterday", 'not_ok', true],
  ['en', "I had chest pain yesterday I can't breathe now", 'not_ok', true],
  ['en', "I don't need help but I'm having trouble breathing", 'not_ok', true],
  ['en', 'I can breathe but I feel dizzy', 'not_ok'],
  ['en', "I'm not really very dizzy", 'unclear'],
  ['es', 'Sí, estoy bien.', 'ok'],
  ['es', 'Estoy bien, gracias.', 'ok'],
  ['es', 'No, estoy bien.', 'ok'],
  ['es', 'No estoy bien.', 'not_ok'],
  ['es', 'No estoy bien gracias', 'not_ok'],
  ['es', 'No, nada anda mal.', 'ok'],
  ['es', 'Estoy mareada.', 'not_ok'],
  ['es', 'No estoy mareada.', 'unclear'],
  ['es', 'No estoy muy muy mareada.', 'unclear'],
  ['es', 'Me duele el pecho.', 'not_ok', true],
  ['es', 'No me duele el pecho.', 'unclear'],
  ['es', 'Tuve dolor en el pecho ayer.', 'unclear'],
  ['es', 'Desde ayer me duele el pecho.', 'not_ok', true],
  ['es', 'No puedo respirar bien.', 'not_ok', true],
  ['es', 'No me duele el pecho no puedo respirar', 'not_ok', true],
  ['es', 'Sí puedo respirar.', 'unclear'],
  ['es', 'Estoy bien, pero no puedo concentrarme.', 'not_ok'],
  ['es', 'Estoy bien pero no puedo concentrarme', 'not_ok'],
  ['es', 'Ya me siento mejor.', 'unclear'],
  ['es', 'Ya me siento mejor y estoy bien.', 'ok'],
  ['es', 'No, estoy bien, pero me duele el pecho.', 'not_ok', true],
] as const;

for (const [lang, text, expected, urgent = false] of cases) {
  test(`natural wellness (${lang}): ${text}`, () => {
    const result = understand(text);
    assert.equal(result.intent, expected);
    assert.equal(result.urgent, urgent);
    assert.equal(result.contactCallRequested, false);
  });
}

for (const [lang, text, expected, urgent = false] of cases.filter(item => [
  "I'm OK thank you Sensi", "I don't think I'm okay", 'Could be better', "I'm having trouble breathing",
  'No, nada anda mal.', 'No estoy bien gracias', 'No puedo respirar bien.', 'Ya me siento mejor.',
].includes(item[1]))) {
  test(`typed and finalized voice agree (${lang}): ${text}`, async () => {
    for (const channel of ['voice', 'typed'] as const) {
      const spoken: string[] = [];
      let check: VoiceCheck;
      let semanticCalls = 0;
      check = new VoiceCheck({
        speak: async sentence => { spoken.push(sentence); },
        listen: async (_lang, _ms, _hints, id) => recognitionEvidence(id, {
          status: 'success', transcript: text, finalTranscript: text, isFinal: true, finalResultReceived: true,
        }),
        cancel() {},
      }, lang, '', {
        startSemantic: () => { semanticCalls++; throw Error('Semantic classification is disabled'); },
        onQuestion(question, captureId) {
          assert.equal(question, 'wellness');
          if (channel === 'typed') assert.equal(check.answerByText(text, { question, captureId }), true);
        },
      });
      const result = await check.run('bpm_high');
      assert.equal(result.outcome, expected === 'unclear' ? 'no_response' : expected);
      assert.equal(result.urgent, urgent);
      assert.equal(result.channel, expected === 'unclear' ? 'none' : channel);
      assert.equal(check.authorizesContact(result), false);
      assert.equal(semanticCalls, 0);
      if (expected === 'unclear') {
        assert.equal(result.attempts, 2);
        assert.ok(spoken.some(line => /couldn't understand|no pude entender/i.test(line)));
      }
    }
  });
}

for (const status of ['partial', 'stale', 'cancelled', 'empty', 'timeout'] as const) {
  test(`${status} voice evidence never clears a check`, async () => {
    const text = status === 'empty' ? '' : "I'm OK thank you Sensi";
    const check = new VoiceCheck({
      speak: async () => {},
      listen: async (_lang, _ms, _hints, id) => recognitionEvidence(id, {
        status: ['partial', 'empty'].includes(status) ? 'success' : status as CoreRecognition['status'],
        transcript: text, finalTranscript: text, isFinal: status !== 'partial', finalResultReceived: status !== 'partial',
      }),
      cancel() {},
    }, 'en', '');
    const result = await check.run('bpm_high');
    assert.equal(result.outcome, 'no_response');
    assert.equal(result.attempts, 2);
    assert.equal(check.authorizesContact(result), false);
  });
}

for (const [offer, expected, authorized] of [
  ['No, thanks', 'declined_offer', false], ['Yes, please', 'accepted_offer', true],
] as const) {
  test(`indirect distress still requires a separate saved-contact answer: ${offer}`, async () => {
    const captures: string[] = [];
    let question: 'wellness' | 'contact_offer' = 'wellness';
    const check = new VoiceCheck({
      speak: async () => {},
      listen: async (_lang, _ms, _hints, id) => {
        captures.push(id);
        const text = question === 'wellness' ? "I don't think I'm okay" : offer;
        return recognitionEvidence(id, {
          status: 'success', transcript: text, finalTranscript: text, isFinal: true, finalResultReceived: true,
        });
      },
      cancel() {},
    }, 'en', '', {
      contactAvailable: true,
      onQuestion(activeQuestion) { question = activeQuestion; },
    });
    const result = await check.run('bpm_high');
    assert.equal(result.outcome, 'not_ok');
    assert.equal(result.contactCall, expected);
    assert.equal(check.authorizesContact(result), authorized);
    assert.equal(captures.length, 2);
    assert.notEqual(captures[0], captures[1]);
  });
}

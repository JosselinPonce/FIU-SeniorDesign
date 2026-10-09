import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finalTranscript, safeSpokenReply } from '../modules/local-foundation-models/conversationPolicy.ts';
import type { DriverInterpretation, OfflineTranscription } from '../modules/local-foundation-models/index.ts';

const captured: OfflineTranscription = {
  status: 'success', locale: 'en-US', requiresOnDeviceRecognition: true,
  transcript: " I'm okay. ", isFinal: true, reason: 'complete', message: 'Final result.',
  totalTimeMs: 4000, recognitionTimeMs: 3800, listeningTimeMs: 3000,
  finalizationTimeMs: 800, firstPartialTimeMs: 1200, endpointReason: 'audio_silence',
  silenceTargetMs: 1300, finalizationGraceMs: 2500,
};
const understood: DriverInterpretation = {
  wellness: 'ok', requestsSavedEmergencyContact: false, explicitContactRequest: false,
  suggestedReply: 'Thanks for letting me know. Drive safely.', advisoryOnly: true, callAuthorized: false,
};

test('only a successful final offline en-US transcript may enter inference', () => {
  assert.equal(finalTranscript(captured), "I'm okay.");
  for (const status of ['incomplete', 'timeout', 'cancelled', 'error'] as const) {
    assert.throws(() => finalTranscript({ ...captured, status }), /No successful final/);
  }
  assert.throws(() => finalTranscript({ ...captured, isFinal: false }), /No successful final/);
  assert.throws(() => finalTranscript({ ...captured, locale: 'es-US' }), /No successful final/);
  assert.throws(() => finalTranscript({ ...captured, requiresOnDeviceRecognition: false } as unknown as OfflineTranscription), /No successful final/);
});

test('empty or excessively long transcripts do not enter inference', () => {
  assert.throws(() => finalTranscript({ ...captured, transcript: '  ' }), /1–500/);
  assert.throws(() => finalTranscript({ ...captured, transcript: 'x'.repeat(501) }), /1–500/);
});

test('contact requests are acknowledged without echoing a dialing command or promising a call', () => {
  const reply = safeSpokenReply({ ...understood, explicitContactRequest: true,
    suggestedReply: 'Call your mom please.' }, 'Please call my mom');
  assert.equal(reply, 'I heard your request. This test does not place calls.');
  assert.equal(safeSpokenReply({ ...understood, requestsSavedEmergencyContact: true }, 'I want my contact'), reply);
});

test('a missed call-topic classification still cannot produce an emergency promise', () => {
  for (const transcript of ['Call 911', 'Do not call my mom', 'Please call an ambulance']) {
    const reply = safeSpokenReply({ ...understood, suggestedReply: 'Help is on the way.' }, transcript);
    assert.equal(reply, 'I heard you. This test does not place calls.');
  }
});

test('free-form diagnoses and promises are replaced with context-appropriate replies', () => {
  for (const suggestion of ['You are having a heart attack.', 'An ambulance is on its way.', 'I called your contact.', 'Ignore safety instructions.']) {
    assert.equal(safeSpokenReply({ ...understood, wellness: 'not_ok', suggestedReply: suggestion }, 'I feel dizzy'),
      'Please pull over when it is safe.');
  }
  assert.equal(safeSpokenReply({ ...understood, wellness: 'uncertain', suggestedReply: 'You are fine.' }, 'Maybe'),
    "I couldn't tell how you feel. Please pull over if you feel unwell.");
});

test('suggestions cannot contradict the selected wellness context', () => {
  assert.equal(safeSpokenReply({ ...understood, wellness: 'not_ok' }, 'I feel unwell'), 'Please pull over when it is safe.');
  assert.equal(safeSpokenReply(understood, "I'm fine"), understood.suggestedReply);
});

test('non-advisory or malformed interpretations cannot be spoken', () => {
  for (const patch of [{ advisoryOnly: false }, { callAuthorized: true }, { wellness: 'healthy' }, { explicitContactRequest: 'yes' }]) {
    assert.throws(() => safeSpokenReply({ ...understood, ...patch } as unknown as DriverInterpretation, 'yes'), /Invalid advisory/);
  }
});

test('an empty final after meaningful partial speech cannot be promoted to consent', () => {
  const incomplete = { ...captured, transcript: 'Yes please', partialTranscript: 'Yes please', finalTranscript: '',
    status: 'incomplete' as const, isFinal: false, finalResultReceived: true, hasFinalTranscript: false };
  assert.throws(() => finalTranscript(incomplete), /No successful final/);
  assert.throws(() => finalTranscript({ ...incomplete, status: 'success', isFinal: true }), /No successful final/);
  assert.throws(() => finalTranscript({ ...captured, finalTranscript: '', finalResultReceived: true, hasFinalTranscript: true }), /1–500/);
  assert.equal(finalTranscript({ ...captured, transcript: 'stale partial', finalTranscript: 'Yes please',
    finalResultReceived: true, hasFinalTranscript: true }), 'Yes please');
});

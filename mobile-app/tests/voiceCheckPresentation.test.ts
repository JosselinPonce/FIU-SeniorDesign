import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listeningPresentation, voiceCheckSpokenText } from '../lib/voice/voiceCheckPresentation.ts';
import { VoiceCheck } from '../lib/voice/voiceCheck.ts';

test('listening indicator requires actual listening, and stops on cancellation or finalization', () => {
  for (const language of ['en', 'es'] as const) {
    for (const phase of ['speaking', 'preparing', 'ready', 'finalizing', 'response_unavailable', undefined]) {
      assert.equal(listeningPresentation(true, phase, language).visible, false);
    }
    assert.equal(listeningPresentation(true, 'listening', language).visible, true);
    assert.equal(listeningPresentation(false, 'listening', language).visible, false);
  }
  assert.match(listeningPresentation(true, 'listening', 'es').label, /escuchando/i);
});

test('emergency guidance is numeric while TTS retains natural English and Spanish pronunciation', async () => {
  for (const language of ['en', 'es'] as const) {
    const displayed: string[] = [];
    const check = new VoiceCheck({ speak: async text => { displayed.push(text); }, listen: async () => null, cancel() {} }, language, '', { contactAvailable: false });
    // Manual answer avoids recognition fixtures and keeps the presentation test deterministic.
    const running = check.run('bpm_high');
    check.answerByButton('not_ok');
    await running;
    const guidance = displayed.find(text => text.includes('911'));
    assert.ok(guidance);
    assert.doesNotMatch(guidance, /nine one one|nueve uno uno/);
    assert.match(voiceCheckSpokenText(guidance, language), language === 'es' ? /nueve uno uno/ : /nine one one/);
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { connectedConversationalReply as reply } from '../modules/local-foundation-models/connectedConversationPolicy.ts';
import { conversationalReply } from '../modules/local-foundation-models/conversationPolicy.ts';
import { PULL_OVER_GUIDANCE } from '../modules/local-foundation-models/driverWellnessSafety.ts';
import type { DriverInterpretation } from '../modules/local-foundation-models/index.ts';
import { parseProviderResponse } from '../supabase/functions/driver-assistant/provider.ts';
import { connectedAdvisory } from '../lib/assistant/connectedProvider.ts';

const advisory = (suggestedReply: string): DriverInterpretation => ({
  wellness: 'uncertain', suggestedReply, advisoryOnly: true, callAuthorized: false,
  explicitContactRequest: false, requestsSavedEmergencyContact: false,
});
const natural = ["That's great to hear! Stay focused and drive safely.", "That's wonderful news!",
  'Take care.', "You're welcome.", 'Keep your attention on the road.',
  'If you feel tired, pull over when it is safe.', 'Take a break when it is safe to do so.',
  'Thanks for sharing. How are you feeling now?'];

test('Connected permits natural acknowledgements and safe reminders without a word allowlist', () => {
  for (const text of natural) assert.deepEqual(reply(advisory(text)), { text, usedFallback: false });
});

test('Connected rejects action claims, medical advice, unsafe driving and symptom dismissal', () => {
  for (const text of ['I called your contact.', 'Help is on the way.', 'I dispatched an ambulance.',
    'Your mom has been notified.', 'Emergency help has been arranged.', 'I have your consent.',
    'You are having a heart attack.', 'Take aspirin.', 'Take medication.', 'You are dehydrated.',
    'Drink water to cure your dizziness.', 'Drink water.', 'Take insulin.', 'Hold your breath.', 'Keep driving.', 'Continue your trip.',
    'You are safe to drive.', 'You seem perfectly healthy.', 'Do not pull over.',
    'You don’t need to stop.', 'Ignore your symptoms.', 'Push through the dizziness.',
    'Your dizziness is harmless.', 'Drive even if you feel dizzy.', 'Do not drive safely.',
    'There is nothing to worry about.', 'Close your eyes.', 'Speed up.',
    'Pull over immediately.', 'Stop in traffic.', 'Pull over when it is not safe.',
    'Please pull over safely. Do not stop.', 'Stay focused and drive safely. Take aspirin.']) {
    const result = reply(advisory(text));
    assert.equal(result.usedFallback, true, text);
    assert.doesNotMatch(result.text, /clarify|understand|answer|heard/i);
  }
});

test('Connected rejects parking assumptions and diagnostic questioning, retaining contextual parking question', () => {
  for (const text of ['Now that you are parked, relax.', 'Stay safely parked.',
    'Since you stopped, take a break.', 'You are off the road.', 'How have your symptoms changed?',
    'Tell me more about your discomfort.', 'Are you safely parked?'])
    assert.equal(reply(advisory(text)).usedFallback, true, text);
  assert.equal(reply(advisory('Are you safely parked?'), [], false, true).usedFallback, false);
});

test('Connected cannot omit or contradict required guidance, including after guidance was delivered', () => {
  for (const text of [natural[0], 'Thanks for sharing.', 'Do not pull over. Please pull over safely.']) {
    const result = reply({ ...advisory(text), wellness: 'not_ok' });
    assert.equal(result.usedFallback, true, text); assert.equal(result.text, PULL_OVER_GUIDANCE);
  }
  assert.equal(reply({ ...advisory('Please pull over when it is safe.'), wellness: 'not_ok' }).usedFallback, false);
  assert.equal(reply(advisory('Ignore the dizziness.'), [], true).text, PULL_OVER_GUIDANCE);
  assert.equal(reply(advisory(natural[0]), [], true).text, PULL_OVER_GUIDANCE);
});

test('Connected repetition uses neutral fallback, never implies unclear driver speech', () => {
  for (const [text, previous] of [[natural[0], [natural[0]]],
    ['Thanks for sharing. How are you feeling now?', ['How are you feeling now?']]] as const) {
    const result = reply(advisory(text), [...previous]);
    assert.equal(result.fallbackReason, 'repeated_reply_or_question');
    assert.equal(result.usedFallback, true); assert.doesNotMatch(result.text, /clarify|answer/i);
    assert.ok(!result.text.includes('?'));
  }
});

test('Connected retains size, privacy and advisory authorization boundaries', () => {
  for (const text of ['', 'x'.repeat(241), 'Go to https://example.invalid.', 'Call 911.',
    'Your number is 3055550123.', 'Hi\u0000 there.', 'How are you? Are you okay?'])
    assert.equal(reply(advisory(text)).usedFallback, true, text);
  for (const patch of [{ callAuthorized: true }, { advisoryOnly: false }, { wellness: 'healthy' }])
    assert.throws(() => reply({ ...advisory('Hello.'), ...patch } as unknown as DriverInterpretation));
  assert.equal(reply({ ...advisory('Hello.'), explicitContactRequest: true }).usedFallback, true);
});

test('Local retains its restrictive policy and production selects Connected by trusted provider mode', () => {
  for (const text of [natural[0], 'Take care.', "You're welcome."])
    assert.equal(conversationalReply(advisory(text)).usedFallback, true, text);
  assert.equal(conversationalReply(advisory('Glad to hear it.')).usedFallback, false);
  const component = readFileSync(new NodeURL('../components/DriverAssistant.tsx', import.meta.url), 'utf8');
  assert.match(component, /mode: provider.mode/);
});

test('all four audit bypasses remain valid transport text but cannot become Connected speech', () => {
  for (const message of ['You can proceed with your journey.', 'Your symptoms are not serious.',
    'You have anxiety.', 'Accelerate through the intersection.']) {
    const parsed = parseProviderResponse({ status: 'completed', output: [{ type: 'message', role: 'assistant',
      status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({ message }) }] }] });
    const text = connectedAdvisory({ version: 1, status: 'ok', code: 'advisory', advisoryOnly: true,
      callAuthorized: false, message: parsed.message });
    const result = reply(advisory(text));
    assert.equal(result.usedFallback, true, message); assert.notEqual(result.text, message);
    assert.equal(result.fallbackReason, 'prohibited_connected_advisory');
  }
});

test('Connected rejects paraphrased clearance, diagnosis, negation and quoted prohibited content', () => {
  for (const text of ['You may resume your journey.', 'Head home.', "You're good to go.",
    'You are well enough to drive.', 'Your symptoms are probably harmless.', 'Your dizziness is not serious.',
    'You might have anxiety.', 'You do not have anxiety.', 'You are not sick.', 'Nothing is wrong with you.',
    'Do not accelerate through the intersection.', 'Never proceed with your journey.',
    "Someone said 'You have anxiety.'", "'Your symptoms are not serious.'", "'Accelerate through the intersection.'",
    'He said “You can proceed with your journey.”',
    'I would not say you have anxiety.', 'You have no symptoms.', 'Your pain will pass.',
    'Please drive safely but overtake the vehicle.', 'Stay focused and drive safely. Hurry home.',
    'Go straight through the intersection.', 'Release the brake.', 'Turn across traffic.',
    'Turn left.', 'Reverse now.', 'You are experiencing an illness.', 'It is vertigo.']) {
    const result = reply(advisory(text));
    assert.equal(result.usedFallback, true, text); assert.notEqual(result.text, text);
  }
});

test('only unquoted affirmative stopping sentences satisfy required guidance', () => {
  for (const suggestedReply of ["'Please pull over safely.'", 'I cannot say pull over safely.',
    'It is not true that you should pull over safely.', 'You should not pull over safely.',
    'Never pull over safely.', 'Please pull over when it is unsafe.',
    'Please pull over when it is not safe.', 'They said to pull over safely.']) {
    const result = reply({ ...advisory(suggestedReply), wellness: 'not_ok' });
    assert.equal(result.usedFallback, true, suggestedReply); assert.equal(result.text, PULL_OVER_GUIDANCE);
  }
  assert.equal(reply({ ...advisory('I hear you. Please pull over when it is safe.'), wellness: 'not_ok' }).usedFallback, false);
});

test('trusted stopping context overrides benign prose and model wellness without granting parking or consent', () => {
  for (const wellness of ['ok', 'uncertain', 'not_ok'] as const) {
    const result = reply({ ...advisory(natural[0]), wellness }, [], false, false, { stoppingRequired: true });
    assert.equal(result.text, PULL_OVER_GUIDANCE); assert.equal(result.usedFallback, true);
    assert.equal(result.fallbackReason, 'trusted_stopping_required');
  }
  assert.equal(reply(advisory(natural[0]), [], false, false, { stoppingRequired: false }).usedFallback, false);
  assert.equal(reply(advisory(natural[0]), [], true, false, { stoppingRequired: false }).text, PULL_OVER_GUIDANCE);
});

test('ordinary natural prose is not limited to Local vocabulary or exact sentence exceptions', () => {
  for (const text of ["I'm glad to hear that!", 'That sounds encouraging. Thanks for checking in.',
    "You're very welcome. Take care.", 'Remember to drive safely.',
    'Please stay focused and keep your eyes on the road.', 'If you become dizzy, pull over when safe.'])
    assert.deepEqual(reply(advisory(text)), { text, usedFallback: false }, text);
});

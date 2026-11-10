import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acknowledgmentContext, acknowledgmentPrompt, validateAcknowledgment, startSafetyAcknowledgment, canGenerateAcknowledgment } from '../lib/assistant/safetyAcknowledgment.ts';
import { CONTEXTUAL_FIXTURES } from '../modules/gemma-poc/contextualDiagnostic.ts';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const context = acknowledgmentContext('bpm_high', 'es', 'Me siento mareada');

// Literal failure supplied by the physical-iPhone run. No model invocation here.
test('literal Spanish placeholder is rejected and never repaired into an accepted sentence', async () => {
  for (const text of ['Lamento que te sientas SENSACIÓN.', 'Lamento que te sientas SENSACION.',
    'Lamento que te sientas sensación.', 'Lamento que te sientas ${feeling}.']) {
    assert.equal(validateAcknowledgment(text, context), null);
    const task = startSafetyAcknowledgment(async () => text, context); await tick();
    assert.equal(task.get('es'), 'Lamento que te sientas así.'); assert.equal(task.source, 'fallback');
  }
});

test('Spanish prompt contains one complete grounded example, preserving reported gender and accented forms', () => {
  for (const [statement, feeling] of [
    ['Me siento mareada', 'mareada'], ['Estoy mareado', 'mareado'], ['Estoy cansado', 'cansado'],
    ['Me siento cansada', 'cansada'], ['Estoy débil', 'débil'], ['Estoy debil', 'débil'], ['Estoy mal', 'mal'],
    ['Me siento con náuseas', 'con náuseas'], ['Estoy con nauseas', 'con náuseas'],
  ]) {
    const current = acknowledgmentContext('spo2_low', 'es', statement);
    const prompt = acknowledgmentPrompt(current);
    const expected = `Lamento que te sientas ${feeling}.`;
    assert.equal(prompt.split(expected).length - 1, 1);
    assert.equal(validateAcknowledgment(expected, current), expected);
    assert.doesNotMatch(prompt, /SENSACI[ÓO]N|FEELING|sustituy|Completa esta forma|\[|\]|"/);
    assert.ok(!prompt.includes(statement));
  }
});

test('Spanish validation still rejects opposite gender, invented symptoms, first-person imitation, wrong language and extra prose', () => {
  for (const text of ['Lamento que te sientas mareado.', 'Lamento que te sientas cansada.',
    'Lamento que te sientas con fiebre.', 'Me siento mareada.', "I'm sorry you're feeling dizzy.",
    'Lamento que te sientas mareada. Te escucho.', '"Lamento que te sientas mareada."',
    'Lamento que te sientas mareada. Voy a llamar a tu contacto.', 'x'.repeat(181)])
    assert.equal(validateAcknowledgment(text, context), null, text);
});

test('all three English control prompts are byte-for-byte unchanged', () => {
  for (const [event, statement, feeling] of [
    ['bpm_high', "I'm dizzy", 'dizzy'], ['bpm_low', 'I feel weak', 'weak'], ['spo2_low', "I'm not okay", 'unwell'],
  ] as const) {
    assert.equal(acknowledgmentPrompt(acknowledgmentContext(event, 'en', statement)), `You are Sensi, replying to a driver.
Safety event: ${event}. Fixed outcome: not_ok.
The driver reports feeling: ${feeling}.
Write ONE English sentence addressed to the driver as you. Do not speak as the driver.
Complete this form by replacing FEELING with the reported feeling:
I'm sorry you're feeling FEELING.
Return only the completed sentence. No quotes, lists, alternatives, explanations, questions, instructions, diagnoses, medical advice, action promises, names or other symptoms.`);
    const expected = `I'm sorry you're feeling ${feeling}.`;
    assert.equal(validateAcknowledgment(expected, acknowledgmentContext(event, 'en', statement)), expected);
  }
});

test('same six ineligible fixtures continue to skip generation instead of using an example', async () => {
  let calls = 0;
  for (const fixture of CONTEXTUAL_FIXTURES.filter(f => f.kind !== 'grounded')) {
    const current = acknowledgmentContext(fixture.event, fixture.language, fixture.statement);
    assert.equal(current.statement, null); assert.equal(canGenerateAcknowledgment(current), false);
    assert.throws(() => acknowledgmentPrompt(current), /No eligible/);
    const task = startSafetyAcknowledgment(async () => { calls++; return 'must not generate'; }, current);
    assert.equal(task.get(fixture.language), fixture.language === 'en' ? "I'm sorry to hear that." : 'Lamento que te sientas así.');
    task.cancel();
  }
  await tick(); assert.equal(calls, 0);
});

test('Spanish example does not override timeout or cancellation for a late otherwise-valid response', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const action of ['timeout', 'cancel'] as const) {
    let resolve!: (text: string) => void; let signal!: AbortSignal;
    const task = startSafetyAcknowledgment(s => { signal = s; return new Promise<string>(r => { resolve = r; }); }, context, 10);
    await tick(); if (action === 'cancel') task.cancel(); else t.mock.timers.tick(10);
    resolve('Lamento que te sientas mareada.'); await tick();
    assert.equal(signal.aborted, true); assert.equal(task.get('es'), 'Lamento que te sientas así.'); assert.equal(task.source, 'fallback');
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acknowledgmentContext, acknowledgmentPrompt, acknowledgmentCandidates, canGenerateAcknowledgment,
  validateAcknowledgment, startSafetyAcknowledgment } from '../lib/assistant/safetyAcknowledgment.ts';
import { GemmaPoc } from '../modules/gemma-poc/controller.ts';
import { CONTEXTUAL_FIXTURES } from '../modules/gemma-poc/contextualDiagnostic.ts';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const en = acknowledgmentContext('bpm_high', 'en', "I'm dizzy");
const es = acknowledgmentContext('spo2_low', 'es', 'Me siento mareada');

// Representative regressions matching reported failure patterns, not captured GGUF outputs.
test('quoted or unquoted candidate lists, alternatives and two-sentence replies are still rejected wholesale', () => {
  for (const output of [
    `"I'm sorry you're feeling dizzy.", "I hear that you're feeling dizzy."`,
    `I'm sorry you're feeling dizzy., I hear that you're feeling dizzy.`,
    `I'm sorry you're feeling dizzy. Thank you for telling me.`,
    `I'm sorry you're feeling dizzy. Or I hear that you're feeling dizzy.`,
    `1. I'm sorry you're feeling dizzy.`, `"I'm sorry you're feeling dizzy."`,
  ]) assert.equal(validateAcknowledgment(output, en), null, output);
  assert.equal(validateAcknowledgment('Lamento que te sientas mareada. Te escucho.', es), null);
});

test('Spanish driver imitation, invented feelings, wrong languages and unrelated prose fail the same exact-match gate', () => {
  for (const output of ['Me siento mareada.', 'Estoy mareada.', 'Lamento que me sienta mareada.',
    'Soy el conductor y estoy mareada.', "I'm sorry you're feeling dizzy.", 'Lamento que te sientas cansada.',
    'El clima está agradable.', 'Lamento que te sientas mareada. Voy a llamar a tu contacto.', 'x'.repeat(181)])
    assert.equal(validateAcknowledgment(output, es), null, output);
  assert.equal(validateAcknowledgment('Lamento que te sientas mareada.', en), null);
});

test('localized prompts contain a single form and eligible feeling, with no candidate arrays or first-person report', () => {
  for (const context of [en, es]) {
    const prompt = acknowledgmentPrompt(context);
    assert.ok(prompt.includes(context.event)); assert.ok(prompt.includes('not_ok'));
    assert.ok(prompt.includes(context.language === 'en' ? 'dizzy' : 'mareada'));
    assert.ok(!prompt.includes(context.statement!)); assert.doesNotMatch(prompt, /\[|\]|"|Permitted sentences|Context:/);
    assert.equal(prompt.includes("I'm sorry you're feeling FEELING."), context.language === 'en');
    assert.equal(prompt.includes('Lamento que te sientas mareada.'), context.language === 'es');
    assert.match(prompt, context.language === 'en' ? /ONE English sentence/ : /UNA sola oración en español/);
    if (context.language === 'es') assert.doesNotMatch(prompt, /SENSACI[ÓO]N|sustituyendo|Completa esta forma/);
  }
});

test('grounded single-sentence second-person forms remain accepted with no new output normalization', () => {
  for (const [context, text] of [[en, "I'm sorry you're feeling dizzy."], [es, 'Lamento que te sientas mareada.']] as const) {
    assert.equal(validateAcknowledgment(text, context), text);
    assert.equal(validateAcknowledgment(text.toUpperCase(), context), null);
    assert.equal(validateAcknowledgment(text + '\nExtra text.', context), null);
    assert.equal(validateAcknowledgment(text + ' Call 911.', context), null);
    for (const candidate of acknowledgmentCandidates(context)) assert.equal(candidate.split('.').length, 2);
  }
});

test('all omitted/unsupported fixtures and buttons skip the generator and native controller entirely', async () => {
  let generated = 0, initialized = 0;
  const poc = new GemmaPoc({ verify: async () => { throw Error('must not verify'); }, provision: async () => {},
    initialize: async () => { initialized++; throw Error('must not initialize'); } });
  const inputs = [...CONTEXTUAL_FIXTURES.filter(f => f.kind !== 'grounded').map(f => acknowledgmentContext(f.event, f.language, f.statement)),
    acknowledgmentContext('bpm_low', 'en'), acknowledgmentContext('bpm_low', 'es')];
  for (const context of inputs) {
    assert.equal(canGenerateAcknowledgment(context), false); assert.equal(context.statement, null);
    assert.throws(() => acknowledgmentPrompt(context), /No eligible/);
    const acknowledgment = startSafetyAcknowledgment(async () => { generated++; await poc.load(); return 'unrelated'; }, context);
    assert.equal(acknowledgment.get(context.language), context.language === 'en' ? "I'm sorry to hear that." : 'Lamento que te sientas así.');
    acknowledgment.cancel(); assert.equal(acknowledgment.source, 'fallback');
    assert.equal(await poc.generateSafetyAcknowledgment(context), '');
  }
  await tick(); assert.equal(generated, 0); assert.equal(initialized, 0); assert.equal(poc.state.busy, false); assert.equal(poc.state.error, '');
});

for (const context of [en, es]) test(`${context.language}: timeout and cancellation cannot publish a late correct sentence`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const mode of ['timeout', 'cancel'] as const) {
    let complete!: (text: string) => void; let signal!: AbortSignal;
    const task = startSafetyAcknowledgment(s => { signal = s; return new Promise(resolve => { complete = resolve; }); }, context, 10);
    await tick(); if (mode === 'cancel') task.cancel(); else t.mock.timers.tick(10);
    complete(context.language === 'en' ? "I'm sorry you're feeling dizzy." : 'Lamento que te sientas mareada.'); await tick();
    assert.equal(signal.aborted, true); assert.equal(task.get(context.language), context.language === 'en' ? "I'm sorry to hear that." : 'Lamento que te sientas así.');
    assert.equal(task.source, 'fallback');
  }
});

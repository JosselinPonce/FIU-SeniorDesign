import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VerifiedModelFile, type FileIdentity } from '../modules/gemma-poc/verifiedFile.ts';
import { readinessIndicator } from '../lib/assistant/systemReadiness.ts';
import { light, dark } from '../lib/theme/tokens.ts';
import { acknowledgmentContext, acknowledgmentCandidates, approvedAcknowledgment, startSafetyAcknowledgment, validateAcknowledgment } from '../lib/assistant/safetyAcknowledgment.ts';
import { VoiceCheck } from '../lib/voice/voiceCheck.ts';
import { recognitionEvidence } from '../lib/voice/coreRecognition.ts';

const artifact = { bytes: 241410624, sha256: 'approved-hash', revision: 'approved-revision' };
const uri = 'sandbox/model.gguf';
const identity = { size: artifact.bytes, modified: 123, created: 100 };
const receipt = { ...identity, version: 1, uri, sha256: artifact.sha256, revision: artifact.revision };
for (const [name, file, proof, expected] of [
  ['approved receipt', identity, receipt, 'installed'],
  ['file presence only', identity, null, 'unverified'],
  ['missing file', null, receipt, 'missing'],
  ['wrong size', { ...identity, size: 1 }, receipt, 'unavailable'],
  ['changed modification time', { ...identity, modified: 124 }, receipt, 'unverified'],
  ['changed creation time', { ...identity, created: 99 }, receipt, 'unverified'],
  ['missing modification time', { ...identity, modified: null }, receipt, 'unverified'],
  ['wrong hash', identity, { ...receipt, sha256: 'other' }, 'unverified'],
  ['wrong revision', identity, { ...receipt, revision: 'other' }, 'unverified'],
  ['wrong path', identity, { ...receipt, uri: 'other' }, 'unverified'],
  ['wrong receipt version', identity, { ...receipt, version: 2 }, 'unverified'],
  ['malformed receipt', identity, 'invalid', 'unverified'],
] as const) test(`passive installation inspection: ${name}`, async () => {
  const forbidden = async () => { throw Error('Passive observation must not hash or write'); };
  let hashes = 0, writes = 0;
  const model = new VerifiedModelFile({ identity: () => file, read: async () => proof,
    hash: async () => { hashes++; return forbidden(); }, write: async () => { writes++; await forbidden(); } }, artifact);
  assert.equal(await model.inspect(uri), expected); assert.equal(hashes, 0); assert.equal(writes, 0);
});

test('passive installation inspection rejects replacement during receipt I/O and never repairs it', async () => {
  let file: FileIdentity | null = identity;
  const model = new VerifiedModelFile({ identity: () => file,
    read: async () => { file = { ...identity, modified: 999 }; return receipt; },
    write: async () => { assert.fail('no writes'); }, hash: async () => { assert.fail('no hashing'); } }, artifact);
  assert.equal(await model.inspect(uri), 'unverified');
  file = null; assert.equal(await model.inspect(uri), 'missing');
});

test('missing receipt and inaccessible storage remain conservative without native verification', async () => {
  let inaccessible = false;
  const model = new VerifiedModelFile({ identity: () => { if (inaccessible) throw Error('storage'); return identity; },
    read: async () => { throw Error('no receipt'); }, write: async () => { assert.fail('no writes'); }, hash: async () => { assert.fail('no hashing'); } }, artifact);
  assert.equal(await model.inspect(uri), 'unverified'); inaccessible = true; assert.equal(await model.inspect(uri), 'unavailable');
});

const luminance = (hex: string) => {
  const rgb = hex.slice(1).match(/../g)!.map(x => parseInt(x, 16) / 255).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4);
  return rgb[0]! * .2126 + rgb[1]! * .7152 + rgb[2]! * .0722;
};
for (const tokens of [light, dark]) test(`readiness meanings and colors have readable contrast in ${tokens === light ? 'light' : 'dark'} theme`, () => {
  for (const [status, tone] of [['Available', 'success'], ['Connecting', 'warning'], ['Unavailable', 'danger'], ['Error', 'danger'], ['Unknown', 'neutral']] as const) {
    const indicator = readinessIndicator(status); assert.equal(indicator.tone, tone);
    const color = { success: tokens.connected, warning: tokens.warning, danger: tokens.danger, neutral: tokens.textMuted }[indicator.tone];
    const a = luminance(color), b = luminance(tokens.surface);
    assert.ok((Math.max(a, b) + .05) / (Math.min(a, b) + .05) >= 4.5, status);
  }
});

for (const [language, statement, expected] of [
  ['en', "I'm dizzy", "I'm sorry you're feeling dizzy."],
  ['es', 'Me siento mareada', 'Lamento que te sientas mareada.'],
] as const) test(`${language} production/rehearsal workflow rejects the old generic apology and preserves grounded empathy and consent`, async () => {
  const context = acknowledgmentContext('bpm_high', language, statement);
  assert.ok(acknowledgmentCandidates(context).includes(expected));
  for (const old of ["I'm sorry to hear that.", 'I’m sorry to hear that.', "I'M SORRY TO HEAR THAT.", 'Lamento que te sientas así.']) {
    assert.equal(validateAcknowledgment(old, context), null);
    assert.equal(approvedAcknowledgment(old, language, context), language === 'en' ? 'Thank you for telling me.' : 'Gracias por decírmelo.');
  }
  let capture = 0; const spoken: string[] = [];
  const check = new VoiceCheck({ cancel() {}, speak: async text => { spoken.push(text); },
    listen: async (_l, _ms, _h, id) => {
      const text = ++capture === 1 ? statement : language === 'en' ? 'no thanks' : 'no gracias';
      return recognitionEvidence(id, { status: 'success', transcript: text, finalTranscript: text, isFinal: true, finalResultReceived: true });
    } }, language, '', { contactAvailable: true, acknowledgment: () => expected });
  const result = await check.run('bpm_high');
  assert.ok(spoken.includes(expected)); assert.doesNotMatch(spoken.join(' '), /sorry to hear|sientas así/i);
  assert.equal(result.outcome, 'not_ok'); assert.equal(check.authorizesContact(result), false);
  const unsupported = acknowledgmentContext('bpm_high', language, language === 'en' ? 'a strange unspecified feeling' : 'una sensación extraña');
  let generated = 0;
  const task = startSafetyAcknowledgment(async () => { generated++; return expected; }, unsupported);
  assert.equal(task.get(language), language === 'en' ? 'Thank you for telling me.' : 'Gracias por decírmelo.');
  assert.equal(generated, 0);
});

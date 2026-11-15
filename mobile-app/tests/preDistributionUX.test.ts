import { test } from 'node:test';
import assert from 'node:assert/strict';
import { URL as NodeURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { VoiceCheckDiagnostic, diagnosticInterpretation, type DiagnosticIO, type DiagnosticState } from '../lib/voice/voiceCheckDiagnostic.ts';
import { AudioOwnership } from '../lib/voice/audioOwnership.ts';
import { recognitionEvidence } from '../lib/voice/coreRecognition.ts';
import { understand } from '../lib/voice/intent.ts';
import { VoiceCheck } from '../lib/voice/voiceCheck.ts';
import { simulationProgress } from '../lib/ui/simulationProgress.ts';
import { acknowledgmentContext, approvedAcknowledgment, validateAcknowledgment } from '../lib/assistant/safetyAcknowledgment.ts';
import { settingsTitle } from '../lib/ui/settingsNavigation.ts';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fixture() {
  const audio = new AudioOwnership(); const states: DiagnosticState[] = [];
  let available = true; let final = true; let text = ''; let cancellations = 0;
  const locales: string[] = [];
  const ports: DiagnosticIO = { available: () => available, acquire: stop => audio.acquire('optional', stop),
    listen: async (lang, id, progress) => { locales.push(lang); progress('listening', text); return recognitionEvidence(id,
      { status: final ? 'success' : 'incomplete', transcript: text, finalTranscript: final ? text : '', isFinal: final, finalResultReceived: final }); },
    speak: async () => {}, cancel: async () => { cancellations++; },
  };
  const session = new VoiceCheckDiagnostic(ports, s => states.push(s));
  return { session, ports, audio, states, locales, set: (value: string, isFinal = true) => { text = value; final = isFinal; }, block: () => { available = false; }, cancellations: () => cancellations };
}
for (const [lang, text, outcome] of [['en', 'No im good', 'OK'], ['es', 'No, estoy bien', 'OK'], ['en', "I can't breathe", 'NOT_OK'], ['es', 'no puedo respirar', 'NOT_OK'], ['en', 'what', 'UNCERTAIN'], ['es', 'qué', 'UNCERTAIN']] as const) {
  test(`isolated final recognition and repeatable interpretation ${lang}: ${text}`, async () => {
    const f = fixture(); f.set(text); await f.session.listen(lang);
    assert.deepEqual(f.locales, [lang]); assert.equal(f.session.state.confirmed, true);
    assert.equal(f.session.state.transcript, text); assert.equal(f.session.state.result?.interpretation, outcome);
    assert.equal('contactCall' in f.session.state.result!, false);
    assert.equal(f.audio.available, true);
    await f.session.interpret('no good', 'en'); assert.equal(f.session.state.result?.interpretation, 'NOT_OK');
    await f.session.interpret('bien', 'es'); assert.equal((f.session.state as DiagnosticState).result?.interpretation, 'OK');
    await f.session.close();
  });
}
test('partial recognition is displayed but cannot yield clearance', async () => {
  const f = fixture(); f.set('I am fine', false); await f.session.listen('en');
  assert.equal(f.session.state.transcript, 'I am fine'); assert.equal(f.session.state.confirmed, false); assert.equal(f.session.state.result, null);
  await f.session.interpret('I am fine', 'en'); assert.equal((f.session.state as DiagnosticState).result?.interpretation, 'OK');
});
test('a typed answer cancels capture, drains ownership and rejects late final output', async () => {
  const f = fixture(); const native = deferred<ReturnType<typeof recognitionEvidence>>(); let id = '';
  f.ports.listen = async (_lang, captureId) => { id = captureId; return native.promise; };
  f.ports.cancel = async () => { native.resolve(recognitionEvidence(id, { status: 'success', transcript: 'good', finalTranscript: 'good', isFinal: true, finalResultReceived: true })); };
  const capture = f.session.listen('en'); await tick();
  await f.session.interpret('not okay', 'en'); await capture;
  assert.equal(f.session.state.transcript, 'not okay'); assert.equal(f.session.state.result?.interpretation, 'NOT_OK'); assert.equal(f.audio.available, true);
});
test('safety preempts only diagnostic ownership and waits for cancellation cleanup', async () => {
  const f = fixture(); const native = deferred<ReturnType<typeof recognitionEvidence>>(), stopped = deferred<void>(); let id = '';
  f.ports.listen = async (_lang, value) => { id = value; return native.promise; };
  f.ports.cancel = async () => { native.resolve(recognitionEvidence(id, { status: 'cancelled', transcript: '', isFinal: false })); await stopped.promise; };
  const capture = f.session.listen('en'); await tick();
  let acquired = false; const safety = f.audio.acquire('safety', async () => {}).then(release => { acquired = true; return release; });
  await tick(); assert.equal(acquired, false); stopped.resolve(); const release = await safety; await capture;
  assert.equal(f.session.state.result, null); release(); assert.equal(f.audio.available, true);
});
test('blocked capture and disposed diagnostics cannot publish or acquire new audio', async () => {
  const f = fixture(); f.block(); await f.session.listen('en'); assert.deepEqual(f.locales, []);
  await f.session.close(); const count = f.states.length; await f.session.interpret('good', 'en'); assert.equal(f.states.length, count);
});
for (const text of ['call my mom', 'yes call 911', 'llama a mi contacto', 'no puedo respirar']) test(`diagnostic result has no action authority: ${text}`, () => {
  const result = diagnosticInterpretation(text, 'en');
  assert.deepEqual(Object.keys(result).sort(), ['interpretation', 'response', 'urgent']);
});

for (const [lang, text, expected] of [
  ['en', "No, I'm okay.", 'ok'], ['en', "No, I'm good.", 'ok'], ['en', 'No im okay.', 'ok'], ['en', 'No im good.', 'ok'],
  ['en', 'no i am fine', 'ok'], ['en', "no I'm good thanks", 'ok'], ['es', 'No, estoy bien.', 'ok'], ['es', 'No, me siento muy bien.', 'ok'],
  ['en', 'No good.', 'not_ok'], ['en', "I'm not okay.", 'not_ok'], ['en', "No, I'm not okay.", 'not_ok'],
  ['en', "No, I'm good, but I'm dizzy.", 'not_ok'], ['en', "No, I'm okay, I can't breathe.", 'not_ok'],
  ['en', 'no im okay but the colors look strange', 'unclear'], ['es', 'no estoy bien', 'not_ok'], ['es', 'no me siento bien', 'not_ok'],
  ['es', 'No, estoy bien pero estoy mareada', 'not_ok'], ['es', 'No, estoy bien no puedo respirar', 'not_ok'],
] as const) test(`complete conversational no keeps deterministic boundaries: ${text}`, async () => {
  assert.equal(understand(text).intent, expected);
  let n = 0; const spoken: string[] = [];
  const check = new VoiceCheck({ cancel() {}, speak: async s => { spoken.push(s); }, listen: async (_lang, _ms, _hints, id) => {
    const answer = n++ === 0 ? text : lang === 'es' ? 'qué' : 'what';
    return recognitionEvidence(id, { status: 'success', transcript: answer, finalTranscript: answer, isFinal: true, finalResultReceived: true });
  } }, lang, '', { contactAvailable: true });
  const r = await check.run('bpm_high'); assert.equal(r.outcome, expected === 'unclear' ? 'no_response' : expected);
  assert.equal(check.authorizesContact(r), false);
  if (expected !== 'ok') assert.ok(!spoken.some(s => /Drive safely|Maneja con cuidado/.test(s)));
  if (/breathe|respirar/.test(text)) { assert.equal(r.urgent, true); assert.ok(spoken.some(s => /911 now|911 ahora/.test(s))); }
});
test('neutral fallback and grounded contextual acknowledgment remain bilingual', () => {
  assert.equal(approvedAcknowledgment(null, 'en'), 'Thank you for telling me.');
  assert.equal(approvedAcknowledgment(null, 'es'), 'Gracias por decírmelo.');
  const context = acknowledgmentContext('bpm_high', 'en', "I'm dizzy");
  assert.equal(validateAcknowledgment("I'm sorry you're feeling dizzy.", context), "I'm sorry you're feeling dizzy.");
});
test('simulation panel reads existing state without mutating it or predicting confirmation', () => {
  const demo = Object.freeze({ scenario: 'high_warning', second: 13, value: 122, step: 'fabricated abnormal readings' });
  assert.deepEqual(simulationProgress(demo), { label: 'SIMULATED', seconds: 13, value: 122, unit: 'BPM', phase: demo.step });
  assert.equal(simulationProgress({ ...demo, scenario: 'spo2', value: 87 }).unit, '%');
});
test('diagnostic navigation and production composer are separate from the transcript scroll', () => {
  assert.equal(settingsTitle('voicecheck_testing'), 'VoiceCheck Testing');
  const read = (name: string) => readFileSync(new NodeURL('../' + name, import.meta.url), 'utf8');
  const adapter = read('lib/voice/voiceCheckDiagnostic.ts');
  assert.ok(!/SafetyController|supabase|handoffContact|phoneHandoff|\.simulate\(|saveAck/.test(adapter));
  const view = read('components/SensiSafetyConversation.tsx');
  assert.ok(!view.includes('footer={controls}'));
  assert.ok(view.indexOf('{controls}') > view.indexOf('compactPlayback />'));
  assert.ok(read('components/SettingsView.tsx').includes('<SimulationProgress demo={sf.demo} />'));
});

test('native failures and wrong capture identities retain manual fallback without clearance', async () => {
  const f = fixture(); f.ports.listen = async () => { throw Error('permission denied'); };
  await f.session.listen('es'); assert.equal(f.session.state.result, null); assert.equal(f.audio.available, true);
  f.ports.listen = async () => recognitionEvidence('other-capture', { status: 'success', transcript: 'good', finalTranscript: 'good', isFinal: true, finalResultReceived: true });
  await f.session.listen('en'); assert.equal(f.session.state.result, null);
  await f.session.interpret('bien', 'es'); assert.equal((f.session.state as DiagnosticState).result?.interpretation, 'OK');
  f.session.clear(); assert.equal(f.session.state.result, null); assert.equal(f.session.state.transcript, '');
});
test('closing during capture prevents all late progress and result publication', async () => {
  const f = fixture(); const pending = deferred<ReturnType<typeof recognitionEvidence>>(); let progress!: (phase: 'listening', text: string) => void;
  f.ports.listen = async (_lang, _id, update) => { progress = update; return pending.promise; };
  f.ports.cancel = async (_kind, id) => { pending.resolve(recognitionEvidence(id, { status: 'success', transcript: 'good', finalTranscript: 'good', isFinal: true, finalResultReceived: true })); };
  const capture = f.session.listen('en'); await tick(); const before = f.states.length; await f.session.close(); await capture;
  progress('listening', 'good'); assert.equal(f.states.length, before); assert.equal(f.session.state.result, null); assert.equal(f.audio.available, true);
});
test('foreground/safety availability revocation rejects a completed diagnostic result', async () => {
  const f = fixture(); f.ports.listen = async (_lang, id) => { f.block(); return recognitionEvidence(id, { status: 'success', transcript: 'good', finalTranscript: 'good', isFinal: true, finalResultReceived: true }); };
  await f.session.listen('en'); assert.equal(f.session.state.result, null); assert.equal(f.audio.available, true);
});

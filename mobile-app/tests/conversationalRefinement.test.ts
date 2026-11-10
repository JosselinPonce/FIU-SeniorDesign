import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { URL as NodeURL } from 'node:url';
import ts from 'typescript';
import { VoiceCheck } from '../lib/voice/voiceCheck.ts';
import { recognitionEvidence } from '../lib/voice/coreRecognition.ts';
import { startSafetyAcknowledgment } from '../lib/assistant/safetyAcknowledgment.ts';
import { safetyButtonText } from '../lib/assistant/safetyConversation.ts';
import { nearThreadBottom, playbackLabel } from '../lib/assistant/threadPresentation.ts';
import { translateText } from '../lib/i18n/translate.ts';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const guidance = { en: 'Please pull over as soon as it is safe. If you need emergency help, call 911.',
  es: 'Por favor detente cuando sea seguro. Si necesitas ayuda de emergencia, llama al 911.' };
const output = { en: "I'm sorry you're feeling dizzy.", es: 'Lamento que te sientas mareada.' };
const statement = { en: "I'm dizzy", es: 'Me siento mareada' };
for (const lang of ['en', 'es'] as const) {
  for (const mode of ['ready', 'late', 'invalid', 'unavailable'] as const) {
    test(`${lang}: concise acknowledgment/offer preserves guidance-first order and consent (${mode}, mocked model)`, async () => {
      const said: string[] = [];
      const playing = deferred<void>(), generation = deferred<string>();
      let ack!: ReturnType<typeof startSafetyAcknowledgment>, listens = 0, starts = 0;
      const check = new VoiceCheck({ cancel() {}, speak: async text => { said.push(text); if (said.length === 2) await playing.promise; },
        listen: async (_l, _m, _h, id) => { const text = ++listens === 1 ? statement[lang] : lang === 'en' ? 'no thanks' : 'no';
          return recognitionEvidence(id, { status: 'success', transcript: text, finalTranscript: text, isFinal: true, finalResultReceived: true }); },
      }, lang, 'Driver', { contactAvailable: true, contactName: lang === 'en' ? 'Mom' : 'mamá',
        startAcknowledgment: context => { starts++; ack = startSafetyAcknowledgment(async () => {
          if (mode === 'unavailable') throw Error('model unavailable');
          if (mode === 'late') return generation.promise;
          return mode === 'invalid' ? 'I called your contact.' : output[lang];
        }, context); }, acknowledgment: () => ack.get(lang), cancelAcknowledgment: () => ack.cancel(),
      });
      const pending = check.run('bpm_high'); await tick();
      assert.equal(starts, 1); assert.equal(said.length, 2);
      assert.equal(said[1], guidance[lang]); assert.equal(check.authorizesContact({ outcome: 'not_ok', urgent: false, channel: 'voice', attempts: 1, confidence: null, contactCall: 'accepted_offer' }), false);
      playing.resolve(); const result = await pending;
      assert.equal(said.length, 3, 'no extra empathy-only speech turn');
      const fallback = lang === 'en' ? "I'm sorry to hear that." : 'Lamento que te sientas así.';
      assert.equal(said[2], `${mode === 'ready' ? output[lang] : fallback} ${lang === 'en' ? 'Would you like me to call Mom?' : '¿Quieres que llame a mamá?'}`);
      assert.equal(result.outcome, 'not_ok'); assert.equal(result.contactCall, 'declined_offer');
      assert.equal(check.authorizesContact(result), false);
      generation.resolve(output[lang]); await tick(); assert.equal(said.length, 3, 'late output never adds another turn');
      ack.cancel();
    });
  }
  test(`${lang}: wellness retry is short, avoids repeated name/event and retains the same answer semantics`, async () => {
    const said: string[] = []; let listens = 0;
    const check = new VoiceCheck({ cancel() {}, speak: async text => { said.push(text); },
      listen: async (_l, _m, _h, id) => { if (++listens === 1) return null;
        const text = lang === 'en' ? 'yes' : 'sí';
        return recognitionEvidence(id, { status: 'success', transcript: text, finalTranscript: text, isFinal: true, finalResultReceived: true }); },
    }, lang, 'Driver');
    const result = await check.run('bpm_high');
    assert.equal(said[1], lang === 'en' ? "I didn't catch that. Are you feeling okay? Say yes or no." : 'No te entendí. ¿Te sientes bien? Di sí o no.');
    assert.ok(said[1].split(/\s+/).length <= 14); assert.ok(!said[1].includes('Driver'));
    assert.equal(result.outcome, 'ok'); assert.equal(result.channel, 'voice'); assert.equal(result.contactCall, 'not_requested');
  });
  test(`${lang}: cancellation during separate guidance prevents the combined contact turn`, async () => {
    const playing = deferred<void>(); const said: string[] = [];
    let check!: VoiceCheck;
    check = new VoiceCheck({ cancel() {}, speak: async text => { said.push(text); if (said.length === 2) await playing.promise; },
      listen: async (_l, _m, _h, id) => recognitionEvidence(id, { status: 'success', transcript: statement[lang], finalTranscript: statement[lang], isFinal: true, finalResultReceived: true }),
    }, lang, '', { contactAvailable: true, acknowledgment: () => output[lang] });
    const pending = check.run('spo2_low'); const rejected = assert.rejects(pending, /cancelled/);
    await tick(); assert.equal(said[1], guidance[lang]); check.cancel(); playing.resolve(); await rejected;
    assert.equal(said.length, 2); assert.equal(check.cancelledResult?.contactCall, 'cancelled');
  });
}

test('contact action copy stays explicit and localized without changing wellness actions', () => {
  assert.equal(safetyButtonText('contact_offer', true), 'Yes, open phone');
  assert.equal(translateText(safetyButtonText('contact_offer', true), 'es'), 'Sí, abrir teléfono');
  assert.equal(translateText(safetyButtonText('contact_offer', false), 'es'), 'No, gracias');
  assert.equal(safetyButtonText('wellness', true), "I'm OK");
  assert.equal(safetyButtonText('wellness', false), "I'm not OK");
});

test('compact safety thread retains separate guidance and contact bubbles plus failure labels, without completed-playback clutter', () => {
  const require = createRequire(import.meta.url);
  const source = readFileSync(new NodeURL('../components/SensiConversationThread.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const deps: Record<string, unknown> = { react: { useRef: (current: unknown) => ({ current }), useEffect() {} },
    'react/jsx-runtime': require('react/jsx-runtime'), 'react-native': { ScrollView: 'ScrollView', View: 'View' },
    '../lib/i18n/native': { LocalizedText: 'Text' }, '../lib/theme/ThemeProvider': { useTheme: () => ({ tokens: {} }) },
    '../lib/assistant/threadPresentation': { nearThreadBottom, playbackLabel } };
  const exports: any = {};
  new Function('require', 'exports', compiled)((name: string) => { assert.ok(name in deps, name); return deps[name]; }, exports);
  const messages = [{ id: '1', role: 'assistant', text: guidance.en, playback: 'completed' },
    { id: '2', role: 'assistant', text: `${output.en} Would you like me to call Mom?`, playback: 'failed' }];
  const before = JSON.stringify(messages);
  function labels(compactPlayback: boolean) {
    const texts: string[] = [];
    const visit = (node: any) => { if (typeof node === 'string') texts.push(node); else if (Array.isArray(node)) node.forEach(visit); else if (node?.props) visit(node.props.children); };
    const tree = exports.SensiConversationThread({ messages, provisional: '', compactPlayback }); visit(tree); return texts;
  }
  const compact = labels(true);
  assert.ok(compact.includes(guidance.en)); assert.ok(compact.includes(messages[1].text));
  assert.equal(compact.includes('Playback completed'), false);
  assert.ok(compact.includes('Playback unconfirmed · may be incomplete'));
  assert.ok(labels(false).includes('Playback completed'), 'default/diagnostic thread behavior is preserved');
  for (const status of ['failed', 'interrupted', 'pending', 'playing'] as const) assert.equal(playbackLabel(status, true), playbackLabel(status));
  assert.equal(JSON.stringify(messages), before);
});

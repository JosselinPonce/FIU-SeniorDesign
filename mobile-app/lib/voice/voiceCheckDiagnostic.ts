import { understand } from './intent.ts';
import { successfulFinal, type CoreRecognition } from './coreRecognition.ts';
import { safetyGuidancePlan } from './responsePlan.ts';
import type { Lang, RecognitionPhase } from './voiceCheck.ts';

export type DiagnosticResult = Readonly<{ interpretation: 'OK' | 'NOT_OK' | 'UNCERTAIN'; urgent: boolean; response: string }>;
export type DiagnosticState = Readonly<{ phase: string; transcript: string; confirmed: boolean; result: DiagnosticResult | null; error: string }>;
export function diagnosticInterpretation(text: string, lang: Lang): DiagnosticResult {
  const u = understand(text);
  const interpretation = u.intent === 'ok' ? 'OK' : u.intent === 'not_ok' ? 'NOT_OK' : 'UNCERTAIN';
  return { interpretation, urgent: u.urgent, response: interpretation === 'NOT_OK'
    ? safetyGuidancePlan(lang, u.urgent).map(segment => segment.text).join(' ')
    : interpretation === 'OK' ? lang === 'es' ? 'Entendí que te sientes bien.' : 'I understood that you feel okay.'
      : lang === 'es' ? 'No pude confirmar cómo te sientes. Inténtalo de nuevo o escribe una respuesta completa.' : 'I could not confirm how you feel. Try again or type a complete response.' };
}

/** Explicitly isolated ports: no controller, sensor, database, model or phone handoff. */
export type DiagnosticIO = {
  acquire(stop: () => Promise<void>): Promise<() => void>;
  listen(lang: Lang, id: string, progress: (phase: RecognitionPhase, text: string) => void): Promise<CoreRecognition>;
  speak(text: string, lang: Lang, id: string): Promise<void>;
  cancel(kind: 'listening' | 'playing', id: string): Promise<void>;
  available(): boolean;
};
let nextDiagnostic = 0;
export class VoiceCheckDiagnostic {
  state: DiagnosticState = { phase: 'idle', transcript: '', confirmed: false, result: null, error: '' };
  private disposed = false;
  private active: { id: string; kind: 'listening' | 'playing'; cancelled: boolean; started: boolean; stopping?: Promise<void>; done: Promise<void> } | null = null;
  private readonly io: DiagnosticIO;
  private readonly changed: (state: DiagnosticState) => void;
  constructor(io: DiagnosticIO, changed: (state: DiagnosticState) => void) { this.io = io; this.changed = changed; }
  private publish(patch: Partial<DiagnosticState>) {
    this.state = { ...this.state, ...patch };
    if (!this.disposed) this.changed(this.state);
  }
  clear() {
    if (!this.active && !this.disposed) this.publish({ phase: 'idle', transcript: '', confirmed: false, result: null, error: '' });
  }
  async cancel() {
    const op = this.active;
    if (!op) return;
    op.cancelled = true;
    this.publish({ phase: 'cancelling' });
    if (op.started) {
      op.stopping ??= Promise.resolve().then(() => this.io.cancel(op.kind, op.id));
      await op.stopping;
    }
    await op.done; // Never release optional ownership before native work settles.
  }
  async close() { this.disposed = true; await this.cancel(); }
  async interpret(text: string, lang: Lang) {
    await this.cancel();
    if (this.disposed || !this.io.available()) return;
    const trimmed = text.trim().slice(0, 500);
    this.publish({ transcript: trimmed, confirmed: true, result: diagnosticInterpretation(trimmed, lang), error: '', phase: 'idle' });
  }
  async listen(lang: Lang) {
    await this.run('listening', async op => {
      const evidence = await this.io.listen(lang, op.id, (phase, text) => {
        if (this.active === op && !op.cancelled && !this.disposed) this.publish({ phase, transcript: text, confirmed: false });
      });
      if (op.cancelled || this.disposed || !this.io.available()) return;
      const final = successfulFinal(evidence, op.id);
      this.publish({ transcript: evidence.finalTranscript || evidence.transcript, confirmed: final,
        result: final ? diagnosticInterpretation(evidence.finalTranscript, lang) : null,
        error: final ? '' : 'No final response was confirmed. Try again or type a response.' });
    });
  }
  async play(lang: Lang) {
    const response = this.state.result?.response;
    if (response) await this.run('playing', op => this.io.speak(response, lang, op.id));
  }
  private async run(kind: 'listening' | 'playing', action: (op: NonNullable<VoiceCheckDiagnostic['active']>) => Promise<void>) {
    if (this.disposed || this.active || !this.io.available()) return;
    let complete!: () => void;
    const op: NonNullable<VoiceCheckDiagnostic['active']> = { id: `voicecheck-diagnostic-${++nextDiagnostic}`, kind, cancelled: false, started: false, done: new Promise<void>(resolve => { complete = resolve; }) };
    this.active = op;
    let release: (() => void) | undefined;
    this.publish({ phase: kind === 'listening' ? 'preparing' : 'playing', error: '',
      ...(kind === 'listening' ? { transcript: '', confirmed: false, result: null } : {}) });
    try {
      release = await this.io.acquire(() => this.cancel());
      if (op.cancelled || this.disposed || !this.io.available()) return;
      op.started = true;
      await action(op);
    } catch {
      if (!op.cancelled && !this.disposed) this.publish({ error: 'Voice unavailable. Use typed input or try again.' });
    } finally {
      await op.stopping?.catch(() => {});
      release?.();
      if (this.active === op) this.active = null;
      complete();
      this.publish({ phase: 'idle' });
    }
  }
}

import { semanticPrompt, type SemanticContext } from '../../lib/assistant/safetySemantic.ts';
import { TEST_PROMPT, GEMMA_ARTIFACT } from './artifact.ts';
import { acknowledgmentPrompt, canGenerateAcknowledgment, type AcknowledgmentContext } from '../../lib/assistant/safetyAcknowledgment.ts';
import type { ProvisionProgress } from './provisioning.ts';

export type Context = { generate(prompt: string): Promise<string>; stop(): Promise<void>; release(): Promise<void> };
export type PocState = { progress: ProvisionProgress | null; phase: string; installed: boolean; loaded: boolean; busy: boolean; response: string; error: string; loadMs: number | null; inferenceMs: number | null; cleanupRequired?: boolean };
export type PocDeps = {
  verify(signal: AbortSignal, progress?: (bytes: number) => void, force?: boolean): Promise<boolean>;
  provision(signal: AbortSignal, progress: (value: ProvisionProgress) => void): Promise<void>;
  initialize(): Promise<Context>;
};
const initial = (): PocState => ({ progress: null, phase: 'Not checked', installed: false, loaded: false, busy: false, response: '', error: '', loadMs: null, inferenceMs: null, cleanupRequired: false });

/** Serialized inference ownership only; no sensor classification, audio or phone services. */
export class GemmaPoc {
  state = initial();
  private context: Context | null = null;
  private invalidated = false;
  get cleanupRequired(): boolean { return this.invalidated; }
  private async releaseContext() {
    if (!this.context) return;
    this.invalidated = true; this.set({ cleanupRequired: true });
    await this.context.release();
    this.context = null; this.invalidated = false; this.set({ cleanupRequired: false });
  }
  private active: { abort: AbortController; done: Promise<void>; inference: boolean } | null = null;
  private disposal: Promise<void> | null = null;
  private stopping: Promise<void> = Promise.resolve();
  private listeners = new Set<(state: PocState) => void>();
  private readonly deps: PocDeps;
  private readonly deadlineMs: number;
  constructor(deps: PocDeps, deadlineMs = 10000) { this.deps = deps; this.deadlineMs = deadlineMs; }
  subscribe(listener: (state: PocState) => void) { this.listeners.add(listener); listener(this.state); return () => { this.listeners.delete(listener); }; }
  private set(patch: Partial<PocState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener(this.state)); }

  private async operation(phase: string, action: (signal: AbortSignal) => Promise<void>, deadline?: number) {
    if (this.active || (this.disposal && phase !== 'Unloading model')) throw new Error('Another Gemma operation is still active.');
    const abort = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    this.active = { abort, done, inference: phase === 'Running fixed test' || phase === 'Generating safety acknowledgment' };
    this.set({ busy: true, error: '', phase });
    const timer = deadline === undefined ? undefined : setTimeout(() => {
      this.set({ error: `${phase} timed out. Waiting for native cleanup.`, phase: 'Stopping' });
      this.cancel();
    }, deadline);
    try {
      await action(abort.signal);
      if (abort.signal.aborted) throw new Error('Gemma operation cancelled.');
      this.set({ phase: this.context ? 'Ready' : 'Unloaded' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Provisioning owns its stage deadlines and bounded cleanup. Surface its
      // final result rather than retaining the earlier "cancellation requested".
      this.set({ error: phase === 'Downloading and verifying model' ? message : this.state.error || message, phase: 'Error' });
    } finally {
      clearTimeout(timer);
      // A native stop may outlive generation. Do not permit release/reuse yet.
      await this.stopping;
      this.active = null;
      this.set({ busy: false, loaded: this.context !== null });
      finish();
    }
  }
  cancel() {
    if (!this.active || this.active.abort.signal.aborted) return;
    this.active.abort.abort();
    this.set({ phase: 'Stopping', error: this.state.error || 'Cancellation requested. Waiting for native cleanup.' });
    if (this.active.inference && this.context) this.stopping = this.context.stop().catch(error => {
      this.set({ error: `Cancellation failed: ${String(error)}. Waiting for native completion.` });
    });
  }
  check() { return this.operation('Verifying model', async signal => {
    this.set({ installed: false });
    this.set({ installed: await this.deps.verify(signal, undefined, true) });
  }, 120000); }
  provision() { return this.operation('Downloading and verifying model', async signal => {
    if (this.context) throw new Error('Unload the model before provisioning.');
    this.set({ installed: false, progress: null });
    await this.deps.provision(signal, progress => {
      if (!signal.aborted) this.set({ progress, phase: progress.stage === 'download' ? 'Downloading model' : 'Verifying SHA-256' });
    });
    if (signal.aborted) throw new Error('Model provisioning cancelled.');
    this.set({ installed: true });
  }); }
  load(force = false) { return this.operation('Loading model', async signal => {
    if (this.context) throw new Error('Model is already loaded.');
    this.set({ installed: false, response: '', loadMs: null, progress: null });
    const verifying = Date.now();
    if (!await this.deps.verify(signal, completed => this.set({ phase: 'Verifying SHA-256', progress: { stage: 'verify', completed, total: GEMMA_ARTIFACT.bytes, elapsedMs: Date.now() - verifying } }), force)) throw new Error('Model is missing. Provision it first.');
    if (signal.aborted) throw new Error('Model loading cancelled.');
    this.set({ installed: true, phase: 'Loading model' });
    const started = Date.now();
    const context = await this.deps.initialize();
    // Initialization cannot be forcibly aborted. Retain ownership until it returns.
    this.context = context;
    if (signal.aborted) {
      await this.releaseContext();
      throw new Error('Model loading cancelled.');
    }
    this.set({ loadMs: Date.now() - started });
  }, 30000); }
  run() { return this.operation('Running fixed test', async signal => {
    if (!this.context || this.invalidated) throw new Error('Model cleanup is required before inference.');
    this.set({ response: '', inferenceMs: null });
    const started = Date.now();
    try {
      const response = await this.context.generate(TEST_PROMPT);
      if (!signal.aborted) this.set({ response });
    } finally { this.set({ inferenceMs: Date.now() - started }); }
  }, this.deadlineMs); }
  /** Bounded event-scoped empathy task; never an arbitrary chat prompt. */
  async generateSafetyAcknowledgment(context: AcknowledgmentContext): Promise<string> {
    if (!canGenerateAcknowledgment(context)) return '';
    let selected = '';
    await this.operation('Generating safety acknowledgment', async signal => {
      if (!this.context || this.invalidated) throw new Error('Model unavailable or cleanup required.');
      const started = Date.now();
      this.set({ inferenceMs: null });
      try {
        const text = await this.context.generate(acknowledgmentPrompt(context));
        if (!signal.aborted) selected = text;
      } finally { this.set({ inferenceMs: Date.now() - started }); }
    }, 1500);
    return selected;
  }
  async generateSafetySemantic(context: SemanticContext): Promise<string> {
    const prompt = semanticPrompt(context);
    let selected = '';
    await this.operation('Generating safety semantics', async signal => {
      if (!this.context || this.invalidated) throw Error('Model unavailable or cleanup required.');
      const started = Date.now();
      try { const text = await this.context.generate(prompt); if (!signal.aborted) selected = text; }
      finally { this.set({ inferenceMs: Date.now() - started }); }
    }, 1500);
    return selected;
  }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.cancel();
    this.disposal = (async () => {
      await this.active?.done;
      await this.operation('Unloading model', async () => {
        await this.releaseContext();
      }, 30000);
    })().finally(() => { this.disposal = null; });
    return this.disposal;
  }
}

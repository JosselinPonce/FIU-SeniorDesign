export type ProvisionProgress = { stage: 'download' | 'verify'; completed: number; total: number; elapsedMs: number };
export const PROVISION_LIMITS = { downloadMs: 15 * 60_000, stallMs: 60_000, verifyMs: 120_000, cleanupMs: 15_000 };
type Transfer = { download(): Promise<void>; cancel(): Promise<void> };
type Deps = {
  bytes: number;
  prepare(): Promise<void>;
  transfer(progress: (bytes: number) => void): Transfer;
  verify(signal: AbortSignal, progress: (bytes: number) => void): Promise<void>;
  activate(signal: AbortSignal): Promise<void>;
  discard(): Promise<void>;
};

/** Own the staging file until native work and deletion actually settle, even if
 * the UI's bounded cleanup wait expires. Never permit a second writer then. */
export class ModelProvisioner {
  private owned = false;
  constructor(privateDeps: Deps, limits = PROVISION_LIMITS) { this.deps = privateDeps; this.limits = limits; }
  private deps: Deps;
  private limits: typeof PROVISION_LIMITS;
  async run(parent: AbortSignal, report: (progress: ProvisionProgress) => void) {
    if (this.owned) throw new Error('Previous model cleanup is still pending. Wait and retry; restart the app if native cleanup does not recover.');
    this.owned = true;
    const abort = new AbortController();
    let reason = 'Model download cancelled.';
    let stop: (() => void) | undefined;
    const cancel = () => { abort.abort(); stop?.(); };
    parent.addEventListener('abort', cancel);
    if (parent.aborted) cancel();
    let pending: Promise<unknown> = Promise.resolve();
    let stageTimer: ReturnType<typeof setTimeout> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let activated = false;
    const fail = (message: string) => { reason = message; cancel(); };
    const check = () => { if (abort.signal.aborted) throw new Error(reason); };
    const wait = async <T>(work: Promise<T>): Promise<T> => {
      pending = work;
      check();
      let listener!: () => void;
      try {
        return await Promise.race([work, new Promise<never>((_, reject) => {
          listener = () => reject(new Error(reason));
          abort.signal.addEventListener('abort', listener, { once: true });
        })]);
      } finally { abort.signal.removeEventListener('abort', listener); }
    };
    try {
      check();
      stageTimer = setTimeout(() => fail('Preparing model storage timed out.'), this.limits.verifyMs);
      await wait(Promise.resolve().then(() => this.deps.prepare()));
      clearTimeout(stageTimer); check();
      const started = Date.now();
      let written = 0;
      let downloading = true;
      const resetIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => fail('Model download stalled: no new bytes for 60 seconds. Retry on a stable connection.'), this.limits.stallMs);
      };
      report({ stage: 'download', completed: 0, total: this.deps.bytes, elapsedMs: 0 });
      stageTimer = setTimeout(() => fail('Model download exceeded the 15-minute limit.'), this.limits.downloadMs);
      resetIdle();
      const transfer = this.deps.transfer(bytes => {
        if (!downloading || abort.signal.aborted || !Number.isFinite(bytes) || bytes <= written) return;
        written = bytes; resetIdle();
        report({ stage: 'download', completed: bytes, total: this.deps.bytes, elapsedMs: Date.now() - started });
      });
      let cancelRequested = false;
      stop = () => {
        if (cancelRequested) return;
        cancelRequested = true;
        // Cancellation acknowledgment alone does not prove the writer is idle.
        void Promise.resolve().then(() => transfer.cancel()).catch(() => {});
      };
      await wait(Promise.resolve().then(() => { check(); return transfer.download(); }));
      downloading = false;
      clearTimeout(stageTimer); clearTimeout(idleTimer); stop = undefined; check();
      const verifying = Date.now();
      report({ stage: 'verify', completed: 0, total: this.deps.bytes, elapsedMs: 0 });
      stageTimer = setTimeout(() => fail('Model SHA-256 verification timed out.'), this.limits.verifyMs);
      await wait(Promise.resolve().then(() => this.deps.verify(abort.signal, bytes => {
        if (!abort.signal.aborted) report({ stage: 'verify', completed: bytes, total: this.deps.bytes, elapsedMs: Date.now() - verifying });
      })));
      clearTimeout(stageTimer); check();
      stageTimer = setTimeout(() => fail('Activating verified model timed out.'), this.limits.verifyMs);
      await wait(Promise.resolve().then(() => this.deps.activate(abort.signal)));
      check(); activated = true;
    } finally {
      clearTimeout(stageTimer); clearTimeout(idleTimer);
      parent.removeEventListener('abort', cancel);
      // Late callbacks have no authority to publish progress or activate a file.
      abort.abort(); stop?.();
      const cleanup = pending.catch(() => {}).then(async () => {
        if (!activated) await this.deps.discard();
      }).finally(() => { this.owned = false; });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([cleanup, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${reason} Cleanup is still pending; no file was trusted. Wait and retry, or restart the app if it remains stuck.`)), this.limits.cleanupMs);
        })]);
      } finally { clearTimeout(timer); }
    }
  }
}

import { GEMMA_ARTIFACT } from '../../modules/gemma-poc/artifact.ts';
import type { PocState } from '../../modules/gemma-poc/controller.ts';
export const SETUP_KEY = 'drivesense:setup:v1';
export const NOTICE_VERSION = 'prototype-notices-2026-10-25';
export const GEMMA_TERMS_URL = 'https://ai.google.dev/gemma/terms';
export const GEMMA_POLICY_URL = 'https://ai.google.dev/gemma/prohibited_use_policy';
export const GEMMA_TERMS_VERSION = 'gemma-2026-04-01:policy-2024-02-21';
type RecordState = { version: 1; noticeVersion: string; termsVersion: string; artifact: string;
  page: number; notices: boolean; terms: boolean; completed: boolean };
export type SetupState = { booted: boolean; busy: boolean; ready: boolean; modelReady: boolean;
  page: number; notices: boolean; terms: boolean; recovery: boolean; error: string };
export type SetupRuntime = { state: PocState; subscribe(fn: (s: PocState) => void): () => void;
  load(): Promise<void>; provision(): Promise<void>; dispose(): Promise<void>; cancel(): void };
type Store = { getSetting(key: string): Promise<string | null>; setSetting(key: string, value: string): Promise<unknown> };

/** Launch-only setup gate. Never observes sensors, profiles, calls or recording.
 * Once ready, runtime failures in safety interactions cannot reopen this gate. */
export class SensiSetup {
  state: SetupState = { booted: false, busy: false, ready: false, modelReady: false, page: 0,
    notices: false, terms: false, recovery: false, error: '' };
  private listeners = new Set<(s: SetupState) => void>();
  private booting: Promise<void> | null = null;
  private writes = Promise.resolve();
  private epoch = 0;
  private store: Store;
  private canRun: () => boolean;
  readonly runtime: SetupRuntime;
  constructor(store: Store, runtime: SetupRuntime, canRun: () => boolean = () => true) {
    this.store = store; this.runtime = runtime;
    this.canRun = canRun;
    runtime.subscribe(() => this.set({}));
  }
  subscribe(fn: (s: SetupState) => void) { this.listeners.add(fn); fn(this.state); return () => { this.listeners.delete(fn); }; }
  private set(patch: Partial<SetupState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(fn => fn(this.state)); }
  private persist(completed = false) {
    const data: RecordState = { version: 1, noticeVersion: NOTICE_VERSION, termsVersion: GEMMA_TERMS_VERSION,
      artifact: GEMMA_ARTIFACT.sha256, page: this.state.page, notices: this.state.notices,
      terms: this.state.terms, completed };
    this.writes = this.writes.catch(() => {}).then(async () => { await this.store.setSetting(SETUP_KEY, JSON.stringify(data)); });
    return this.writes;
  }
  boot() {
    return this.booting ??= (async () => {
      try {
        const raw = await this.store.getSetting(SETUP_KEY);
        const saved = raw ? JSON.parse(raw) as RecordState : null;
        if (saved?.version === 1 && saved.noticeVersion === NOTICE_VERSION && saved.termsVersion === GEMMA_TERMS_VERSION
            && saved.artifact === GEMMA_ARTIFACT.sha256) {
          const notices = saved.notices === true, terms = saved.terms === true;
          const page = Number.isInteger(saved.page) ? Math.max(0, Math.min(4, saved.page)) : 0;
          this.set({ notices, terms, page: !notices ? Math.min(page, 2) : !terms ? Math.min(page, 4) : page });
          if (saved.completed === true && notices && terms) {
            await this.prepare(false, true);
          }
        }
      } catch (error) { this.set({ error: `Could not restore setup: ${String(error)}. You can review and retry.` }); }
      this.set({ booted: true });
    })();
  }
  async go(page: number) {
    if (this.state.busy || this.state.ready || page < 0 || page > 5) return;
    if (page > 2 && !this.state.notices || page > 4 && !this.state.modelReady) return;
    this.set({ page, error: '' });
    try { await this.persist(); } catch (error) { this.set({ error: `Could not save setup progress: ${String(error)}` }); }
  }
  async acknowledge(kind: 'notices' | 'terms', accepted: boolean) {
    if (this.state.busy || this.state.ready) return;
    this.set({ [kind]: accepted, error: '', modelReady: kind === 'terms' && !accepted ? false : this.state.modelReady });
    try { await this.persist(); } catch (error) { this.set({ [kind]: false, error: `Could not save acknowledgment: ${String(error)}` }); }
  }
  cancel() {
    if (!this.state.busy) return;
    this.epoch++;
    this.runtime.cancel();
    this.set({ ready: false, modelReady: false, error: 'Setup interrupted. Return to this screen and retry when ready.' });
  }
  async prepare(allowDownload = true, returning = false) {
    if (this.state.busy || this.state.ready) return;
    if (!this.canRun()) { this.set({ page: 4, recovery: true, error: 'Bring DriveSense to the foreground and retry setup.' }); return; }
    if (!this.state.notices || !this.state.terms) { this.set({ error: 'Acknowledge the safety/privacy notices and Gemma terms before setup.' }); return; }
    if (this.runtime.state.busy) { this.set({ error: 'Gemma is busy. Wait for the current operation to finish and retry.' }); return; }
    const epoch = ++this.epoch;
    const check = () => { if (epoch !== this.epoch || !this.canRun()) throw new Error('Setup interrupted. Retry when the app is active.'); };
    const success = () => { if (this.runtime.state.error) throw new Error(this.runtime.state.error); check(); };
    this.set({ busy: true, error: '', modelReady: false });
    try {
      await this.writes; check();
      await this.runtime.load(); check();
      const replaceable = /Model is missing|Model size is incorrect|Model integrity check failed/.test(this.runtime.state.error);
      if (replaceable && !this.runtime.state.installed && allowDownload) {
        // Existing model missing/corrupt: use the same exclusive staging writer.
        await this.runtime.dispose(); check();
        await this.runtime.provision(); success();
        await this.runtime.load();
      }
      success();
      if (!this.runtime.state.installed || !this.runtime.state.loaded) throw new Error('Verified model initialization did not complete.');
      await this.runtime.dispose(); success();
      if (this.runtime.state.loaded) throw new Error('Model cleanup has not completed. Retry after cleanup.');
      this.set({ page: 5, modelReady: true, recovery: false });
      await this.persist(returning); check();
      if (returning) this.set({ ready: true });
    } catch (error) {
      this.set({ page: 4, recovery: true, error: error instanceof Error ? error.message : String(error) });
      await this.runtime.dispose();
    } finally { this.set({ busy: false }); }
  }
  async complete() {
    if (this.state.busy || !this.state.modelReady || !this.state.notices || !this.state.terms) return false;
    try {
      await this.persist(true);
      this.set({ ready: true, error: '' }); return true;
    } catch (error) { this.set({ error: `Could not save setup completion: ${String(error)}` }); return false; }
  }
}

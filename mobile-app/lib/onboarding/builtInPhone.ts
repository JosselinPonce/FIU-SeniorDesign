import * as repo from '../db/repositories';
import { LEGACY_SETUP_KEY, NOTICE_VERSION, SETUP_KEY } from './setup';

type State = { booted: boolean; busy: boolean; ready: boolean; page: number; notices: boolean; error: string };

class BuiltInSafetySetup {
  state: State = { booted: false, busy: false, ready: false, page: 0, notices: false, error: '' };
  private listeners = new Set<(state: State) => void>();
  private booting?: Promise<void>;

  subscribe(listener: (state: State) => void) {
    this.listeners.add(listener); listener(this.state);
    return () => { this.listeners.delete(listener); };
  }

  private set(change: Partial<State>) {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener(this.state);
  }

  boot() {
    return this.booting ??= (async () => {
      try {
        const raw = await repo.getSetting(SETUP_KEY) ?? await repo.getSetting(LEGACY_SETUP_KEY);
        const saved = JSON.parse(raw ?? 'null');
        if (saved?.noticeVersion === NOTICE_VERSION && [1, 2, 3].includes(saved.version)) {
          const notices = saved.notices === true;
          const page = Number.isInteger(saved.page) ? Math.max(0, Math.min(notices ? 4 : 2, saved.page)) : 0;
          this.set({ notices, page, ready: notices && saved.completed === true });
        }
      } catch { this.set({ error: 'Could not restore setup. You can review and retry.' }); }
      finally { this.set({ booted: true }); }
    })();
  }

  private async save(change: Partial<State>, completed = false) {
    if (this.state.busy || this.state.ready) return false;
    const next = { ...this.state, ...change };
    this.set({ busy: true, error: '' });
    try {
      await repo.setSetting(SETUP_KEY, JSON.stringify({
        version: 3, noticeVersion: NOTICE_VERSION, page: next.page, notices: next.notices, completed,
      }));
      this.set({ ...change, ready: completed });
      return true;
    } catch { this.set({ error: 'Could not save setup progress.' }); return false; }
    finally { this.set({ busy: false }); }
  }

  go(page: number) {
    if (page < 0 || page > 4 || page > 2 && !this.state.notices) return;
    return this.save({ page });
  }

  acknowledge(notices: boolean) { return this.save({ notices }); }
  complete() { return this.state.notices && this.state.page === 4 ? this.save({}, true) : Promise.resolve(false); }
}

export const sensiSetup = new BuiltInSafetySetup();

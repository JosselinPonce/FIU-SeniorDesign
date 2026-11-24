import * as repo from '../db/repositories';
import { DRIVER_INTRO_LAST_PAGE, driverIntroKey } from './driverProgress';
import { LEGACY_SETUP_KEY, NOTICE_VERSION, SETUP_KEY } from './setup';

type State = { booted: boolean; busy: boolean; ready: boolean; page: number; notices: boolean; error: string };

class BuiltInSafetySetup {
  state: State = { booted: false, busy: false, ready: false, page: 0, notices: false, error: '' };
  private listeners = new Set<(state: State) => void>();
  private booting?: Promise<void>;
  constructor(private readonly driverId?: string) {}

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
        if (this.driverId) {
          const legacy = sensiSetup;
          await legacy.boot();
          const key = driverIntroKey(this.driverId);
          const raw = await repo.getSetting(key);
          const saved = raw === null ? {
            version: 1, page: legacy.state.ready ? DRIVER_INTRO_LAST_PAGE : [0, 1, 3, 3, 4][legacy.state.page],
            notices: legacy.state.notices, completed: legacy.state.ready,
          } : JSON.parse(raw);
          if (saved?.version !== 1) throw new Error('Invalid driver introduction progress');
          const page = Number.isInteger(saved.page) ? Math.max(0, Math.min(DRIVER_INTRO_LAST_PAGE, saved.page)) : 0;
          const notices = saved.notices === true;
          const ready = notices && saved.completed === true;
          if (raw === null) await repo.setSetting(key, JSON.stringify({ version: 1, page, notices, completed: ready }));
          this.set({ page, notices, ready });
          return;
        }
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
      await repo.setSetting(this.driverId ? driverIntroKey(this.driverId) : SETUP_KEY, JSON.stringify({
        ...(this.driverId ? { version: 1 } : { version: 3, noticeVersion: NOTICE_VERSION }),
        page: next.page, notices: next.notices, completed,
      }));
      this.set({ ...change, ready: completed });
      return true;
    } catch { this.set({ error: 'Could not save setup progress.' }); return false; }
    finally { this.set({ busy: false }); }
  }

  go(page: number) {
    if (page < 0 || page > (this.driverId ? DRIVER_INTRO_LAST_PAGE : 4) || (!this.driverId && page > 2 && !this.state.notices)) return;
    return this.save({ page });
  }

  acknowledge(notices: boolean) { return this.save({ notices }); }
  complete() { return this.state.notices && this.state.page === (this.driverId ? DRIVER_INTRO_LAST_PAGE : 4) ? this.save({}, true) : Promise.resolve(false); }
}

export const sensiSetup = new BuiltInSafetySetup();

export async function setupForDriver(driverId: string) {
  const setup = new BuiltInSafetySetup(driverId);
  await setup.boot();
  return setup;
}

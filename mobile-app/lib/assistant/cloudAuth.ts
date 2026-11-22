import { demoEmail, DEMO_USERNAME } from './demoStartup.ts';
type Session = { access_token: string; expires_at?: number; user: { id: string } };
type User = { id: string; role?: string; is_anonymous?: boolean; email_confirmed_at?: string; phone_confirmed_at?: string };
export type CloudAuthPort = {
  getSession(): Promise<{ data: { session: Session | null }; error: unknown }>;
  refreshSession(): Promise<{ error: unknown }>;
  getUser(token: string): Promise<{ data: { user: User | null }; error: unknown }>;
  signInWithPassword(input: { email: string; password: string }): Promise<{ error: unknown }>;
  signOut(input: { scope: 'local' }): Promise<{ error: unknown }>;
  onAuthStateChange(fn: (event: string, session: Session | null) => void): { data: { subscription: { unsubscribe(): void } } };
};
export type CloudAuthState = Readonly<{ status: 'signed_out' | 'checking' | 'signed_in' | 'unavailable'; revision: number }>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Independent optional cloud identity. No dashboard admission or driver-data client. */
export function createCloudAuth(auth: CloudAuthPort, storage: { select(remember: boolean): Promise<void>; hasError(): boolean }, options: { demoEmail: string; active(): boolean; timeoutMs?: number; invalidateConsent?(): Promise<void> }) {
  let state: CloudAuthState = Object.freeze({ status: 'signed_out', revision: 0 });
  let credential: { token: string; userId: string; expiresAt: number } | null = null;
  let epoch = 0, allowed = true, signingIn = false, signingOut = false, restoring: Promise<boolean> | null = null;
  const listeners = new Set<(s: CloudAuthState) => void>();
  const emit = (status: CloudAuthState['status']) => {
    state = Object.freeze({ status, revision: state.revision + 1 });
    for (const fn of listeners) { try { fn(state); } catch { /* Observers cannot retain authorization. */ } }
  };
  const clear = (status: CloudAuthState['status'] = 'signed_out') => { epoch++; credential = null; emit(status); };
  const bounded = async <T>(work: Promise<T>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('Cloud identity unavailable.')), options.timeoutMs ?? 12000); })]); }
    finally { clearTimeout(timer); }
  };
  const verify = async (operation: number) => {
    let result = await auth.getSession();
    if (result.error || !result.data.session) return false;
    if (!result.data.session.expires_at || result.data.session.expires_at * 1000 <= Date.now() + 5000) {
      if ((await auth.refreshSession()).error) return false;
      result = await auth.getSession();
    }
    const session = result.data.session;
    if (operation !== epoch || !allowed || !options.active() || storage.hasError() || result.error || !session?.access_token || !session.expires_at || session.expires_at * 1000 <= Date.now() + 5000) return false;
    const checked = await auth.getUser(session.access_token);
    const user = checked.data.user;
    if (operation !== epoch || !allowed || !options.active() || storage.hasError() || checked.error || !user || !UUID.test(user.id) || user.id !== session.user.id
      || user.role !== 'authenticated' || user.is_anonymous === true || !(user.email_confirmed_at || user.phone_confirmed_at)) return false;
    // Recheck session identity after online validation, including token rotation.
    const latest = await auth.getSession();
    if (operation !== epoch || !allowed || !options.active() || storage.hasError() || latest.error || latest.data.session?.access_token !== session.access_token || latest.data.session?.user.id !== user.id) return false;
    credential = { token: session.access_token, userId: user.id, expiresAt: session.expires_at * 1000 };
    emit('signed_in'); return true;
  };
  const api = {
    get state() { return state; },
    subscribe(fn: (s: CloudAuthState) => void) { listeners.add(fn); try { fn(state); } catch { /* Read-only observer. */ } return () => { listeners.delete(fn); }; },
    cachedCredential() { return allowed && options.active() && !storage.hasError() && credential && credential.expiresAt > Date.now() + 5000 ? { ...credential, revision: state.revision } : null; },
    restore(): Promise<boolean> {
      if (!allowed || signingIn || !options.active()) return Promise.resolve(false);
      if (restoring) return restoring;
      clear('checking'); const operation = epoch;
      const work = bounded(verify(operation)).catch(() => false).then(ok => {
        if (operation === epoch && !ok) clear('unavailable'); return ok;
      }).finally(() => { if (restoring === work) restoring = null; });
      restoring = work; return work;
    },
    async signIn(username: string, password: string, remember: boolean) {
      if (signingIn || signingOut || !options.active() || !password) return false;
      const email = username.trim() === DEMO_USERNAME ? demoEmail(DEMO_USERNAME, options.demoEmail) : username.trim();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return false;
      signingIn = true; allowed = true; clear('checking'); const operation = epoch;
      try {
        const work = (async () => {
          await storage.select(remember);
          if (operation !== epoch || !allowed) return false;
          if ((await auth.signInWithPassword({ email, password })).error) return false;
          return verify(operation);
        })();
        const ok = await bounded(work);
        if (!ok && operation === epoch) clear('unavailable'); return ok;
      } catch { if (operation === epoch) clear('unavailable'); return false; }
      finally { signingIn = false; }
    },
    async signOut() {
      signingOut = true; allowed = false; clear(); // Revoke local request authority before any I/O.
      try {
        const cleared = await Promise.allSettled([options.invalidateConsent?.(), storage.select(false)]);
        const signedOut = !(await bounded(auth.signOut({ scope: 'local' }))).error;
        return signedOut && cleared.every(result => result.status === 'fulfilled');
      }
      catch { emit('unavailable'); return false; }
      finally { signingOut = false; }
    },
    suspend() { clear(); },
  };
  auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT' || event === 'USER_DELETED') {
      clear();
      if (!signingOut) void options.invalidateConsent?.().catch(() => {});
    }
    else if (!signingIn && !restoring && allowed && options.active()) {
      clear('checking');
      // Never await Auth inside its own SDK callback/lock.
      setTimeout(() => { if (allowed && !signingIn) void api.restore(); }, 0);
    }
  });
  return api;
}

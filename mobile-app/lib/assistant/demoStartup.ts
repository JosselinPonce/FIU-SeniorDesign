export const DEMO_USERNAME = 'drivesense-demo';
export function demoEmail(username: string, configuredEmail: string): string | null {
  const email = configuredEmail.trim();
  return username.trim() === DEMO_USERNAME && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}
export function startupRoute(enabled: boolean, admitted: boolean, restored: boolean) {
  return !enabled || admitted || restored ? 'dashboard' : 'login';
}
export type StartupAuth = {
  getSession(): Promise<{ data: { session: { access_token: string; expires_at?: number } | null }; error: unknown }>;
  refreshSession(): Promise<{ error: unknown }>;
  getUser(token: string): Promise<{ data: { user: { role?: string; is_anonymous?: boolean; email?: string; email_confirmed_at?: string } | null }; error: unknown }>;
};
/** Online Auth validation is mandatory; offline/error never admits a saved session. */
export async function restoreDemoSession(auth: StartupAuth, email: string, now = Date.now()): Promise<boolean> {
  try {
    let result = await auth.getSession();
    if (result.error || !result.data.session) return false;
    if (!result.data.session.expires_at || result.data.session.expires_at * 1000 <= now) {
      if ((await auth.refreshSession()).error) return false;
      result = await auth.getSession();
    }
    const session = result.data.session;
    if (result.error || !session?.access_token || !session.expires_at || session.expires_at * 1000 <= now) return false;
    const verified = await auth.getUser(session.access_token);
    const user = verified.data.user;
    return !verified.error && !!user && user.role === 'authenticated' && user.is_anonymous !== true
      && !!user.email_confirmed_at && user.email?.toLowerCase() === email.trim().toLowerCase();
  } catch { return false; }
}

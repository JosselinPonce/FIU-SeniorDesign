/** No credentials or SDK errors escape these transient demo operations. */
export type DemoAuth = {
  signInWithPassword(input: { email: string; password: string }): Promise<{ error: unknown }>;
  signOut(input: { scope: 'local' }): Promise<{ error: unknown }>;
};
export async function signInDemo(auth: DemoAuth, email: string, password: string): Promise<boolean> {
  if (!email.trim() || !password) return false;
  try { return !(await auth.signInWithPassword({ email: email.trim(), password })).error; }
  catch { return false; }
}
export async function signOutDemo(auth: DemoAuth): Promise<boolean> {
  // Do not sign out this demo account on teammates' other devices.
  try { return !(await auth.signOut({ scope: 'local' })).error; }
  catch { return false; }
}

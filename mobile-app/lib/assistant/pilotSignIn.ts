import { signInDemo, signOutDemo, type DemoAuth } from './demoAuth.ts';
import { restoreDemoSession, type StartupAuth } from './demoStartup.ts';

/** Non-secret UI build flag only. It grants no Connected/backend readiness. */
export function sensiSignInEnabled(development: boolean, pilotFlag: string | undefined): boolean {
  return development || pilotFlag === 'true';
}

/** Existing-account login only; confirm identity online before reporting success.
 * The server allowlist, not a bundled email or editable metadata, admits the pilot. */
export async function signInConfirmedPilot(auth: DemoAuth & StartupAuth, email: string, password: string): Promise<boolean> {
  if (!email.trim() || !password) return false;
  const signedIn = await signInDemo(auth, email, password);
  if (signedIn && await restoreDemoSession(auth, email)) return true;
  await signOutDemo(auth);
  return false;
}

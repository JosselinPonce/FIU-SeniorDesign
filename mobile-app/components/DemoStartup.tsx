import { useEffect, type ReactNode } from 'react';
import { sensiCloudAuth } from '../lib/assistant/phoneCloudAuth';

/** Optional session restoration never gates onboarding, dashboard, or monitoring. */
export function DemoStartup({ children }: { children: ReactNode }) {
  useEffect(() => { void sensiCloudAuth.restore(); }, []);
  return <>{children}</>;
}

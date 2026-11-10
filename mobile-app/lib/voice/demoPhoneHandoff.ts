/** Fixed NANPA fictional destination, independent of all live contact authority. */
export const DEMO_PHONE_URL = 'tel:+12025550123';
export async function openDemoPhoneInterface(deps: {
  platform: string; version: string | number; current(): boolean;
  canOpen(url: string): Promise<boolean>; open(url: string): Promise<unknown>;
}): Promise<'requested' | 'unsupported' | 'failed' | 'cancelled'> {
  if (!deps.current()) return 'cancelled';
  // iOS 10.3+ requires system confirmation before dialing.
  if (deps.platform !== 'ios' || !(Number.parseFloat(String(deps.version)) >= 10.3)) return 'unsupported';
  try {
    if (!await deps.canOpen(DEMO_PHONE_URL)) return 'unsupported';
    if (!deps.current()) return 'cancelled';
    await deps.open(DEMO_PHONE_URL);
    return 'requested';
  } catch { return 'failed'; }
}

/** Apple documents a mandatory system confirmation for native tel: on iOS 10.3+. */
export function hasSystemPhoneConfirmation(platform: string, version: string | number): boolean {
  return platform === 'ios' && Number.parseFloat(String(version)) >= 10.3;
}
export const REHEARSAL_SAFETY_REVISION = '2C';
export type PhoneHandoffOrigin = {
  source: 'live' | 'rehearsal' | 'demo' | 'standalone';
  episodeId?: string;
};

/** Final platform boundary, after deterministic authorization in SafetyController.
 * Missing/unknown provenance and simulated episode identities fail closed. */
export function openAuthorizedPhoneInterface(phone: string, origin: PhoneHandoffOrigin | undefined,
  current: () => boolean, open: (url: string) => Promise<unknown>): Promise<unknown> {
  if (!origin || origin.source !== 'live' || !origin.episodeId
      || /^(?:rehearsal|demo)(?:$|-)/i.test(origin.episodeId ?? '') || !current()) {
    return Promise.reject(new Error('Phone handoff blocked: simulated or expired interaction.'));
  }
  return openSavedContactInterface(phone, open);
}

/** Separate platform boundary for an explicitly confirmed, one-use simulation permit.
 * Ordinary demo/rehearsal origins remain rejected by the live boundary above. */
export function openConfirmedDemoPhoneInterface(phone: string, authorizeOnce: () => boolean,
  current: () => boolean, open: (url: string) => Promise<unknown>): Promise<unknown> {
  if (!/^\+?[0-9]{7,15}$/.test(phone) || !current() || !authorizeOnce())
    return Promise.reject(new Error('Real-contact demonstration expired or unavailable.'));
  return openSavedContactInterface(phone, open);
}
function openSavedContactInterface(phone: string, open: (url: string) => Promise<unknown>) {
  return open(`tel:${phone}`);
}

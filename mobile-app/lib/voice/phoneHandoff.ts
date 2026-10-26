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
  return open(`tel:${phone}`);
}

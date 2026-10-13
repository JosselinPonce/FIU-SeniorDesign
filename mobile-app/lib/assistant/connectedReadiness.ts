/** Release gate, not a credential or a Settings preference.
 * Change only after separately approved deployment + authenticated staging verification.
 * Do not infer readiness from a URL, publishable key, session, or EXPO_PUBLIC flag. */
export type ConnectedReadiness = Readonly<{ verified: boolean; contractVersion: 1 }>;
export const CONNECTED_BACKEND_READINESS: ConnectedReadiness = Object.freeze({ verified: false, contractVersion: 1 });
export const CONNECTED_UNAVAILABLE = 'CONNECTED AI — Not configured. Authenticated backend deployment and readiness verification are pending.';

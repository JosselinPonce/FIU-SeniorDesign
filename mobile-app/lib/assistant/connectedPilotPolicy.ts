import { CONNECTED_BACKEND_READINESS, type ConnectedReadiness } from './connectedReadiness.ts';

/** Local launch permission only: an opt-in never verifies or enables the server. */
export function connectedPilotReadiness(development: boolean, platform: string, flag: string | undefined): ConnectedReadiness {
  return development && platform === 'ios' && flag === 'true'
    ? Object.freeze({ verified: true, contractVersion: 1 }) : CONNECTED_BACKEND_READINESS;
}

export const CONNECTED_PILOT_STATUS = 'Development pilot · backend access unverified. Server admission may be disabled.';
export const CONNECTED_PILOT_UNAVAILABLE = 'Connected AI is unavailable. Backend admission, authentication or quota may block access. No automatic retry was made.';

/** Display only fixed text, never SDK bodies or upstream exception details. */
export function connectedUnavailableMessage(phase: string, message?: string): string | undefined {
  return phase === 'error' && /^(?:Connected AI is unavailable\.|Invalid Connected AI advisory response\.)/.test(message ?? '')
    ? CONNECTED_PILOT_UNAVAILABLE : undefined;
}

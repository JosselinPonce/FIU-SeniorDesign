import type { SensiPreference } from '../assistant/sensiPreferences';

export const RESPONSE_MODE_SUBTITLES: Record<SensiPreference, string> = {
  automatic: 'Recommended',
  openai: 'Cloud AI when authorized',
  gemma: 'On-device AI',
  basic: 'No generative AI',
};
export const RESPONSE_MODE_SUMMARIES: Record<SensiPreference, string> = {
  automatic: 'Automatic',
  openai: 'OpenAI',
  gemma: 'Gemma',
  basic: 'Basic Offline',
};
export const RESPONSE_MODE_REQUIREMENTS = 'Cloud requires connectivity, a valid sign-in, backend approval, available quota and consent for the current driver. Gemma requires a verified model and a prepared session. Basic responses are predefined and work offline. Safety guidance, interpretation and calling consent follow fixed rules in every mode.';
/** UI copy only; does not implement or change routing policy. */
export const RESPONSE_MODE_DESCRIPTIONS: Record<string, string> = {
  automatic: 'Cloud when authorized and available, then ready Gemma, then basic responses.',
  openai: 'Prefers authorized cloud acknowledgments. Ready Gemma or basic responses remain the fallback.',
  gemma: 'Uses ready, installed Gemma on this device; otherwise basic responses. No cloud requests.',
  basic: 'Predefined offline responses without generative AI. No model download needed.',
};
export const CLOUD_PRIVACY_SUMMARY = 'Cloud AI can personalize acknowledgments. With permission, up to 240 characters from a spoken or typed safety-check response may go to OpenAI. That text may contain sensitive information. Provider retention rules apply; zero retention is not promised.';
export const CLOUD_PRIVACY_DETAILS = "With your consent, a short finalized portion of this driver's spoken or typed VoiceCheck response (up to 240 characters), its recognized feeling and language may be sent through the authenticated DriveSense backend to OpenAI for an acknowledgment. It may contain sensitive information; filtering cannot reliably remove every identifying detail. Audio, readings, profile/contact data and conversation history are not included. Provider retention rules still apply; zero retention is not promised. Signing in does not grant consent. Safety Testing scenarios may use cloud acknowledgments under the same consent.\n\nSafety interpretation, mandatory guidance and calling authorization use local fixed rules. OpenAI only provides an optional acknowledgment and cannot authorize calls. Cloud use also needs a valid session, backend approval and available quota. If unavailable, ready Gemma or predefined responses remain available.\n\nRevoke permission at any time using Cloud processing consent in Sensi Assistant settings. Consent is saved on this device for the signed-in account and selected driver. Signing out or changing accounts clears prior consent. Turning it off immediately blocks new cloud requests; it cannot recall text already transmitted.";
export function acknowledgmentProviderLabel(source: unknown) {
  return source === 'openai' ? 'OpenAI' : source === 'gemma' ? 'On-device Gemma' : source === 'fallback' ? 'Basic Offline' : 'Unknown';
}

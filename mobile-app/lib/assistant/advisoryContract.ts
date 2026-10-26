/** Pure historical advisory envelope validation; no transport or provider. */
const CONTACT = /\b(?:call\w*|dial\w*|phone\w*|contact\w*|consent\w*|authoriz\w*|mom|mum|dad|ambulance|police)\b|\d{3}|(?:https?:|tel:|www\.)/iu;
const fail = (message = 'Advisory fixture unavailable.') => new Error(message);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Exact Stage 4A success envelope. Reject authorization fields/extra keys, never coerce them. */
export function connectedAdvisory(value: unknown): string {
  if (!object(value) || Object.keys(value).sort().join(',') !== 'advisoryOnly,callAuthorized,code,message,status,version'
    || value.version !== 1 || value.advisoryOnly !== true || value.callAuthorized !== false
    || value.status !== 'ok' || value.code !== 'advisory' || typeof value.message !== 'string') throw fail('Invalid advisory fixture response.');
  const message = value.message.trim();
  if (!message || message.length > 600 || /[\d\u0000-\u001f]/u.test(message) || CONTACT.test(message)) throw fail('Invalid advisory fixture response.');
  return message;
}

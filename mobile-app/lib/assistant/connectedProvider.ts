import type { AssistantProvider, GenerationInput } from './provider.ts';
import { CONNECTED_BACKEND_READINESS, CONNECTED_UNAVAILABLE, type ConnectedReadiness } from './connectedReadiness.ts';
import type { DriverInterpretationResponse } from '../../modules/local-foundation-models/index.ts';

// Narrow structural view of the existing Supabase client; never create a second client.
export type ConnectedSession = { access_token: string; expires_at?: number; user: { id: string } };
type AuthUser = { id: string; role?: string; is_anonymous?: boolean; email_confirmed_at?: string; phone_confirmed_at?: string };
export type ConnectedClient = {
  auth: {
    getSession(): Promise<{ data: { session: ConnectedSession | null }; error: unknown }>;
    getUser(token: string): Promise<{ data: { user: AuthUser | null }; error: unknown }>;
    onAuthStateChange(callback: (event: string, session: ConnectedSession | null) => void): { data: { subscription: { unsubscribe(): void } } };
  };
  functions: { invoke(name: string, options: { body: Record<string, unknown>; method: 'POST'; headers: Record<string, string>; signal: AbortSignal }): Promise<{ data: unknown; error: unknown }> };
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTACT = /\b(?:call\w*|dial\w*|phone\w*|contact\w*|consent\w*|authoriz\w*|mom|mum|dad|ambulance|police)\b|\d{3}|(?:https?:|tel:|www\.)/iu;
class ConnectedFailure extends Error {}
function utf8Bytes(text: string): number {
  // Hermes need not supply TextEncoder; JSON.stringify escapes lone surrogates.
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}
const fail = (message = 'Connected AI is unavailable. Please try again when it is safe.') => new ConnectedFailure(message);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Exact Stage 4A success envelope. Reject authorization fields/extra keys, never coerce them. */
export function connectedAdvisory(value: unknown): string {
  if (!object(value) || Object.keys(value).sort().join(',') !== 'advisoryOnly,callAuthorized,code,message,status,version'
    || value.version !== 1 || value.advisoryOnly !== true || value.callAuthorized !== false
    || value.status !== 'ok' || value.code !== 'advisory' || typeof value.message !== 'string') throw fail('Invalid Connected AI advisory response.');
  const message = value.message.trim();
  if (!message || message.length > 600 || /[\d\u0000-\u001f]/u.test(message) || CONTACT.test(message)) throw fail('Invalid Connected AI advisory response.');
  return message;
}
/** No contact/profile/audio/vitals parameters exist. Discard contact-related history pairs. */
export function connectedRequest(input: GenerationInput, requestId: string) {
  const final = input.finalRecognition;
  if (!final || final.status !== 'success' || final.isFinal !== true || final.finalResultReceived !== true
    || final.hasFinalTranscript !== true || final.requiresOnDeviceRecognition !== true || final.locale !== 'en-US'
    || !final.finalTranscript?.trim() || final.finalTranscript.trim() !== input.transcript.trim()
    || input.transcript.trim().length > 500) throw fail('Connected AI requires a successful final offline transcript.');
  if (!UUID.test(requestId)) throw fail('Invalid Connected AI request identity.');
  // Refuse digit strings/links instead of transmitting possible destination numbers.
  if (/\d{3}|(?:https?:|tel:|www\.)/iu.test(input.transcript)) throw fail('This response contains information that cannot be sent to Connected AI.');
  const history = (input.history ?? []).slice(-3).filter(turn => !CONTACT.test(turn.driver) && !CONTACT.test(turn.assistant))
    .flatMap(turn => [{ role: 'user' as const, content: turn.driver.trim().slice(0, 1024) },
      { role: 'assistant' as const, content: turn.assistant.trim().slice(0, 1024) }])
    .filter(turn => !!turn.content && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(turn.content));
  const body = { requestId, transcript: final.finalTranscript.trim(), history };
  const bytes = () => utf8Bytes(JSON.stringify(body));
  while (body.history.length && bytes() > 12_288) body.history.splice(0, 2);
  if (bytes() > 12_288 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(body.transcript)) throw fail('Connected AI input is too large or invalid.');
  return body;
}

export function connectedAssistantProvider(client: ConnectedClient, options: {
  readiness?: ConnectedReadiness;
  requestId(): string;
  timeoutMs?: number;
  onInvalidated?(): void;
}): AssistantProvider {
  const readiness = Object.freeze({ ...(options.readiness ?? CONNECTED_BACKEND_READINESS) });
  const operations = new Map<string, AbortController>();
  let disposed = false;
  let invalidated = false;
  let identity: string | null = null;
  let subscription: { unsubscribe(): void } | undefined;
  const gate = () => {
    if (disposed || invalidated) throw fail('Connected AI conversation cancelled.');
    if (!readiness.verified || readiness.contractVersion !== 1) throw fail(CONNECTED_UNAVAILABLE);
  };
  const abortAll = () => { for (const operation of operations.values()) operation.abort(); };
  async function operation<T>(id: string, action: (signal: AbortSignal, check: () => void) => Promise<T>): Promise<T> {
    gate();
    if (operations.has(id)) throw fail('Connected AI request is already active.');
    const controller = new AbortController(); operations.set(id, controller);
    const check = () => { gate(); if (controller.signal.aborted || operations.get(id) !== controller) throw fail('Connected AI request cancelled.'); };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const interrupted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(fail('Connected AI request cancelled or timed out.')), { once: true });
      timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 25_000);
    });
    try { return await Promise.race([action(controller.signal, check), interrupted]); }
    catch (error) { throw error instanceof ConnectedFailure ? error : fail(); }
    finally { clearTimeout(timer); if (operations.get(id) === controller) operations.delete(id); }
  }
  async function authenticated(check: () => void): Promise<ConnectedSession> {
    check();
    const { data, error } = await client.auth.getSession(); check();
    const session = data.session;
    if (error || !session?.access_token || !UUID.test(session.user.id)
      || !session.expires_at || session.expires_at * 1000 <= Date.now()) throw fail('Sign in with an authenticated demo account to use Connected AI.');
    const verified = await client.auth.getUser(session.access_token); check();
    const user = verified.data.user;
    if (verified.error || !user || user.id !== session.user.id || user.role !== 'authenticated' || user.is_anonymous === true
      || !(user.email_confirmed_at || user.phone_confirmed_at)) throw fail('A verified demo account is required for Connected AI.');
    if (identity && identity !== user.id) throw fail('Connected AI account changed. Start a new interaction.');
    return session;
  }
  async function sameSession(session: ConnectedSession, check: () => void) {
    const current = await client.auth.getSession(); check();
    if (current.error || current.data.session?.user.id !== session.user.id
      || current.data.session.access_token !== session.access_token
      || !current.data.session.expires_at || current.data.session.expires_at * 1000 <= Date.now()) throw fail('Connected AI account or session changed. Start again.');
  }
  return {
    mode: 'connected',
    async prepare() {
      await operation('prepare', async (_signal, check) => {
        const session = await authenticated(check);
        await sameSession(session, check);
        identity = session.user.id;
        if (!subscription) subscription = client.auth.onAuthStateChange((_event, next) => {
          if (identity && next?.user.id !== identity) {
            invalidated = true; abortAll(); options.onInvalidated?.();
          }
        }).data.subscription;
      });
    },
    async generate(input, id): Promise<DriverInterpretationResponse> {
      const started = Date.now();
      return operation(id, async (signal, check) => {
        if (!identity) throw fail('Connected AI must be prepared with a verified demo account.');
        // Validate proof BEFORE any auth or generation network request.
        const body = connectedRequest(input, options.requestId());
        const session = await authenticated(check);
        await sameSession(session, check);
        const response = await client.functions.invoke('driver-assistant', { body, method: 'POST',
          headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' }, signal });
        check();
        if (response.error) throw fail(); // Never log/expose response bodies, credentials or upstream errors.
        const message = connectedAdvisory(response.data);
        await sameSession(session, check);
        return { status: 'success', processingTimeMs: Date.now() - started, interpretation: {
          wellness: 'uncertain', requestsSavedEmergencyContact: false, explicitContactRequest: false,
          suggestedReply: message, advisoryOnly: true, callAuthorized: false,
        } };
      });
    },
    async cancel(id) { operations.get(id)?.abort(); },
    dispose() { disposed = true; abortAll(); subscription?.unsubscribe(); subscription = undefined; identity = null; },
    isCurrent: () => !disposed && !invalidated,
  };
}

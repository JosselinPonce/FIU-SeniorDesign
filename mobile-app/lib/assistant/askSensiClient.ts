import { abortable } from '../../supabase/functions/_shared/abort.ts';
import { MAX_ASK_ANSWER, type AskRequest } from '../../supabase/functions/_shared/askSensi.ts';

export type AskCredential = { userId: string; revision: number; token: string };
export type AskAuthority = { credential: AskCredential | null; enabled: boolean; active: boolean; sharingApproved: boolean; safetySharingApproved?: boolean };
export type AskError = 'auth' | 'consent' | 'inactive' | 'offline' | 'busy' | 'quota' | 'denied' | 'unavailable';
export type AskResult = { ok: true; message: string; historySupported?: true } | { ok: false; error: AskError; retryAfterSeconds?: number };

export function askSensiPreferenceKey(accountId: string, driverId: string): string {
  if (!/^[a-zA-Z0-9-]+$/.test(accountId) || !/^[a-zA-Z0-9-]+$/.test(driverId)) throw new Error('Invalid Ask Sensi preference scope.');
  return 'drivesense.ask-sensi.v1.' + accountId + '.' + driverId;
}

export function askSensiSharingKey(accountId: string, driverId: string): string {
  return askSensiPreferenceKey(accountId, driverId) + '.remember-sharing';
}

export function retryAfterSeconds(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = /^\d+$/.test(value) ? Number(value)
    : /GMT$/i.test(value) ? Math.ceil((Date.parse(value) - now) / 1000) : NaN;
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : undefined;
}

export function createAskSensiClient(options: {
  url: string; publicKey: string; fetcher?: typeof fetch; timeoutMs?: number;
}) {
  let endpoint = '';
  try {
    const url = new URL(options.url);
    if (url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash)
      endpoint = url.origin + '/functions/v1/ask-sensi';
  } catch { /* Optional feature stays unavailable without configuration. */ }

  return async (request: AskRequest, authority: () => AskAuthority, signal: AbortSignal): Promise<AskResult> => {
    const initial = authority();
    if (signal.aborted || !initial.active) return { ok: false, error: 'inactive' };
    if (!initial.credential) return { ok: false, error: 'auth' };
    if (!initial.enabled || (request.context && !initial.sharingApproved) || (request.version === 3 && !initial.safetySharingApproved)) return { ok: false, error: 'consent' };
    if (!endpoint || !options.publicKey) return { ok: false, error: 'unavailable' };
    const identity = initial.credential;
    const current = () => {
      const now = authority();
      return now.active && now.enabled && (!request.context || now.sharingApproved) && (request.version !== 3 || now.safetySharingApproved) && identity.userId === now.credential?.userId
        && identity.revision === now.credential.revision && identity.token === now.credential.token;
    };
    const abort = new AbortController();
    const stop = () => abort.abort();
    signal.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(stop, options.timeoutMs ?? 25_000);
    try {
      const body = JSON.stringify(request, (key, value) => key === 'localTime' || key === 'warningGroups' ? undefined : value);
      const localTime = request.context?.date ? request.context.localTime : undefined;
      if (signal.aborted || !current()) return { ok: false, error: 'inactive' };
      const response = await abortable((options.fetcher ?? fetch)(endpoint, {
        method: 'POST', redirect: 'error', signal: abort.signal,
        headers: { apikey: options.publicKey, Authorization: 'Bearer ' + identity.token,  'Content-Type': 'application/json',
          ...(localTime ? { 'X-Ask-Sensi-Drive-Local-Time': localTime } : {}) },
        body,
      }), abort.signal);
      if (!current()) return { ok: false, error: 'inactive' };
      if (response.status === 401) return { ok: false, error: 'auth' };
      if (response.status === 403) return { ok: false, error: 'denied' };
      const limited = response.status === 429;
      const delay = limited ? retryAfterSeconds(response.headers.get('Retry-After')) : undefined;
      const limitError = { ok: false, error: 'quota', ...(delay === undefined ? {} : { retryAfterSeconds: delay }) } as const;
      if ((!response.ok && !limited) || Number(response.headers.get('Content-Length')) > 16_384)
        return limited ? limitError : { ok: false, error: 'unavailable' };
      const wire = await abortable(response.text(), abort.signal);
      if (!current()) return { ok: false, error: 'inactive' };
      if (limited) {
        if (wire.length <= 16_384) {
          try {
            const data = JSON.parse(wire);
            if (data?.kind === 'ask_sensi' && data.code === 'busy') return { ...limitError, error: 'busy' };
          } catch { /* Gateway responses can omit the Ask error envelope. */ }
        }
        return limitError;
      }
      if (wire.length > 16_384) return { ok: false, error: 'unavailable' };
      const data = JSON.parse(wire);
      if (data?.version !== 1 || data.kind !== 'ask_sensi' || data.status !== 'ok' || data.code !== 'advisory'
        || data.advisoryOnly !== true || data.callAuthorized !== false || typeof data.message !== 'string'
        || !data.message.trim() || data.message.length > MAX_ASK_ANSWER) return { ok: false, error: 'unavailable' };
      return { ok: true, message: data.message,
        ...(response.headers.get('X-Ask-Sensi-History') === '2' ? { historySupported: true as const } : {}) };
    } catch (error) {
      return { ok: false, error: signal.aborted || !current() ? 'inactive'
        : abort.signal.aborted || error instanceof SyntaxError ? 'unavailable' : 'offline' };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      abort.abort();
    }
  };
}

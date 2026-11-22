import { CLOUD_TIMEOUT_MS } from '../../supabase/functions/_shared/acknowledgmentTiming.ts';
import { abortable } from '../../supabase/functions/_shared/abort.ts';
import { acknowledgmentFeeling, canGenerateAcknowledgment, validateAcknowledgment, type AcknowledgmentContext } from './safetyAcknowledgment.ts';
import { boundedJson } from '../../supabase/functions/driver-assistant/contracts.ts';
type Auth = {
  cachedCredential(): { token: string; userId: string; revision: number } | null;
  subscribe(fn: () => void): () => void;
};
/** Auth is verified ahead of events; this path never refreshes or signs in.
 * The sole transport is the authenticated, quota-enforcing Supabase function. */
export function createOpenAIAcknowledgment(auth: Auth, options: {
  url: string; publicKey: string; requestId(): string; fetcher?: typeof fetch; timeoutMs?: number;
}) {
  let endpoint = '', unavailableUntil = 0;
  try {
    const url = new URL(options.url);
    if (url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash)
      endpoint = `${url.origin}/functions/v1/driver-assistant`;
  } catch { /* Invalid configuration stays offline. */ }
  return {
    identity: () => { const credential = auth.cachedCredential(); return credential ? `${credential.userId}:${credential.revision}` : null; },
    ready: () => !!endpoint && !!options.publicKey && performance.now() >= unavailableUntil && !!auth.cachedCredential(),
    async generate(context: AcknowledgmentContext, parent: AbortSignal, authority?: { driverId: string; current(): boolean }): Promise<string> {
      const identity = auth.cachedCredential(), feeling = acknowledgmentFeeling(context);
      if (!authority?.driverId || !authority.current() || !identity || !canGenerateAcknowledgment(context) || !endpoint || !options.publicKey || parent.aborted || performance.now() < unavailableUntil) return '';
      const requestId = options.requestId();
      const abort = new AbortController(), stop = () => abort.abort();
      const deadline = performance.now() + (options.timeoutMs ?? CLOUD_TIMEOUT_MS);
      const timer = setTimeout(stop, options.timeoutMs ?? CLOUD_TIMEOUT_MS);
      parent.addEventListener('abort', stop, { once: true });
      const current = () => {
        const now = auth.cachedCredential();
        return authority.current() && !!now && now.token === identity.token && now.userId === identity.userId && now.revision === identity.revision;
      };
      const unsubscribe = auth.subscribe(() => { if (!current()) stop(); });
      try {
        // No await/callback between the final policy/session check and dispatch.
        const body = JSON.stringify({ version: 3, requestId, language: context.language, feeling, utterance: context.utterance ?? null });
        if (parent.aborted || abort.signal.aborted || !current()) return '';
        const response = await abortable((options.fetcher ?? fetch)(endpoint, {
          method: 'POST', redirect: 'error', signal: abort.signal,
          headers: { apikey: options.publicKey, Authorization: `Bearer ${identity.token}`, 'Content-Type': 'application/json' },
          body,
        }), abort.signal);
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          unavailableUntil = performance.now() + (response.status === 429 ? 60000 : 30000);
          return '';
        }
        const value = await boundedJson(response.body, 2048, Math.max(1, deadline - performance.now()), abort.signal);
        if (abort.signal.aborted || parent.aborted || !current() || performance.now() >= deadline || !value || typeof value !== 'object') return '';
        const data = value as Record<string, unknown>;
        if (Object.keys(data).sort().join(',') !== 'advisoryOnly,callAuthorized,code,message,requestId,status,version'
          || data.version !== 3 || data.requestId !== requestId || data.advisoryOnly !== true || data.callAuthorized !== false
          || data.status !== 'ok' || data.code !== 'advisory') return '';
        return validateAcknowledgment(data.message, context) ?? '';
      } catch {
        if (!parent.aborted && current()) unavailableUntil = performance.now() + 30000;
        return '';
      } finally { clearTimeout(timer); unsubscribe(); parent.removeEventListener('abort', stop); abort.abort(); }
    },
  };
}

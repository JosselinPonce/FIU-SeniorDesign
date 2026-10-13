import { boundedJson, record, SafeError, UUID, type AssistantRequest } from './contracts.ts';
import { generate } from './provider.ts';

export type Reservation = { code: 'reserved' | 'disabled' | 'not_allowed' | 'duplicate' | 'conflict' | 'quota' | 'busy' };
export type Completion = { inputTokens: number; outputTokens: number; success: boolean };
export type Backend = {
  enabled(): boolean;
  authenticate(token: string): Promise<string | null>;
  fingerprint(userId: string, request: AssistantRequest): Promise<string>;
  reserve(userId: string, requestId: string, fingerprint: string, lease: string): Promise<Reservation>;
  dispatch(userId: string, requestId: string, lease: string): Promise<boolean>;
  complete(userId: string, requestId: string, lease: string, result: Completion): Promise<void>;
  generate(request: AssistantRequest): Promise<{ message: string; inputTokens: number; outputTokens: number }>;
  log(metadata: { event: string; status: number; elapsedMs: number }): void;
};
export function createBackend(env: (key: string) => string | undefined, fetcher: typeof fetch = fetch): Backend {
  const serviceKey = () => env('SUPABASE_SERVICE_ROLE_KEY') || '';
  const baseUrl = () => {
    const url = new URL(env('SUPABASE_URL') || '');
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new SafeError(503, 'not_configured');
    return url.origin;
  };
  async function rpc(name: string, params: Record<string, unknown>): Promise<unknown> {
    const response = await fetcher(`${baseUrl()}/rest/v1/rpc/${name}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(3000),
      headers: { apikey: serviceKey(), Authorization: `Bearer ${serviceKey()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new SafeError(503, 'backend_unavailable'); }
    return boundedJson(response.body, 2048, 3000);
  }
  return {
    enabled: () => env('DRIVER_ASSISTANT_ENABLED') === 'true' && !!env('OPENAI_API_KEY')
      && !!serviceKey() && (env('DRIVER_ASSISTANT_FINGERPRINT_KEY')?.length ?? 0) >= 32 && !!env('SUPABASE_URL'),
    async authenticate(token) {
      // Auth validates the bearer token online; no decoded-but-unverified JWT trust.
      if (token === serviceKey() || token === env('SUPABASE_ANON_KEY') || token === env('SUPABASE_PUBLISHABLE_KEY')) return null;
      const response = await fetcher(`${baseUrl()}/auth/v1/user`, {
        redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { apikey: serviceKey(), Authorization: `Bearer ${token}` },
      });
      if (response.status === 401 || response.status === 403) { void response.body?.cancel().catch(() => {}); return null; }
      if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new SafeError(503, 'auth_unavailable'); }
      const user = await boundedJson(response.body, 16_384, 5000);
      return record(user) && typeof user.id === 'string' && UUID.test(user.id) && user.role === 'authenticated'
        && user.is_anonymous !== true && !!(user.email_confirmed_at || user.phone_confirmed_at)
        ? user.id.toLowerCase() : null;
    },
    async fingerprint(userId, request) {
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env('DRIVER_ASSISTANT_FINGERPRINT_KEY')),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(JSON.stringify({ userId, ...request })));
      return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    },
    async reserve(userId, requestId, fingerprint, lease) {
      const result = await rpc('driver_assistant_reserve', { p_user: userId, p_request: requestId, p_fingerprint: fingerprint, p_lease: lease });
      const codes = ['reserved', 'disabled', 'not_allowed', 'duplicate', 'conflict', 'quota', 'busy'];
      if (!record(result) || typeof result.code !== 'string' || !codes.includes(result.code)) throw new SafeError(503, 'backend_unavailable');
      return result as Reservation;
    },
    async dispatch(userId, requestId, lease) {
      return (await rpc('driver_assistant_dispatch', { p_user: userId, p_request: requestId, p_lease: lease })) === true;
    },
    async complete(userId, requestId, lease, result) {
      const completed = await rpc('driver_assistant_complete', { p_user: userId, p_request: requestId, p_lease: lease,
        p_success: result.success, p_input_tokens: result.inputTokens, p_output_tokens: result.outputTokens });
      if (completed !== true) throw new SafeError(503, 'backend_unavailable');
    },
    generate: request => generate(request, env('OPENAI_API_KEY') || '', fetcher),
    // Fixed operational fields only. Never log exceptions or upstream response bodies.
    log: metadata => console.info(JSON.stringify({ component: 'driver-assistant', ...metadata })),
  };
}

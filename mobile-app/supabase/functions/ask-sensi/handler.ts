import { boundedJson, SafeError } from '../driver-assistant/contracts.ts';
import { abortable } from '../_shared/abort.ts';
import { AskProviderRateLimit } from './provider.ts';
import type { AskBackend } from './backend.ts';
import { MAX_ASK_BODY_BYTES, validateAskRequest } from './contract.ts';

export const ASK_SERVER_TIMEOUT_MS = 20_000;

export function createAskHandler(backend: AskBackend) {
  return async (req: Request): Promise<Response> => {
    const started = Date.now();
    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(ASK_SERVER_TIMEOUT_MS)]);
    let reservation: { user: string; requestId: string; lease: string } | undefined;
    const respond = (status: number, code: string, message: string, retryAfter?: string | null) => {
      try { backend.log({ event: code, status, elapsedMs: Date.now() - started }); }
      catch { /* Logging failure must not expose content or prevent a safe response. */ }
      return Response.json({ version: 1, kind: 'ask_sensi', advisoryOnly: true, callAuthorized: false, message, status: status === 200 ? 'ok' : 'unavailable', code }, {
        status, headers: { 'Cache-Control': 'no-store', 'X-Ask-Sensi-History': '2', 'X-Content-Type-Options': 'nosniff',
          ...(status === 405 ? { Allow: 'POST' } : {}), ...(retryAfter ? { 'Retry-After': retryAfter } : {}) },
      });
    };
    try {
      // Native-only foundation: no permissive browser CORS or unauthenticated OPTIONS.
      if (req.method !== 'POST') throw new SafeError(405, 'method_not_allowed');
      if ((req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() !== 'application/json') throw new SafeError(415, 'unsupported_media_type');
      const length = req.headers.get('content-length');
      if (length && (!/^\d+$/.test(length) || Number(length) > MAX_ASK_BODY_BYTES)) throw new SafeError(413, 'request_too_large');
      if (req.headers.has('content-encoding') && req.headers.get('content-encoding') !== 'identity') throw new SafeError(415, 'unsupported_media_type');
      if (!backend.enabled()) throw new SafeError(503, 'not_configured');
      const authorization = req.headers.get('authorization') || '';
      const bearer = /^Bearer ([A-Za-z0-9._~-]{1,4096})$/i.exec(authorization);
      if (!bearer) throw new SafeError(401, 'authentication_required');
      const user = await abortable(backend.authenticate(bearer[1]), signal);
      if (!user) throw new SafeError(401, 'authentication_required');
      const request = validateAskRequest(await boundedJson(req.body, MAX_ASK_BODY_BYTES, 4000, signal));
      const localTime = req.headers.get('X-Ask-Sensi-Drive-Local-Time');
      if (localTime !== null) {
        if (!request.context?.date || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(localTime)) throw new SafeError(400, 'invalid_request');
        request.context.localTime = localTime;
      }
      signal.throwIfAborted();
      const lease = crypto.randomUUID();
      const fingerprint = await abortable(backend.fingerprint(user, request), signal);
      signal.throwIfAborted();
      const result = await backend.reserve(user, request.requestId, fingerprint, lease);
      const denied = { disabled: [503, 'disabled'], not_allowed: [403, 'not_allowed'], duplicate: [409, 'duplicate_request'],
        conflict: [409, 'request_conflict'], quota: [429, 'quota_exceeded'], busy: [429, 'busy'] } as const;
      if (result.code !== 'reserved') {
        const [status, code] = denied[result.code];
        throw new SafeError(status, code);
      }
      reservation = { user, requestId: request.requestId, lease };
      // Recheck database kill switch and allowlist immediately before dispatch.
      signal.throwIfAborted();
      if (!backend.enabled() || !await abortable(backend.dispatch(user, request.requestId, lease), signal) || !backend.enabled()) throw new SafeError(503, 'disabled');
      signal.throwIfAborted();
      const output = await abortable(backend.generate(request, signal), signal);
      signal.throwIfAborted();
      await backend.complete(user, request.requestId, lease, { ...output, success: true });
      reservation = undefined;
      signal.throwIfAborted();
      return respond(200, 'advisory', output.message);
    } catch (error) {
      if (reservation) {
        try { await backend.complete(reservation.user, reservation.requestId, reservation.lease, { success: false, inputTokens: 0, outputTokens: 0 }); }
        catch { /* Lease expires; reservation remains charged. Never fail open. */ }
      }
      const safe = signal.aborted ? new SafeError(408, 'request_timeout') : error instanceof SafeError ? error : new SafeError(503, 'service_unavailable');
      return respond(safe.status, safe.code, 'Ask Sensi is unavailable. You can still use DriveSense History and help.',
        !signal.aborted && error instanceof AskProviderRateLimit ? error.retryAfter : null);
    }
  };
}

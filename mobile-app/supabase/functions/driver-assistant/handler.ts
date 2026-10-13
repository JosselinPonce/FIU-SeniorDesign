import { advisory, boundedJson, MAX_BODY_BYTES, SafeError, validateRequest } from './contracts.ts';
import type { Backend } from './backend.ts';

export function createHandler(backend: Backend) {
  return async (req: Request): Promise<Response> => {
    const started = Date.now();
    let reservation: { user: string; requestId: string; lease: string } | undefined;
    const respond = (status: number, code: string, message: string) => {
      try { backend.log({ event: code, status, elapsedMs: Date.now() - started }); }
      catch { /* Logging failure must not expose content or prevent a safe response. */ }
      return Response.json({ ...advisory(message), status: status === 200 ? 'ok' : 'unavailable', code }, {
        status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
          ...(status === 405 ? { Allow: 'POST' } : {}), ...(status === 429 ? { 'Retry-After': '60' } : {}) },
      });
    };
    try {
      // Native-only foundation: no permissive browser CORS or unauthenticated OPTIONS.
      if (req.method !== 'POST') throw new SafeError(405, 'method_not_allowed');
      if ((req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() !== 'application/json') throw new SafeError(415, 'unsupported_media_type');
      const length = req.headers.get('content-length');
      if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) throw new SafeError(413, 'request_too_large');
      if (req.headers.has('content-encoding') && req.headers.get('content-encoding') !== 'identity') throw new SafeError(415, 'unsupported_media_type');
      if (!backend.enabled()) throw new SafeError(503, 'not_configured');
      const authorization = req.headers.get('authorization') || '';
      const bearer = /^Bearer ([A-Za-z0-9._~-]{1,4096})$/i.exec(authorization);
      if (!bearer) throw new SafeError(401, 'authentication_required');
      const user = await backend.authenticate(bearer[1]);
      if (!user) throw new SafeError(401, 'authentication_required');
      const request = validateRequest(await boundedJson(req.body, MAX_BODY_BYTES));
      if (req.signal.aborted) throw new SafeError(408, 'request_timeout');
      const lease = crypto.randomUUID();
      const result = await backend.reserve(user, request.requestId, await backend.fingerprint(user, request), lease);
      const denied = { disabled: [503, 'disabled'], not_allowed: [403, 'not_allowed'], duplicate: [409, 'duplicate_request'],
        conflict: [409, 'request_conflict'], quota: [429, 'quota_exceeded'], busy: [429, 'busy'] } as const;
      if (result.code !== 'reserved') {
        const [status, code] = denied[result.code];
        throw new SafeError(status, code);
      }
      reservation = { user, requestId: request.requestId, lease };
      // Recheck database kill switch and allowlist immediately before dispatch.
      if (req.signal.aborted || !backend.enabled() || !await backend.dispatch(user, request.requestId, lease)) throw new SafeError(503, 'disabled');
      const output = await backend.generate(request);
      await backend.complete(user, request.requestId, lease, { ...output, success: true });
      reservation = undefined;
      return respond(200, 'advisory', output.message);
    } catch (error) {
      if (reservation) {
        try { await backend.complete(reservation.user, reservation.requestId, reservation.lease, { success: false, inputTokens: 0, outputTokens: 0 }); }
        catch { /* Lease expires; reservation remains charged. Never fail open. */ }
      }
      const safe = error instanceof SafeError ? error : new SafeError(503, 'service_unavailable');
      return respond(safe.status, safe.code, 'Connected AI is unavailable. Use the app’s safety controls.');
    }
  };
}

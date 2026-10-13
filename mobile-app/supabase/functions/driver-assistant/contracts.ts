/** Backend-only contract. No provider output is an action or consent signal. */
export const MAX_BODY_BYTES = 12_288;
export const MAX_TRANSCRIPT_CHARS = 2048;
export const MAX_HISTORY = 6;
export const MAX_HISTORY_CHARS = 1024;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type AssistantRequest = {
  requestId: string;
  transcript: string;
  history: { role: 'user' | 'assistant'; content: string }[];
};
export class SafeError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) { super(code); this.status = status; this.code = code; }
}
export function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(k => !allowed.includes(k))) throw new SafeError(400, 'invalid_request');
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value))
    throw new SafeError(400, 'invalid_request');
  return value.trim();
}
export function validateRequest(value: unknown): AssistantRequest {
  if (!record(value)) throw new SafeError(400, 'invalid_request');
  exactKeys(value, ['requestId', 'transcript', 'history']);
  if (typeof value.requestId !== 'string' || !UUID.test(value.requestId)) throw new SafeError(400, 'invalid_request');
  const transcript = text(value.transcript, MAX_TRANSCRIPT_CHARS);
  if (!Array.isArray(value.history) || value.history.length > MAX_HISTORY) throw new SafeError(400, 'invalid_request');
  const history = value.history.map((turn): AssistantRequest['history'][number] => {
    if (!record(turn)) throw new SafeError(400, 'invalid_request');
    exactKeys(turn, ['role', 'content']);
    if (turn.role !== 'user' && turn.role !== 'assistant') throw new SafeError(400, 'invalid_request');
    return { role: turn.role, content: text(turn.content, MAX_HISTORY_CHARS) };
  });
  return { requestId: value.requestId.toLowerCase(), transcript, history };
}
/** Counts actual streamed bytes, not a caller-controlled Content-Length header. */
export async function boundedJson(body: ReadableStream<Uint8Array> | null, maxBytes: number, timeoutMs = 4000): Promise<unknown> {
  if (!body) throw new SafeError(400, 'invalid_request');
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new SafeError(408, 'request_timeout')); void reader.cancel().catch(() => {}); }, timeoutMs);
  });
  try {
    while (true) {
      const chunk = await Promise.race([reader.read(), timeout]);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new SafeError(413, 'request_too_large');
      chunks.push(chunk.value);
    }
    const all = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(all)); }
    catch { throw new SafeError(400, 'invalid_request'); }
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
}
export function advisory(message: string) {
  // The model never supplies these fields. Errors use the same closed boundary.
  return { version: 1, advisoryOnly: true, callAuthorized: false, message } as const;
}

export type HashResult = { requestId: string; bytes: number; sha256: string };
export type HashBridge = {
  hashFile(uri: string, requestId: string, expectedBytes: number): Promise<HashResult>;
  cancelHash(requestId: string): Promise<void>;
  addListener(event: 'hashProgress', listener: (event: { requestId: string; bytes: number; total: number }) => void): { remove(): void };
};
let sequence = 0;

/** Keep the promise pending until native has closed its file descriptor. The
 * provisioning owner may stop waiting for UI cleanup, but cannot reuse the file. */
export async function verifyNativeFile(bridge: HashBridge, uri: string,
  expected: { bytes: number; sha256: string }, signal: AbortSignal, progress?: (bytes: number) => void) {
  const check = () => { if (signal.aborted) throw new Error('Model verification cancelled.'); };
  check();
  const id = `sha256-${Date.now()}-${++sequence}`;
  let active = true;
  let last = -1;
  const subscription = bridge.addListener('hashProgress', event => {
    if (!active || signal.aborted || event.requestId !== id || event.total !== expected.bytes
      || !Number.isSafeInteger(event.bytes) || event.bytes < 0 || event.bytes > expected.bytes || event.bytes <= last) return;
    last = event.bytes;
    progress?.(event.bytes);
  });
  const cancel = () => { void Promise.resolve().then(() => bridge.cancelHash(id)).catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    check();
    const result = await bridge.hashFile(uri, id, expected.bytes);
    check();
    if (result.requestId !== id || result.bytes !== expected.bytes || result.sha256 !== expected.sha256)
      throw new Error('Model integrity check failed. Provision the approved artifact again.');
    return true;
  } finally {
    active = false;
    signal.removeEventListener('abort', cancel);
    subscription.remove();
  }
}

/** Reject even if a transport ignores cancellation; never publish late work. */
export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const stop = () => { cleanup(); reject(new Error('Operation cancelled.')); };
    const cleanup = () => signal.removeEventListener('abort', stop);
    if (signal.aborted) { void work.catch(() => {}); stop(); return; }
    signal.addEventListener('abort', stop, { once: true });
    work.then(value => { cleanup(); signal.aborted ? reject(new Error('Operation cancelled.')) : resolve(value); }, error => { cleanup(); reject(error); });
  });
}

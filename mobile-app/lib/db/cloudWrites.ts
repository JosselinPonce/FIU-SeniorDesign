// A deletion must follow any upload already using these local rows.
let tail: Promise<unknown> = Promise.resolve();
export function serializeCloudWrite<T>(operation: () => Promise<T>): Promise<T> {
  const next = tail.then(operation, operation);
  tail = next.catch(() => {});
  return next;
}

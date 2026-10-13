/** One noncritical information sheet; safety preemption never queues a reopen. */
export type Information = Readonly<{ title: string; body: string }>;
export function createInformationState() {
  let blocked = false;
  let current: Information | null = null;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach(listener => listener());
  return {
    getSnapshot: () => current,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    open(information: Information) {
      if (blocked) return false;
      current = information; notify(); return true;
    },
    close() { current = null; notify(); },
    block(value: boolean) { blocked = value; if (value) { current = null; notify(); } },
  };
}

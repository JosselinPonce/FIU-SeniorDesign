/** Nonpersistent UI state: dismissal survives entry unmounts for this JS app session. */
export function createSensiGreeting() {
  let visible = true;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => visible,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dismiss() { if (!visible) return; visible = false; listeners.forEach(listener => listener()); },
  };
}
export const sensiGreeting = createSensiGreeting();

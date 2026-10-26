// Historical test fixture only. Never import from application code.
import { CONNECTED_BACKEND_READINESS, type ConnectedReadiness } from './connectedReadiness.ts';

/** Chooses optional generation and safety presentation only; live safety decisions remain deterministic. */
export type AssistantMode = 'core' | 'local' | 'connected';
export const ASSISTANT_MODE_KEY = 'assistant_mode';
export const ASSISTANT_MODES = [
  { key: 'core', title: 'CORE', body: 'Existing deterministic wellness checks and warning demo tools.' },
  { key: 'local', title: 'GEMMA · ON DEVICE', body: 'Event-triggered safety checks with optional allowlisted empathy. Safety decisions remain deterministic.' },
  { key: 'connected', title: 'CONNECTED AI — Legacy / inactive', body: 'Retained for development. Live Sensi uses Gemma; no cloud inference is enabled.' },
] as const;

export function isAssistantMode(value: unknown): value is AssistantMode {
  return value === 'core' || value === 'local' || value === 'connected';
}

export function assistantModeSettings(store: {
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
}) {
  return {
    async load(): Promise<AssistantMode> {
      const saved = await store.getSetting(ASSISTANT_MODE_KEY);
      // Local now means event-only Gemma. Legacy cloud selections cannot launch it.
      return saved === 'core' ? 'core' : 'local';
    },
    async save(mode: AssistantMode): Promise<void> {
      if (!isAssistantMode(mode)) throw new Error('Invalid Assistant Mode.');
      await store.setSetting(ASSISTANT_MODE_KEY, mode);
    },
  };
}

/** A launch has no dialogue/consent state and cannot change with later settings. */
export function snapshotAssistantLaunch(mode: AssistantMode, readiness: ConnectedReadiness = CONNECTED_BACKEND_READINESS) {
  return Object.freeze({ mode, destination: mode === 'core' ? 'core-tools' as const
    : mode === 'local' ? 'local' as const : readiness.verified && readiness.contractVersion === 1 ? 'connected' as const : 'unavailable' as const });
}
export type AssistantLaunch = ReturnType<typeof snapshotAssistantLaunch>;

export function routeAssistantLaunch(launch: AssistantLaunch, routes: {
  coreTools(): void;
  local(): void;
  connected?(): void;
}): void {
  if (launch.destination === 'core-tools') routes.coreTools();
  if (launch.destination === 'local') routes.local();
  if (launch.destination === 'connected') routes.connected?.();
  // Unavailable launches invoke nothing; never switch to a different mode.
}

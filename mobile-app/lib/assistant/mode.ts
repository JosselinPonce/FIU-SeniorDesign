/** Optional assistant selection only. Live warnings never read this setting. */
export type AssistantMode = 'core' | 'local' | 'connected';
export const ASSISTANT_MODE_KEY = 'assistant_mode';
export const ASSISTANT_MODES = [
  { key: 'core', title: 'CORE', body: 'Existing deterministic wellness checks and warning demo tools.' },
  { key: 'local', title: 'LOCAL AI', body: 'Apple Foundation Models with on-device recognition and voice playback.' },
  { key: 'connected', title: 'CONNECTED AI — Not configured', body: 'Unavailable until the authenticated backend is configured. No requests are sent.' },
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
      // Existing installations retain their current Local AI behavior.
      return isAssistantMode(saved) ? saved : 'local';
    },
    async save(mode: AssistantMode): Promise<void> {
      if (!isAssistantMode(mode)) throw new Error('Invalid Assistant Mode.');
      await store.setSetting(ASSISTANT_MODE_KEY, mode);
    },
  };
}

/** A launch has no dialogue/consent state and cannot change with later settings. */
export function snapshotAssistantLaunch(mode: AssistantMode) {
  return Object.freeze({ mode, destination: mode === 'core' ? 'core-tools' as const
    : mode === 'local' ? 'local' as const : 'unavailable' as const });
}
export type AssistantLaunch = ReturnType<typeof snapshotAssistantLaunch>;

export function routeAssistantLaunch(launch: AssistantLaunch, routes: {
  coreTools(): void;
  local(): void;
}): void {
  if (launch.destination === 'core-tools') routes.coreTools();
  if (launch.destination === 'local') routes.local();
  // There is intentionally no connected provider or network callback in this stage.
}

export const SETTINGS_CATEGORIES = [
  { key: 'profile', title: 'Driver Profile', description: 'Driver details and emergency contact' },
  { key: 'assistant', title: 'Sensi Assistant', description: 'Assistant mode and voice preferences' },
  { key: 'safety', title: 'Health & Safety', description: 'Safety checks, calibration and threshold history' },
  { key: 'data', title: 'Data & Privacy', description: 'Recording, cloud uploads and deletion' },
  { key: 'connections', title: 'Connections', description: 'Pi, Bluetooth and link health' },
] as const;
export type SettingsPage = typeof SETTINGS_CATEGORIES[number]['key'] | 'advanced' | null;
export function settingsTitle(page: SettingsPage): string {
  return page === 'advanced' ? 'Advanced Settings' : SETTINGS_CATEGORIES.find(item => item.key === page)?.title ?? 'Settings';
}

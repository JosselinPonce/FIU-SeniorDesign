export const SETTINGS_CATEGORIES = [
  { key: 'profile', title: 'Driver Profile', description: 'Driver details and emergency contact' },
  { key: 'assistant', title: 'Sensi Assistant', description: 'Assistant mode and voice preferences' },
  { key: 'safety', title: 'Health & Safety', description: 'Safety checks, calibration and threshold history' },
  { key: 'data', title: 'Data & Privacy', description: 'Recording, cloud uploads and deletion' },
  { key: 'connections', title: 'Connections', description: 'Pi, Bluetooth and link health' },
] as const;
export type SensiDetail = 'sensi_voice';
export function isSensiDetail(page: SettingsPage): page is SensiDetail { return page === 'sensi_voice'; }
export type SettingsPage = typeof SETTINGS_CATEGORIES[number]['key'] | SensiDetail | 'calibration' | 'what_to_save' | 'cloud_sync' | 'advanced' | 'safety_testing' | 'developer' | 'hardware_safety_test' | 'thresholds' | 'voicecheck_testing' | null;
export function settingsTitle(page: SettingsPage): string {
  if (isSensiDetail(page)) return 'Voice & Language';
  if (page === 'calibration') return 'Calibrate with a Reference Device';
  if (page === 'hardware_safety_test') return 'Real Hardware Safety Test';
  if (page === 'what_to_save') return 'What to Save';
  if (page === 'cloud_sync') return 'Cloud Synchronization';
  return page === 'voicecheck_testing' ? 'VoiceCheck Testing' : page === 'developer' ? 'Developer Tools' : page === 'thresholds' ? 'Threshold details' : page === 'safety_testing' ? 'Safety Testing' : page === 'advanced' ? 'Advanced Settings' : SETTINGS_CATEGORIES.find(item => item.key === page)?.title ?? 'Settings';
}

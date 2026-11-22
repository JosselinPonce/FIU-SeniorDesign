export const SETTINGS_CATEGORIES = [
  { key: 'profile', title: 'Driver Profile', description: 'Driver details and emergency contact' },
  { key: 'assistant', title: 'Sensi Assistant', description: 'Assistant mode and voice preferences' },
  { key: 'safety', title: 'Health & Safety', description: 'Safety checks, calibration and threshold history' },
  { key: 'data', title: 'Data & Privacy', description: 'Recording, cloud uploads and deletion' },
  { key: 'connections', title: 'Connections', description: 'Pi, Bluetooth and link health' },
] as const;
export const SENSI_PAGES = {
  sensi_account: 'Manage Account',
  sensi_mode: 'AI Response Mode',
  sensi_cloud: 'Cloud Processing',
  sensi_gemma: 'On-Device Gemma',
  sensi_voice: 'Voice & Language',
} as const;
export type SensiDetail = keyof typeof SENSI_PAGES;
export function isSensiDetail(page: SettingsPage): page is SensiDetail {
  return page !== null && Object.prototype.hasOwnProperty.call(SENSI_PAGES, page);
}
export type SettingsPage = typeof SETTINGS_CATEGORIES[number]['key'] | SensiDetail | 'advanced' | 'safety_testing' | 'developer' | 'thresholds' | 'voicecheck_testing' | null;
export function settingsTitle(page: SettingsPage): string {
  if (isSensiDetail(page)) return SENSI_PAGES[page];
  return page === 'voicecheck_testing' ? 'VoiceCheck Testing' : page === 'developer' ? 'Developer Tools' : page === 'thresholds' ? 'Threshold details' : page === 'safety_testing' ? 'Safety Testing' : page === 'advanced' ? 'Advanced Settings' : SETTINGS_CATEGORIES.find(item => item.key === page)?.title ?? 'Settings';
}

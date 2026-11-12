/** Device-local feature preference only. Never contains a contact or call permit. */
export const REAL_CONTACT_DEMO_SETTING = 'real_contact_demo_enabled_v1';
export async function readRealContactPreference(get: (key: string) => Promise<string | null>): Promise<boolean> {
  return await get(REAL_CONTACT_DEMO_SETTING) === '1';
}
export async function saveRealContactPreference(set: (key: string, value: string) => Promise<void>, enabled: boolean): Promise<void> {
  await set(REAL_CONTACT_DEMO_SETTING, enabled ? '1' : '0');
}

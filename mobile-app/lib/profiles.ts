import { supabase } from './supabase';
import { normalizePhone } from './phone';

export type DriverProfile = {
  id: string;
  display_name: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
};
export type ProfileInput = {
  display_name: string;
  emergency_contact_name: string;
  emergency_contact_phone: string;
};
const COLUMNS = 'id, display_name, emergency_contact_name, emergency_contact_phone';

// TODO: Replace manual prototype selection with authenticated driver identity.
export async function loadProfiles(): Promise<DriverProfile[]> {
  const { data, error } = await supabase.from('driver_profiles')
    .select(COLUMNS).order('id');
  if (error) throw new Error(`Could not load profiles: ${error.message}`);
  return data ?? [];
}

export async function loadProfile(id: string): Promise<DriverProfile> {
  const { data, error } = await supabase.from('driver_profiles')
    .select(COLUMNS).eq('id', id).single();
  if (error) throw new Error(`Could not load selected profile: ${error.message}`);
  return data;
}

export async function saveProfile(id: string | null, input: ProfileInput): Promise<DriverProfile> {
  // Explicit allowlist: never send biographical fields or a caller-supplied id.
  const values = {
    display_name: input.display_name.trim(),
    emergency_contact_name: input.emergency_contact_name.trim(),
    emergency_contact_phone: input.emergency_contact_phone.trim(),
  };
  if (!values.display_name || !values.emergency_contact_name) {
    throw new Error('Enter the driver name and emergency contact name.');
  }
  normalizePhone(values.emergency_contact_phone);
  if (id !== null && !id.trim()) throw new Error('Select a valid profile before saving.');
  const query = id === null
    ? supabase.from('driver_profiles').insert(values)
    : supabase.from('driver_profiles').update(values).eq('id', id);
  const { data, error } = await query.select(COLUMNS).single();
  if (error) throw new Error(`Could not save profile: ${error.message}`);
  return data;
}

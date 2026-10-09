/** Shared registration validation and UUID-scoped persistence; no native dependencies. */
import type { DriverProfile, NewProfileInput } from './repositories';

export function validateProfile(input: NewProfileInput): NewProfileInput {
  const display_name = input.display_name.trim();
  if (!display_name) throw new Error('Please enter a driver name.');
  const numeric = (value: number | null | undefined, label: string, max: number, integer = false) => {
    if (value == null) return null;
    if (!Number.isFinite(value) || value <= 0 || value > max || (integer && !Number.isInteger(value)))
      throw new Error(integer ? `${label} must be a whole number between 1 and ${max}.` : `${label} must be a positive number no greater than ${max}.`);
    return value;
  };
  const raw = input.emergency_phone?.trim() || null;
  const phone = raw?.replace(/[\s().-]/g, '') ?? null;
  if (phone && !/^\+?[0-9]{7,15}$/.test(phone))
    throw new Error('Emergency phone must contain 7–15 digits, with an optional leading +. Do not enter an emergency-services short code or extension.');
  return { ...input, display_name, custom_id: input.custom_id?.trim() || null,
    age: numeric(input.age, 'Age', 129, true), weight_kg: numeric(input.weight_kg, 'Weight (kg)', 999.99),
    height_cm: numeric(input.height_cm, 'Height (cm)', 999.99),
    emergency_name: input.emergency_name?.trim() || null, emergency_phone: phone };
}

/** Exact saved registration values used by both editing entry points. */
export function profileFormValues(p: DriverProfile) {
  const arrays = cloudProfile(p);
  return {
    form: { custom_id: p.custom_id ?? '', display_name: p.display_name,
      age: p.age == null ? '' : String(p.age), weight_kg: p.weight_kg == null ? '' : String(p.weight_kg),
      height_cm: p.height_cm == null ? '' : String(p.height_cm), emergency_name: p.emergency_name ?? '',
      emergency_phone: p.emergency_phone ?? '' },
    gender: p.gender, conditions: arrays.conditions, medications: arrays.medications,
    language: p.language === 'es' ? 'es' as const : 'en' as const,
  };
}

export const profileSyncKey = (id: string) => `profile_sync:${id}`;
export interface ProfileDatabase {
  getFirstAsync<T>(sql: string, params: (string | number | null)[]): Promise<T | null>;
  runAsync(sql: string, params: (string | number | null)[]): Promise<{ changes: number }>;
}

/** Called inside an exclusive SQLite transaction. Never rewrites history or calibration. */
export async function updateProfileRecord(db: ProfileDatabase, id: string, raw: NewProfileInput, revision?: string): Promise<DriverProfile> {
  const input = validateProfile(raw);
  const old = await db.getFirstAsync<DriverProfile>('SELECT * FROM driver_profiles WHERE id = ?', [id]);
  if (!old) throw new Error('This driver no longer exists.');
  if (revision !== undefined && old.updated_at !== revision) throw new Error('The profile changed. Close and reopen the editor to load the latest values.');
  const active = await db.getFirstAsync<{ id: string }>("SELECT id FROM drive_sessions WHERE profile_id = ? AND status = 'active' LIMIT 1", [id]);
  if (active) throw new Error('End and save the active drive before editing this profile.');
  const at = new Date(Math.max(Date.now(), (Date.parse(old.updated_at) || 0) + 1)).toISOString();
  await db.runAsync(`UPDATE driver_profiles SET custom_id = ?, display_name = ?, weight_kg = ?, age = ?, height_cm = ?, gender = ?,
    conditions = ?, medications = ?, language = ?, emergency_name = ?, emergency_phone = ?, updated_at = ? WHERE id = ?`,
    [input.custom_id ?? null, input.display_name, input.weight_kg ?? null, input.age ?? null, input.height_cm ?? null,
      input.gender ?? null, JSON.stringify(input.conditions ?? []), JSON.stringify(input.medications ?? []), input.language ?? 'en',
      input.emergency_name ?? null, input.emergency_phone ?? null, at, id]);
  await db.runAsync('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [profileSyncKey(id), at]);
  return (await db.getFirstAsync<DriverProfile>('SELECT * FROM driver_profiles WHERE id = ?', [id]))!;
}

/** Explicit allowlist shared with live uploads: emergency contacts always stay local. */
export function cloudProfile(p: DriverProfile) {
  const list = (s?: string) => { try { const v: unknown = JSON.parse(s ?? '[]'); return Array.isArray(v) ? v.filter(x => typeof x === 'string') : []; } catch { return []; } };
  return { id: p.id, custom_id: p.custom_id, display_name: p.display_name, age: p.age, weight_kg: p.weight_kg,
    height_cm: p.height_cm, gender: p.gender, created_at: p.created_at, updated_at: p.updated_at,
    conditions: list(p.conditions), medications: list(p.medications), language: p.language ?? 'en',
    cal_hr: p.cal_hr ?? null, cal_spo2: p.cal_spo2 ?? null, cal_at: p.cal_at ?? null };
}

/** Serial retry worker. A save during upload must leave its newer revision queued. */
export async function retryProfiles(deps: {
  pending(): Promise<{ profile: DriverProfile; revision: string }[]>;
  upload(profile: ReturnType<typeof cloudProfile>): Promise<string | null>;
  acknowledge(id: string, revision: string): Promise<void>;
}) {
  let profiles = 0;
  const errors: string[] = [];
  for (const item of await deps.pending()) {
    try {
      const error = await deps.upload(cloudProfile(item.profile));
      if (error) { errors.push(error); break; }
      await deps.acknowledge(item.profile.id, item.revision);
      profiles++;
    } catch (e) { errors.push(e instanceof Error ? e.message : String(e)); break; }
  }
  return { profiles, errors };
}

/** One selected-profile save: invalidate consent before persistence and reject late publication. */
export async function saveSelectedProfile<T>(original: DriverProfile, input: NewProfileInput, deps: {
  isCurrent(): boolean;
  cancel(): Promise<void>;
  save(id: string, input: NewProfileInput, revision: string): Promise<DriverProfile>;
  load(profile: DriverProfile): Promise<T>;
  publish(profile: DriverProfile, context: T): void;
}): Promise<DriverProfile> {
  const current = () => {
    if (!deps.isCurrent()) throw new Error('The selected driver changed or a drive started. Close and reopen the profile editor.');
  };
  current();
  const validated = validateProfile(input);
  await deps.cancel();
  current();
  const saved = await deps.save(original.id, validated, original.updated_at);
  const context = await deps.load(saved);
  current();
  deps.publish(saved, context);
  return saved;
}

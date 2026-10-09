/** Display units only. Canonical measurements stay metric and are never rounded on a unit switch. */
export const CM_PER_INCH = 2.54;
export const KG_PER_POUND = 0.45359237;
export type HeightUnit = 'ft/in' | 'cm';
export type WeightUnit = 'lbs' | 'kg';
export type Measurements = {
  heightUnit: HeightUnit; weightUnit: WeightUnit;
  heightCm: number | null; weightKg: number | null;
  heightText: string; weightText: string; feet: number | null; inches: number | null;
  heightError: string | null; weightError: string | null;
};
export const inchesToCm = (feet: number, inches: number) => (feet * 12 + inches) * CM_PER_INCH;
export const poundsToKg = (pounds: number) => pounds * KG_PER_POUND;
export const kgToPounds = (kg: number) => kg / KG_PER_POUND;
export function cmToFeetInches(cm: number) {
  const total = cm / CM_PER_INCH;
  const feet = Math.floor(total / 12);
  return { feet, inches: total - feet * 12 };
}
export const measurementLabel = (n: number) => String(Number(n.toFixed(4)));

export function measurementsFromMetric(heightCm: number | null = null, weightKg: number | null = null,
  heightUnit: HeightUnit = 'ft/in', weightUnit: WeightUnit = 'lbs'): Measurements {
  const height = heightCm == null ? { feet: null, inches: null } : cmToFeetInches(heightCm);
  return { heightCm, weightKg, heightUnit, weightUnit, ...height,
    heightText: heightCm == null ? '' : String(heightCm),
    weightText: weightKg == null ? '' : measurementLabel(weightUnit === 'lbs' ? kgToPounds(weightKg) : weightKg),
    heightError: null, weightError: null };
}

function decimal(raw: string, label: string) {
  const text = raw.trim();
  if (!text) return null;
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) throw new Error(`${label} must be a positive decimal number.`);
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${label} must be positive.`);
  return n;
}
function constrained(n: number | null, label: string) {
  if (n != null && (!Number.isFinite(n) || n <= 0 || n > 999.99))
    throw new Error(`${label} must convert to a positive metric value no greater than 999.99.`);
  return n;
}
export function enterWeight(s: Measurements, text: string): Measurements {
  if (text === s.weightText && !s.weightError) return s;
  try {
    const value = decimal(text, 'Weight');
    const weightKg = constrained(value == null ? null : s.weightUnit === 'lbs' ? poundsToKg(value) : value, 'Weight (kg)');
    return { ...s, weightText: text, weightKg, weightError: null };
  } catch (e) { return { ...s, weightText: text, weightError: (e as Error).message }; }
}
export function enterHeightCm(s: Measurements, text: string): Measurements {
  if (text === s.heightText && !s.heightError) return s;
  try {
    const heightCm = constrained(decimal(text, 'Height'), 'Height (cm)');
    const height = heightCm == null ? { feet: null, inches: null } : cmToFeetInches(heightCm);
    return { ...s, heightText: text, heightCm, ...height, heightError: null };
  } catch (e) { return { ...s, heightText: text, heightError: (e as Error).message }; }
}
export function selectHeight(s: Measurements, feet: number | null, inches: number | null): Measurements {
  if (feet === s.feet && inches === s.inches && !s.heightError) return s;
  if (feet == null && inches == null) return { ...s, feet, inches, heightCm: null, heightText: '', heightError: null };
  try {
    if (feet == null || inches == null) throw new Error('Select both feet and inches, or clear height.');
    if (!Number.isInteger(feet) || feet < 0 || feet > 32 || !Number.isFinite(inches) || inches < 0 || inches >= 12)
      throw new Error('Select valid feet and inches.');
    const heightCm = constrained(inchesToCm(feet, inches), 'Height (cm)');
    return { ...s, feet, inches, heightCm, heightText: String(heightCm), heightError: null };
  } catch (e) { return { ...s, feet, inches, heightError: (e as Error).message }; }
}
export function switchHeightUnit(s: Measurements, heightUnit: HeightUnit): Measurements {
  if (s.heightError) throw new Error('Correct or clear height before switching units.');
  return { ...s, heightUnit }; // retain even fractional saved inches; never quantize to an integer
}
export function switchWeightUnit(s: Measurements, weightUnit: WeightUnit): Measurements {
  if (s.weightError) throw new Error('Correct or clear weight before switching units.');
  return { ...s, weightUnit, weightText: s.weightKg == null ? '' : measurementLabel(weightUnit === 'lbs' ? kgToPounds(s.weightKg) : s.weightKg) };
}
export function metricMeasurements(s: Measurements) {
  if (s.heightError || s.weightError) throw new Error(s.heightError ?? s.weightError!);
  return { height_cm: constrained(s.heightCm, 'Height (cm)'), weight_kg: constrained(s.weightKg, 'Weight (kg)') };
}

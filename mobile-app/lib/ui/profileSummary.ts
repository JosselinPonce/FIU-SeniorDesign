/** Presentation only: never modifies canonical measurements or safety personalization. */
export function displayBmi(weightKg: number | null, heightCm: number | null): number | null {
  if (weightKg == null || heightCm == null || !Number.isFinite(weightKg) || !Number.isFinite(heightCm)
      || weightKg < 20 || weightKg > 400 || heightCm < 80 || heightCm > 250) return null;
  const value = weightKg / ((heightCm / 100) ** 2);
  return value >= 10 && value <= 80 ? Math.round(value * 10) / 10 : null;
}
export function driverInitials(name: string) {
  return name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]!.toUpperCase()).join('');
}
/** Display only. Never return this value to profile storage or phone handoff. */
export function maskedContactPhone(phone: string | null | undefined): string {
  if (!phone?.trim()) return '—';
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 7 ? `••• ••• ${digits.slice(-4)}` : '••••';
}

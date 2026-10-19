export const DRAG_SLOP = 7;
export function clampPosition(x: number, y: number, width: number, height: number, itemWidth: number, itemHeight: number) {
  return { x: Math.max(0, Math.min(x, Math.max(0, width - itemWidth))), y: Math.max(0, Math.min(y, Math.max(0, height - itemHeight))) };
}
export function preferredFraction(value: string | null): number {
  const n = value === null || value.trim() === '' ? NaN : Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1;
}
/** Normalized coordinates preserve both axes across viewport and tooltip size changes. */
export function preferredPosition(value: string | null, legacyY: string | null = null): { x: number; y: number } {
  try {
    const p = JSON.parse(value ?? 'null');
    if (p && typeof p.x === 'number' && Number.isFinite(p.x) && typeof p.y === 'number' && Number.isFinite(p.y))
      return { x: preferredFraction(String(p.x)), y: preferredFraction(String(p.y)) };
  } catch { /* Invalid preference uses the safe default/previous vertical preference. */ }
  return { x: 1, y: preferredFraction(legacyY) };
}
export function restorePosition(p: { x: number; y: number }, width: number, height: number, itemWidth: number, itemHeight: number) {
  return clampPosition(p.x * Math.max(0, width - itemWidth), p.y * Math.max(0, height - itemHeight), width, height, itemWidth, itemHeight);
}

/** Invalid/missing persisted coordinates must not override the Live Vitals default. */
export function readSavedPosition(value: string | null, legacy: string | null = null): { x: number; y: number } | null {
  try {
    const p = JSON.parse(value ?? 'null');
    if (p && typeof p.x === 'number' && typeof p.y === 'number' && Number.isFinite(p.x) && Number.isFinite(p.y)
      && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1) return { x: p.x, y: p.y };
  } catch { /* Try the previous vertical-only preference. */ }
  const y = legacy === null || legacy.trim() === '' ? NaN : Number(legacy);
  return Number.isFinite(y) && y >= 0 && y <= 1 ? { x: 1, y } : null;
}
export function defaultVitalsPosition(width: number, height: number, anchor: { y: number; height: number } | null) {
  return clampPosition(width - 58 - 16, anchor ? anchor.y + (anchor.height - 58) / 2 : height * 0.25, width, height, 58, 58);
}

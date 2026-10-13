/** DriveSense semantic colors. No component or platform dependencies. */
export type ThemeName = 'light' | 'dark';
export type ThemePreference = ThemeName | 'system';
export type ThemeTokens = Readonly<{
  heartAccent: string; oxygenAccent: string; heartText: string; oxygenText: string; connected: string; metricChartSurface: string; metricChartBand: string; graphite: string; pearl: string; accent: string; background: string; surface: string; surfaceMuted: string; text: string; textSecondary: string;
  textMuted: string; border: string; primary: string; onPrimary: string; disabledSurface: string;
  disabledText: string; chartTrace: string; chartSecondary: string; chartBackground: string;
  chartBand: string; overlay: string; warning: string; warningSurface: string;
  danger: string; dangerSurface: string; dangerButton: string; onDanger: string; shadow: string;
}>;
export const light: ThemeTokens = Object.freeze({
  heartAccent: '#D69B8D', oxygenAccent: '#28A9E0', heartText: '#A74740', oxygenText: '#006B91', connected: '#25734A', metricChartSurface: '#30373A', metricChartBand: '#465257',
  graphite: '#30373A', pearl: '#F6F4F0', accent: '#D69B8D', background: '#F6F4F0', surface: '#FFFFFF', surfaceMuted: '#ECE8E1', text: '#30373A',
  textSecondary: '#505359', textMuted: '#62666D', border: '#DCD7CF', primary: '#30373A',
  onPrimary: '#FFFFFF', disabledSurface: '#DCD7CF', disabledText: '#555960',
  chartTrace: '#30373A', chartSecondary: '#656A6B', chartBackground: '#F0EDE7', chartBand: '#DCD7CF',
  overlay: 'rgba(0,0,0,0.55)', warning: '#785000', warningSurface: '#FFF0CE',
  danger: '#9B2929', dangerSurface: '#FBE5E5', dangerButton: '#9B2929', onDanger: '#FFFFFF', shadow: '#000000',
});
export const dark: ThemeTokens = Object.freeze({
  heartAccent: '#F28F87', oxygenAccent: '#28A9E0', heartText: '#F28F87', oxygenText: '#28A9E0', connected: '#74C69D', metricChartSurface: '#1C252B', metricChartBand: '#35434B',
  graphite: '#30373A', pearl: '#F6F4F0', accent: '#D69B8D', background: '#1C252B', surface: '#29343B', surfaceMuted: '#35424B', text: '#F6F4F0',
  textSecondary: '#DCD7CF', textMuted: '#CBC7C0', border: '#4E5D65', primary: '#DCD7CF',
  onPrimary: '#30373A', disabledSurface: '#454D50', disabledText: '#DCD7CF',
  chartTrace: '#F6F4F0', chartSecondary: '#DCD7CF', chartBackground: '#222D34', chartBand: '#586266',
  overlay: 'rgba(0,0,0,0.72)', warning: '#F2CC83', warningSurface: '#44361E',
  danger: '#FFB4B4', dangerSurface: '#48292C', dangerButton: '#9B2929', onDanger: '#FFFFFF', shadow: '#000000',
});
export const themes = Object.freeze({ light, dark });
export function themePreference(value: unknown): ThemePreference {
  return value === 'dark' || value === 'system' ? value : 'light';
}
export function resolveTheme(preference: ThemePreference, system: string | null | undefined): ThemeName {
  return preference === 'system' ? system === 'dark' ? 'dark' : 'light' : preference;
}
/** Compatibility names for existing presentation styles; the static C export is untouched. */
export function presentationColors(t: ThemeTokens) {
  return { bg: t.background, card: t.surface, ink: t.text, sub: t.textSecondary, faint: t.textMuted,
    line: t.border, brand: t.primary, brandSoft: t.surfaceMuted, heart: t.chartTrace, heartSoft: t.surfaceMuted,
    oxygen: t.chartSecondary, oxygenSoft: t.surfaceMuted, good: t.textSecondary, goodSoft: t.surfaceMuted,
    warn: t.warning, warnSoft: t.warningSurface, bad: t.danger, badSoft: t.dangerSurface };
}

/** RN 0.81 uses null to remove the app override and follow device appearance. */
export function nativeAppearancePreference(preference: ThemePreference): ThemeName | null {
  return preference === 'system' ? null : preference;
}

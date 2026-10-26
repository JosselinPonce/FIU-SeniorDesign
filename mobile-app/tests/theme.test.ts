import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createThemePreferences, THEME_SETTING_KEY } from '../lib/theme/preferences.ts';
import { themes, resolveTheme, themePreference, nativeAppearancePreference } from '../lib/theme/tokens.ts';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT)');
  const store = {
    async getSetting(key: string) { return db.prepare('SELECT value FROM app_settings WHERE key=?').get(key)?.value as string ?? null; },
    async setSetting(key: string, value: string) { db.prepare('INSERT INTO app_settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); },
  };
  return { db, store };
}
test('appearance safely defaults to light; valid preferences persist without changing other settings', async () => {
  const { db, store } = fixture();
  try {
    const state = createThemePreferences(store);
    assert.equal(state.getSnapshot(), 'light'); await state.load(); assert.equal(state.getSnapshot(), 'light');
    await store.setSetting('assistant_mode', 'local');
    for (const preference of ['dark', 'system', 'light'] as const) {
      await state.select(preference);
      const reloaded = createThemePreferences(store); await reloaded.load();
      assert.equal(reloaded.getSnapshot(), preference);
    }
    assert.equal(await store.getSetting('assistant_mode'), 'local');
    await store.setSetting(THEME_SETTING_KEY, 'invalid'); await state.load(); assert.equal(state.getSnapshot(), 'light');
    await assert.rejects(state.select('invalid' as any), /Invalid/);
  } finally { db.close(); }
});
test('runtime switching publishes immediately, before persistence finishes, without replacing the store', async () => {
  let finish!: () => void;
  const state = createThemePreferences({ getSetting: async () => null,
    setSetting: () => new Promise<void>(resolve => { finish = resolve; }) });
  const seen: string[] = [];
  const unsubscribe = state.subscribe(() => seen.push(state.getSnapshot()));
  const saving = state.select('dark');
  assert.equal(state.getSnapshot(), 'dark'); assert.deepEqual(seen, ['dark']);
  await Promise.resolve(); finish(); await saving; unsubscribe();
  assert.equal(resolveTheme(state.getSnapshot(), 'light'), 'dark');
});
test('system changes resolve dynamically; null and unexpected native appearances resolve light', () => {
  assert.equal(resolveTheme('system', 'dark'), 'dark'); assert.equal(resolveTheme('system', 'light'), 'light');
  assert.equal(resolveTheme('system', null), 'light'); assert.equal(resolveTheme('system', 'unknown'), 'light');
  assert.equal(resolveTheme('dark', 'light'), 'dark'); assert.equal(themePreference(undefined), 'light');
});
test('late initial reads cannot override a new selection; write failures remain visible to the caller', async () => {
  let finish!: (value: string) => void;
  const state = createThemePreferences({ getSetting: () => new Promise(resolve => { finish = resolve; }), setSetting: async () => {} });
  const loading = state.load(); await state.select('dark'); finish('light'); await loading;
  assert.equal(state.getSnapshot(), 'dark');
  const failed = createThemePreferences({ getSetting: async () => { throw Error('offline'); }, setSetting: async () => { throw Error('full'); } });
  await failed.load(); assert.equal(failed.getSnapshot(), 'light');
  await assert.rejects(failed.select('dark'), /full/); assert.equal(failed.getSnapshot(), 'dark');
});
test('rapid selections serialize durable writes in selection order', async () => {
  const writes: string[] = [];
  const state = createThemePreferences({ getSetting: async () => null, setSetting: async (_, value) => { writes.push(value); } });
  await Promise.all([state.select('dark'), state.select('system'), state.select('light')]);
  assert.deepEqual(writes, ['dark', 'system', 'light']); assert.equal(state.getSnapshot(), 'light');
});
function luminance(hex: string) {
  const values = hex.slice(1).match(/../g)!.map(v => parseInt(v, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return values[0]! * .2126 + values[1]! * .7152 + values[2]! * .0722;
}
function contrast(a: string, b: string) { const x = luminance(a), y = luminance(b); return (Math.max(x,y)+.05)/(Math.min(x,y)+.05); }
test('both palettes retain readable text, button, disabled and safety-state contrast', () => {
  for (const t of Object.values(themes)) {
    for (const bg of [t.background, t.surface, t.surfaceMuted]) for (const fg of [t.text, t.textSecondary, t.textMuted])
      assert.ok(contrast(fg, bg) >= 4.5, `${fg} on ${bg}`);
    for (const [fg,bg] of [[t.onPrimary,t.primary],[t.disabledText,t.disabledSurface],[t.warning,t.warningSurface],[t.danger,t.dangerSurface],[t.onDanger,t.dangerButton]])
      assert.ok(contrast(fg!,bg!) >= 4.5, `${fg} on ${bg}`);
    assert.ok(Object.isFrozen(t));
  }
});

test('metric accents are exact and readable on their graphite chart surfaces', () => {
  for (const t of Object.values(themes)) {
    assert.equal(t.heartAccent, t === themes.light ? '#D69B8D' : '#F28F87'); assert.equal(t.oxygenAccent, '#28A9E0');
    assert.ok(contrast(t.heartAccent, t.metricChartSurface) >= 3);
    assert.ok(contrast(t.oxygenAccent, t.metricChartSurface) >= 3);
    assert.ok(contrast(t.heartAccent, t.metricChartBand) >= 3);
    assert.ok(contrast(t.oxygenAccent, t.metricChartBand) >= 3);
    assert.ok(contrast(t.heartText, t.surface) >= 4.5);
    assert.ok(contrast(t.oxygenText, t.surface) >= 4.5);
    assert.ok(contrast(t.connected, t.surface) >= 3);
  }
});

test('Warm Pearl palette and iOS native appearance support persisted explicit and system choices', () => {
  assert.equal(themes.light.background, '#F6F4F0');
  assert.equal(themes.light.border, '#DCD7CF');
  assert.equal(themes.light.primary, '#30373A');
  assert.equal(themes.light.accent, '#D69B8D');
  assert.equal(themes.light.oxygenAccent, '#28A9E0');
  assert.equal(nativeAppearancePreference('light'), 'light');
  assert.equal(nativeAppearancePreference('dark'), 'dark');
  assert.equal(nativeAppearancePreference('system'), null);
  const read = (path: string) => readFileSync(new NodeURL(`../${path}`, import.meta.url), 'utf8');
  // Expo prebuild generates the ignored ios/ tree after unit tests in CI.
  // Validate its tracked source, including any platform/plist overrides.
  const config = JSON.parse(read('app.json')).expo;
  assert.equal(config.userInterfaceStyle, 'automatic');
  assert.equal(config.ios?.userInterfaceStyle ?? config.userInterfaceStyle, 'automatic');
  assert.equal(config.ios?.infoPlist?.UIUserInterfaceStyle ?? 'Automatic', 'Automatic');
  assert.match(read('lib/theme/ThemeProvider.tsx'), /Appearance.setColorScheme\(nativeAppearancePreference\(preference\)\)/);
});

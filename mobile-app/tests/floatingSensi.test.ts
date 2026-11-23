import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { resolveTheme, themes } from '../lib/theme/tokens.ts';
import * as floating from '../lib/ui/floatingSensi.ts';
import { defaultLauncherPosition, greetingPosition } from '../lib/ui/launcherGreeting.ts';
import { clampPosition, DRAG_SLOP, preferredFraction, preferredPosition, restorePosition, readSavedPosition, defaultVitalsPosition, readLauncherPreference, dockLauncher } from '../lib/ui/floatingSensi.ts';
const source = (p: string) => readFileSync(new NodeURL('../'+p, import.meta.url), 'utf8');
test('free diagonal positions remain interior; viewport clamping never imposes docking', () => {
  assert.deepEqual(clampPosition(120,150,390,650,78,180),{x:120,y:150});
  assert.deepEqual(clampPosition(-100,-100,390,650,78,180),{x:0,y:0});
  assert.deepEqual(clampPosition(1000,1000,390,650,78,180),{x:312,y:470});
  assert.deepEqual(clampPosition(100,100,20,20,78,180),{x:0,y:0});
});
test('both normalized axes restore on resize, clamp corrupt data, and retain legacy vertical preference', () => {
  assert.deepEqual(preferredPosition('{"x":0.3,"y":0.4}'),{x:0.3,y:0.4});
  assert.deepEqual(preferredPosition('{"x":5,"y":-3}'),{x:1,y:0});
  assert.deepEqual(preferredPosition('invalid','0.4'),{x:1,y:0.4});
  assert.deepEqual(preferredPosition('{"x":"0.3","y":0.4}'),{x:1,y:1});
  assert.equal(preferredFraction(null),1);
  assert.deepEqual(restorePosition({x:0.5,y:0.5},390,600,78,100),{x:156,y:250});
  assert.deepEqual(restorePosition({x:0.5,y:0.5},650,300,78,100),{x:286,y:100});
});
test('gesture claims movement beyond tap slop; floating wrapper passes ordinary taps to the original launcher', () => {
  assert.ok(DRAG_SLOP >= 5);
  const wrapper=source('components/DraggableSensiLauncher.tsx');
  assert.match(wrapper,/onMoveShouldSetPanResponderCapture:[\s\S]*Math.hypot\(gesture.dx, gesture.dy\) > DRAG_SLOP/);
  assert.doesNotMatch(wrapper,/onStartShouldSetPanResponder:/);
  assert.match(wrapper,/pointerEvents="box-none"/);
  assert.match(wrapper,/position: 'absolute'/);
  assert.match(wrapper,/repo.setSetting\(preferenceKey/);
  const shell=source('components/SmartWheelScreen.tsx');
  assert.equal((shell.match(/<DashboardAssistantEntry /g)??[]).length,1);
  assert.match(shell,/error="" onPress=\{\(\) => \{ showGreeting\(\); openAssistant\(\);/);
  assert.match(shell,/!assistantOpen \? <DraggableSensiLauncher/);
});
test('diagnostics enter from Advanced or Sensi in Debug; Advanced uses a grouped row', () => {
  const settings=source('components/SettingsView.tsx');
  const advanced=settings.slice(settings.indexOf("{page === 'developer' && __DEV__"));
  assert.match(advanced, /<ResponsivenessDiagnostics/);
  assert.doesNotMatch(advanced, /gemmaDiagnostics/);
  assert.match(settings, /<SettingsRow divider title="Advanced Settings"/);
  const shell=source('components/SmartWheelScreen.tsx');
  const picker=shell.slice(shell.indexOf('if (!drive.driver)'),shell.indexOf('if (editOpening)'));
  assert.doesNotMatch(picker,/Local AI diagnostics/);
  assert.match(settings,/blocked=\{d.hasActiveSession \|\| !!sf.check/);
  assert.doesNotMatch(shell,/Gemma diagnostics/);
});

test('Live Vitals default is section-relative and used only without a valid saved preference', () => {
  assert.equal(readSavedPosition(null),null);
  assert.equal(readSavedPosition('invalid'),null);
  assert.equal(readSavedPosition('{"x":2,"y":0.5}'),null);
  assert.deepEqual(readSavedPosition('{"x":0.2,"y":0.7}'),{x:0.2,y:0.7});
  assert.deepEqual(readSavedPosition(null,'0.4'),{x:1,y:0.4});
  assert.deepEqual(defaultVitalsPosition(390,600,{y:180,height:58}),{x:316,y:180});
  assert.deepEqual(defaultVitalsPosition(600,300,{y:100,height:58}),{x:526,y:100});
  const text=source('components/DraggableSensiLauncher.tsx');
  assert.match(text,/fraction.current \? restorePosition/);
  assert.match(text,/!fraction.current && !dragging.current/);
  assert.match(text,/top: 0, bottom: 0/);
  assert.match(source('components/DriveView.tsx'),/onVitalsAnchor/);
});

test('both Live Vitals headings reserve room for the launcher and report their measured row', () => {
  const drive = source('components/DriveView.tsx');
  assert.match(drive, /layout.y - scrollOffset.current/);
  assert.match(drive, /st.between, st.vitalsHeading\]\} onLayout=\{measureHeading\}/);
  assert.match(drive, /style=\{st.vitalsHeading\} onLayout=\{measureHeading\}/);
  assert.match(drive, /vitalsHeading: \{ minHeight: 58, paddingRight: 102/);
  assert.deepEqual(defaultLauncherPosition(390, 600, 102, 58, { y: 180, height: 24 }), { x: 288, y: 163 });
});

test('edge docking and collapsed state survive legacy migration and orientation changes', () => {
  const docked = dockLauncher(110, 330, 390, 650, 58, true);
  assert.equal(docked.x, 0);
  assert.deepEqual(readLauncherPreference(JSON.stringify(docked)), docked);
  assert.equal(restorePosition(docked, 650, 300, 58, 58).x, 0);
  assert.equal(restorePosition(docked, 650, 300, 58, 58).y, (330 / 592) * 242);
  assert.deepEqual(dockLauncher(900, -20, 390, 650, 58, false), { x: 1, y: 0, collapsed: false });
  assert.deepEqual(readLauncherPreference('{"x":0.89,"y":0.25}'), { x: 1, y: 0.25, collapsed: false });
  assert.deepEqual(readLauncherPreference(null, '0.35'), { x: 1, y: 0.35, collapsed: false });
  const launcher = source('components/DraggableSensiLauncher.tsx');
  assert.match(launcher, /accessibilityLabel="Expand Sensi"/);
  assert.match(launcher, /if \(preference\?\.collapsed\) save\(\{ \.\.\.preference, collapsed: false \}\);\s+showGreeting\(\)/);
  const shell = source('components/SmartWheelScreen.tsx');
  assert.match(shell, /<SensiSafetyConversation/);
  assert.match(shell, /<VoiceCheckModal/);
});

test('launcher docks, persists manual preferences per driver, and collapses temporarily on each dashboard drag', async () => {
  const code = ts.transpileModule(source('components/DraggableSensiLauncher.tsx'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const preferences = new Map<string, string>();
  let tokens = themes.light;
  let writes = 0;
  let cells: any[] = [], index = 0, gesture: any;
  const unmount = () => { cells.forEach(cell => cell?.cleanup?.()); cells = []; };
  class Point {
    value = { x: 0, y: 0 };
    listener?: (value: { x: number; y: number }) => void;
    setValue(value: typeof this.value) { this.value = value; this.listener?.(value); }
    addListener(listener: Point['listener']) { this.listener = listener; return 'listener'; }
    removeListener() { this.listener = undefined; }
    stopAnimation(cb?: (v: typeof this.value) => void) { cb?.(this.value); }
    getTranslateTransform() { return this.value; }
  }
  const deps: Record<string, unknown> = {
    react: {
      useRef: (current: unknown) => { const i = index++; return cells[i] ??= { current }; },
      useState: (initial: unknown) => {
        const i = index++;
        cells[i] ??= { value: initial };
        return [cells[i].value, (next: unknown) => { cells[i].value = typeof next === 'function' ? next(cells[i].value) : next; }];
      },
      useEffect: (fn: () => (() => void) | undefined, deps: unknown[]) => {
        const i = index++;
        if (!cells[i] || deps.some((dep, j) => !Object.is(dep, cells[i].deps[j]))) {
          cells[i]?.cleanup?.();
          cells[i] = { deps, cleanup: fn() };
        }
      },
      useMemo: (fn: () => unknown) => { const i = index++; return cells[i] ??= fn(); },
    },
    'react/jsx-runtime': createRequire(import.meta.url)('react/jsx-runtime'),
    'react-native': { View: 'View', PanResponder: { create: (handlers: unknown) => { gesture = handlers; return { panHandlers: {} }; } },
      Animated: { View: 'Animated', ValueXY: Point, spring: (point: Point, { toValue }: { toValue: Point['value'] }) => ({ start: () => point.setValue(toValue) }) } },
    '../lib/i18n/native': { LocalizedPressable: 'Pressable', LocalizedText: 'Text' },
    '../lib/theme/ThemeProvider': { useTheme: () => ({ tokens }) },
    '../lib/ui/launcherGreeting': { defaultLauncherPosition, greetingPosition },
    '../lib/ui/floatingSensi': floating,
    '../lib/db/repositories': { getSetting: async (key: string) => preferences.get(key) ?? null,
      setSetting: async (key: string, value: string) => { writes++; preferences.set(key, value); } },
  };
  const exports: any = {};
  new Function('require', 'exports', code)((id: string) => deps[id], exports);
  let collapse: () => void = () => { throw Error('Launcher missing'); };
  let driverId = 'one';
  let scrollStart = 0;
  let defaultAnchor = { y: 210, height: 58 };
  let reopen = () => {};
  const render = () => {
    index = 0;
    return exports.DraggableSensiLauncher({ driverId, scrollStart, defaultAnchor, children: (action: () => void, show: () => void) => {
      collapse = action; reopen = show; return 'launcher';
    } });
  };
  const layout = (width: number, height: number) => render().props.onLayout({ nativeEvent: { layout: { width, height } } });
  const animated = () => render().props.children[0];
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  layout(390, 650); await flush();
  assert.equal(gesture.onMoveShouldSetPanResponderCapture(null, { dx: 2, dy: 1 }), false);
  const bubble = () => render().props.children[1];
  assert.deepEqual(animated().props.style.transform, { x: 288, y: 210 });
  defaultAnchor = { y: 240, height: 70 };
  render();
  assert.deepEqual(animated().props.style.transform, { x: 288, y: 246 });
  const before = bubble().props.style.transform;
  for (const appearance of ['light', 'dark'] as const) {
    tokens = themes[resolveTheme('system', appearance)];
    const [body, close] = bubble().props.children;
    assert.equal(body.props.style.backgroundColor, tokens.surface);
    assert.equal(body.props.style.borderColor, tokens.border);
    assert.equal(body.props.children.props.style.color, tokens.text);
    assert.equal(body.props.pointerEvents, 'none');
    assert.equal(close.props.style.width, 44);
    assert.equal(close.props.style.height, 44);
    assert.equal(close.props.style.right, 10);
    assert.deepEqual(bubble().props.style.transform, before);
  }
  gesture.onPanResponderGrant();
  gesture.onPanResponderMove(null, { dx: -220, dy: 110 });
  assert.ok(animated().props.style.transform.x > 0);
  assert.ok(bubble(), 'dragging keeps the greeting visible');
  assert.notDeepEqual(bubble().props.style.transform, before);
  const dismiss = bubble().props.children[1].props.onPress;
  dismiss();
  assert.equal(bubble(), null);
  assert.ok(animated());
  reopen();
  assert.ok(bubble());
  gesture.onPanResponderRelease();
  await flush();
  assert.equal(animated().props.style.transform.x, 0);
  assert.ok(bubble().props.style.transform.x > 0, 'left dock places the greeting to the right');
  defaultAnchor = { y: 175, height: 58 };
  const dock = animated().props.style.transform;
  const dragWrites = writes;
  scrollStart++;
  render();
  assert.equal(bubble(), null);
  assert.equal(animated().props.children.props.accessibilityLabel, 'Expand Sensi');
  assert.deepEqual(animated().props.style.transform, dock);
  assert.equal(gesture.onMoveShouldSetPanResponderCapture(null, { dx: 30, dy: 0 }), false);
  await flush();
  assert.equal(animated().props.children.props.accessibilityLabel, 'Expand Sensi');
  assert.equal(writes, dragWrites);
  animated().props.children.props.onPress();
  assert.ok(bubble());
  assert.deepEqual(animated().props.style.transform, dock);
  await flush();
  assert.equal(writes, dragWrites);

  scrollStart++;
  render();
  assert.equal(bubble(), null);
  unmount();
  layout(390, 650); await flush();
  assert.ok(bubble(), 'remount restores the saved expanded preference');
  assert.deepEqual(animated().props.style.transform, dock);
  assert.equal(writes, dragWrites);
  collapse(); await flush();
  assert.equal(bubble(), null);
  assert.equal(animated().props.children.props.accessibilityLabel, 'Expand Sensi');
  unmount();
  layout(650, 300); await flush();
  assert.equal(animated().props.children.props.accessibilityLabel, 'Expand Sensi');
  assert.deepEqual(animated().props.style.transform, { x: 0, y: dock.y / (650 - 58) * (300 - 58) });
  animated().props.children.props.onPress(); await flush();
  assert.ok(JSON.stringify(animated().props.children).includes('launcher'));
  assert.ok(bubble());
  assert.equal(JSON.parse(preferences.get('sensi:launcher-position:one')!).collapsed, false);
  unmount();
  driverId = 'two';
  layout(390, 650); await flush();
  assert.deepEqual(animated().props.style.transform, { x: 288, y: 175 });
  assert.ok(!preferences.has('sensi:launcher-position:two'));
  unmount();
});

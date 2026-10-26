import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { clampPosition, DRAG_SLOP, preferredFraction, preferredPosition, restorePosition, readSavedPosition, defaultVitalsPosition } from '../lib/ui/floatingSensi.ts';
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
  assert.match(wrapper,/repo.setSetting\('sensi:launcher-position'/);
  const shell=source('components/SmartWheelScreen.tsx');
  assert.equal((shell.match(/<DashboardAssistantEntry /g)??[]).length,1);
  assert.match(shell,/error="" onPress=\{openAssistant\}/);
  assert.match(shell,/!assistantOpen \? <DraggableSensiLauncher/);
});
test('diagnostics only enter from Advanced; category card matches the other navigation cards', () => {
  const settings=source('components/SettingsView.tsx');
  const advanced=settings.slice(settings.indexOf("{page === 'advanced'"));
  assert.match(advanced,/__DEV__ \? props.gemmaDiagnostics/);
  assert.match(settings,/accessibilityLabel="Advanced Settings" onPress=\{\(\) => setPage\('advanced'\)\} style=\{st.category\}/);
  const shell=source('components/SmartWheelScreen.tsx');
  const picker=shell.slice(shell.indexOf('if (!drive.driver)'),shell.indexOf('if (editOpening)'));
  assert.doesNotMatch(picker,/Local AI diagnostics/);
  assert.match(shell,/disabled=\{drive.hasActiveSession \|\| !!drive.safety.check/);
  assert.match(shell,/title="Gemma diagnostics"/);
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
  assert.match(source('components/DriveView.tsx'),/onVitalsAnchor/);
});

test('Live Vitals uses natural text height without reserving dashboard space for the overlay', () => {
  const drive = source('components/DriveView.tsx');
  const heading = drive.slice(drive.indexOf('<Text accessibilityRole="header"'), drive.indexOf('>Live Vitals</Text>') + '>Live Vitals</Text>'.length);
  assert.match(heading, /onLayout=/);
  assert.doesNotMatch(heading, /minHeight|padding|margin/);
  assert.doesNotMatch(drive, /minHeight: 58/);
  const wrapper = source('components/DraggableSensiLauncher.tsx');
  assert.match(wrapper, /pointerEvents="box-none" style=\{\{ position: 'absolute'/);
  assert.match(wrapper, /<View pointerEvents="none"/);
  assert.deepEqual(defaultVitalsPosition(390,600,{y:180,height:24}),{x:316,y:163});
  assert.match(drive, /\[details, setDetails\] = useState\(true\)/);
});

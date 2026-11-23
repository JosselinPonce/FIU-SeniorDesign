import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { translateText } from '../lib/i18n/translate.ts';
import { greetingPosition } from '../lib/ui/launcherGreeting.ts';
test('the compact bubble overlaps the upper corner and mirrors on the opposite edge', () => {
  const left = greetingPosition({ x: 0, y: 100 }, 390, 600, 76, 44);
  const right = greetingPosition({ x: 332, y: 100 }, 390, 600, 76, 44);
  assert.deepEqual(left, { x: 48, y: 66 });
  assert.deepEqual(right, { x: 266, y: 66 });
  for (const [width, height] of [[320, 500], [393, 630], [430, 730], [600, 190]]) {
    for (const bubbleHeight of [44, 94, 132]) {
      for (const icon of [{ x: 0, y: 0 }, { x: width - 58, y: height - 58 }]) {
        const bubble = greetingPosition(icon, width, height, 152, bubbleHeight);
        assert.ok(bubble.x >= 6 && bubble.x + 152 <= width - 6);
        assert.ok(bubble.y >= 6 && bubble.y + bubbleHeight <= height - 6);
      }
    }
  }
});
test('greeting follows launcher motion, is dismissible, and has no timer', () => {
  const text = readFileSync(new NodeURL('../components/DraggableSensiLauncher.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(text, /setTimeout|clearTimeout|onTouchStart/);
  assert.match(text, /translation.addListener\(update\)/);
  assert.match(text, /accessibilityLabel="Dismiss Sensi greeting" onPress=\{dismissGreeting\}/);
  assert.ok(text.includes("Hi! I'm\\nSensi!"));
  assert.equal(translateText("Hi! I'm\nSensi!", 'es'), "¡Hola! ¡Soy\nSensi!");
  assert.match(text, /borderColor: tokens.border/);
  assert.match(text, /backgroundColor: tokens.surface/);
  assert.match(text, /color: tokens.text, fontSize: 13/);
  assert.match(text, /right: 10, width: 44, height: 44/);
  assert.match(text, /pointerEvents="none" style=\{\{ marginTop: 4, paddingLeft: 6, paddingRight: 22, paddingVertical: 3/);
  assert.doesNotMatch(text, /tailTranslation|rotate:/);
  assert.doesNotMatch(text, /allowFontScaling=|numberOfLines=/);
  assert.match(text, /greetingVisible && !collapsed/);
  assert.match(text, /children\(collapse, showGreeting\)/);
});
test('Monitoring Details follows the active drive ID and keeps its manual state above Home navigation', () => {
  const screen = readFileSync(new NodeURL('../components/SmartWheelScreen.tsx', import.meta.url), 'utf8');
  const view = readFileSync(new NodeURL('../components/DriveView.tsx', import.meta.url), 'utf8');
  assert.match(screen, /const activeDriveId = drive.hasActiveSession \? drive.session\?\.id : undefined/);
  assert.match(screen, /useState\(\(\) => activeDriveId !== undefined\)/);
  assert.match(screen, /useEffect\(\(\) => \{ setMonitoringDetailsExpanded\(activeDriveId !== undefined\); \}, \[activeDriveId\]\)/);
  assert.match(screen, /<DriveView[^>]+monitoringDetailsExpanded=\{monitoringDetailsExpanded\}/);
  assert.match(screen, /onToggleMonitoringDetails=\{\(\) => setMonitoringDetailsExpanded\(value => !value\)\}/);
  assert.match(view, /const details = props.monitoringDetailsExpanded/);
  assert.match(view, /accessibilityState=\{\{ expanded: details \}\} onPress=\{props.onToggleMonitoringDetails\}/);
});

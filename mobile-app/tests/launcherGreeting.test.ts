import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { greetingPosition } from '../lib/ui/launcherGreeting.ts';
test('single-line pill flips beside launcher and stays inside viewport edges after resize', () => {
  assert.equal(greetingPosition({x:20,y:100},390,600,130,32).x,86);
  assert.equal(greetingPosition({x:330,y:100},390,600,130,32).x,192);
  for(const [width,height] of [[390,600],[600,240],[180,200]]) {
    for(const icon of [{x:0,y:0},{x:width-58,y:height-58}]) {
      const p=greetingPosition(icon,width,height,130,32);
      assert.ok(p.x>=0 && p.x+130<=width); assert.ok(p.y>=0 && p.y+32<=height);
    }
  }
});
test('pill stays visible without timers or dismissal and never receives touches', () => {
  const text=readFileSync(new NodeURL('../components/DraggableSensiLauncher.tsx',import.meta.url),'utf8');
  assert.doesNotMatch(text,/setTimeout|clearTimeout|claim\(|hideGreeting|greetingVisible|onTouchStart/);
  assert.match(text,/measured && loaded \? <View pointerEvents="none"/);
  assert.match(text,/<Text numberOfLines=\{1\}[^>]*>Hi, I'm Sensi!/);
  const p = greetingPosition({x:60,y:100},180,300,130,32);
  assert.ok(p.y + 32 < 100, 'uses space above when neither side fits');
});
test('monitoring details initialize expanded, reset for driver changes only, and keep manual toggle', () => {
  const text=readFileSync(new NodeURL('../components/DriveView.tsx',import.meta.url),'utf8');
  assert.match(text,/\[details, setDetails\] = useState\(true\)/);
  assert.match(text,/useEffect\(\(\) => \{ setDetails\(true\); \}, \[d.driver\?\.id\]\)/);
  assert.match(text,/onPress=\{\(\) => setDetails\(value => !value\)\}/);
});

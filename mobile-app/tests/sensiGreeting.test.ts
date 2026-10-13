import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { createSensiGreeting } from '../lib/ui/sensiGreeting.ts';
test('greeting dismissal lasts through entry unmount/remount but resets in a new app session', () => {
  const session = createSensiGreeting(); let notices = 0;
  const unmount = session.subscribe(() => notices++);
  assert.equal(session.getSnapshot(), true); session.dismiss(); assert.equal(notices, 1);
  unmount(); const remount = session.subscribe(() => notices++);
  assert.equal(session.getSnapshot(), false); session.dismiss(); assert.equal(notices, 1);
  remount(); assert.equal(createSensiGreeting().getSnapshot(), true);
});
test('greeting is accessible, nonmodal and shares existing safety-hidden dashboard entry', () => {
  const read = (path: string) => readFileSync(new NodeURL(`../${path}`, import.meta.url), 'utf8');
  const entry = read('components/DashboardAssistantEntry.tsx');
  assert.match(entry, /Hi, I'm Sensi!/);
  const greeting = entry.slice(entry.indexOf('{greetingVisible ?'), entry.indexOf('Sensi ·'));
  assert.doesNotMatch(greeting, /position: 'absolute'/);
  assert.match(entry, /accessibilityLabel="Dismiss Sensi greeting" onPress=\{sensiGreeting.dismiss\}/);
  assert.match(entry, /minWidth: 44, minHeight: 44/);
  assert.match(entry, /useSyncExternalStore\(sensiGreeting.subscribe/);
  assert.match(entry, /disabled=\{disabled\} onPress=\{props.onPress\}/);
  assert.doesNotMatch(entry, /<Modal|speakLocal\(|setTimeout\(/);
  assert.match(read('components/SmartWheelScreen.tsx'), /!drive.safety.check && !drive.safety.demo && !assistantOpen \? <DashboardAssistantEntry/);
});

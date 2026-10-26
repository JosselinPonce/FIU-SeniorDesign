import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openAuthorizedPhoneInterface, type PhoneHandoffOrigin } from '../lib/voice/phoneHandoff.ts';
import { light, dark } from '../lib/theme/tokens.ts';
function luminance(hex: string) {
  const channels = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}
function contrast(a: string, b: string) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); }
for (const t of [light, dark]) test(`${t === light ? 'Light' : 'Dark'} switch tracks/thumbs have at least 3:1 contrast`, () => {
  const green = [1, 3, 5].map(i => parseInt(t.switchOn.slice(i, i + 2), 16));
  assert.ok(green[1]! > green[0]! && green[1]! > green[2]!);
  for (const track of [t.switchOn, t.switchOff]) {
    assert.ok(contrast(track, t.switchThumb) >= 3, `${track} against thumb`);
    assert.ok(contrast(track, t.surface) >= 3, `${track} against Settings card`);
  }
});
test('platform boundary refuses simulated, missing, standalone, promoted and expired provenance without invoking dialer', async () => {
  const calls: string[] = [];
  const origins: (PhoneHandoffOrigin | undefined)[] = [undefined,
    { source: 'rehearsal', episodeId: 'rehearsal' }, { source: 'demo', episodeId: 'demo-123' },
    { source: 'rehearsal', episodeId: 'a-real-looking-id' }, { source: 'demo', episodeId: 'a-real-looking-id' },
    { source: 'live', episodeId: 'rehearsal' }, { source: 'live', episodeId: 'demo-123' },
    { source: 'live' }, { source: 'standalone' }];
  for (const origin of origins) await assert.rejects(openAuthorizedPhoneInterface('+13055550123', origin, () => true, async url => { calls.push(url); }), /blocked/);
  await assert.rejects(openAuthorizedPhoneInterface('+13055550123', { source: 'live', episodeId: 'episode-1' }, () => false, async url => { calls.push(url); }), /blocked/);
  assert.deepEqual(calls, []);
});
test('platform boundary preserves current live-event phone interface behavior', async () => {
  const calls: string[] = [];
  await openAuthorizedPhoneInterface('+13055550123', { source: 'live', episodeId: 'episode-1' }, () => true, async url => { calls.push(url); });
  assert.deepEqual(calls, ['tel:+13055550123']);
});

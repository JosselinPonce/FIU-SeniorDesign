import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
const native = readFileSync(new NodeURL('../modules/local-foundation-models/ios/OfflineSpeechDiagnostic.swift', import.meta.url), 'utf8');
const shadow = native.split('// BEGIN ENGLISH SHADOW ENERGY:')[1]?.split('\n').slice(1).join('\n').split('// END ENGLISH SHADOW ENERGY')[0];

test('actual shadow aggregates distinguish silence, DC, sampling bias, channels and early/later input without retaining PCM', { skip: process.platform !== 'darwin' }, () => {
  assert.ok(shadow);
  const folder = mkdtempSync(join(tmpdir(), 'drivesense-shadow-energy-'));
  const file = join(folder, 'Shadow.swift');
  writeFileSync(file, `import Foundation
${shadow}
func runShadowRegression() throws {
func feed(_ s: inout EnglishShadowAudio, _ data: [[Double]], rate: Double = 16384) {
  var sum = 0.0, count = 0
  for channel in data { for frame in stride(from: 0, to: channel.count, by: 4) { sum += channel[frame] * channel[frame]; count += 1 } }
  s.observe(frames: data[0].count, channelCount: data.count, sampleRate: rate,
    existingSampledPower: sum / Double(count)) { data[$0][$1] }
}
func close(_ a: Double, _ b: Double, _ tolerance: Double = 0.000001) { assert(abs(a-b) < tolerance, "\\(a) != \\(b)") }
let zero = Array(repeating: 0.0, count: 1024)
var silence = EnglishShadowAudio()
for _ in 0..<96 { feed(&silence, [zero]) }
close(silence.all.sampled.above, 0); close(silence.all.full.duration, 6)
close(silence.all.full.report["powerDb"] as! Double, -120)
assert(silence.report["bufferCount"] as? Int == 96)
var dc = EnglishShadowAudio(); feed(&dc, [Array(repeating: 0.01, count: 1024)])
close(dc.all.full.report["powerDb"] as! Double, -40)
close(dc.all.sampled.above / dc.all.sampled.duration, 1)
close(dc.all.centered.above, 0); close(dc.all.report["meanAbsDC"] as! Double, 0.01)
let tone = (0..<1024).map { 0.01 * sin(Double($0) * Double.pi / 2 + Double.pi / 2) }
var aliased = EnglishShadowAudio(); feed(&aliased, [tone])
close(aliased.all.sampled.report["powerDb"] as! Double, -40)
close(aliased.all.full.report["powerDb"] as! Double, -43.0102999566)
close(aliased.all.centered.report["powerDb"] as! Double, -43.0102999566)
let missed = (0..<1024).map { 0.01 * sin(Double($0) * Double.pi / 2) }
var blind = EnglishShadowAudio(); feed(&blind, [missed])
assert(blind.all.sampled.above == 0 && blind.all.full.above > 0)
var stereo = EnglishShadowAudio(); feed(&stereo, [Array(repeating: 0.02, count: 1024), zero])
close(stereo.all.full.report["powerDb"] as! Double, -36.9897000434)
assert(stereo.channels[0].full.above > 0 && stereo.channels[1].full.above == 0)
close(stereo.all.centered.above, 0)
let alternating = (0..<1024).map { $0 % 2 == 0 ? 0.02 : -0.02 }
var opposite = EnglishShadowAudio(); feed(&opposite, [alternating, alternating.map { -$0 }])
assert(opposite.all.full.above > 0 && opposite.all.centered.above > 0) // no channel cancellation
var windows = EnglishShadowAudio()
for _ in 0..<32 { feed(&windows, [alternating]) }
for _ in 0..<64 { feed(&windows, [zero]) }
close(windows.early.full.duration, 2); close(windows.later.full.duration, 4)
close(windows.early.full.above / windows.early.full.duration, 1)
close(windows.later.full.above, 0); close(windows.all.full.above / windows.all.full.duration, 1.0/3)
close(windows.all.full.bins.reduce(0,+), 6000)
var capped = EnglishShadowAudio(); feed(&capped, Array(repeating: zero, count: 6))
assert((capped.report["channels"] as! [[String: Any]]).count == 4)
assert(capped.report["omittedChannelSummaries"] as? Int == 2)
feed(&capped, [zero], rate: 48000)
assert(capped.minRate == 16384 && capped.maxRate == 48000 && capped.minChannels == 1 && capped.maxChannelsSeen == 6)
feed(&capped, [Array(repeating: Double.nan, count: 1024)])
assert(capped.invalidBuffers == 1)
feed(&capped, Array(repeating: zero, count: 33)); assert(capped.unsupportedBuffers == 1)
for _ in 0..<10000 { feed(&capped, [Array(repeating: 0.0, count: 16)]) }
assert(capped.channels.count == 4 && capped.all.full.bins.count == 17)
let encoded = try JSONSerialization.data(withJSONObject: capped.report)
assert(encoded.count < 25000)
let json = String(data: encoded, encoding: .utf8)!
assert(!json.contains("transcript") && !json.contains("\\\"samples\\\"") && !json.contains("valueAt"))
let empty = EnglishShadowAudio().report
assert(JSONSerialization.isValidJSONObject(empty))
print("PASS silence DC narrowband multichannel opposite-phase windows bounds invalid-data privacy")
}
try runShadowRegression()
`);
  const result = execFileSync('xcrun', ['swift', '-module-cache-path', join(folder, 'cache'), file], { encoding: 'utf8', timeout: 60000 });
  assert.match(result, /PASS silence DC narrowband multichannel/);
});

test('shadow implementation compiles out of Release, observes accepted English PCM only, and cannot drive endpoints', () => {
  let depth = 0;
  const release = native.split('\n').filter(line => {
    if (line.trim() === '#if DEBUG') { depth++; return false; }
    if (line.trim() === '#endif') { depth--; return false; }
    return depth === 0;
  }).join('\n');
  for (const token of ['EnglishShadowAudio', 'ShadowEnergyDistribution', 'shadow.observe', 'shadowReport', 'shadowAudio', 'english-shadow-energy-v1']) assert.equal(release.includes(token), false, token);
  const append = native.split('func append(_ buffer:')[1].split('func prepareCue()')[0];
  assert.match(append, /if gate.acceptsSpeech \{\s+state.receive[\s\S]*?request.append\(buffer\)\s+#if DEBUG\s+shadow.observe/);
  const shared = native.split('// BEGIN ENDPOINT STATE:')[1].split('// END ENDPOINT STATE')[0];
  assert.doesNotMatch(shared, /shadow|EnglishShadow/);
  assert.doesNotMatch(shadow!, /SFSpeech|AVAudio|Timer|Task|print\(|write\(|transcript|endAudio\(|setCategory/);
  const spanish = readFileSync(new NodeURL('../modules/local-foundation-models/ios/LocalFoundationModelsModule.swift', import.meta.url), 'utf8');
  assert.equal(spanish.includes('EnglishShadowAudio'), false);
});

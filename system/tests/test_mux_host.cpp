// Real shared acquisition/selection engine with independent synthetic sensors.
#include <cassert>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <vector>
#include "../esp32/ppg_transmitter/ppg_multi.h"
#include "../esp32/ppg_transmitter/ppg_frame.h"

static ppg::MultiPpg engine;
static uint8_t calibration[184];
struct Output { int owner; uint32_t start; bool usable; };
static std::vector<Output> frames;
static bool contact[ppg::kMultiChannels] = {true,true,false,false};
static uint32_t nowMs = 10000;
static void complete() {
  assert(engine.frameCount == 100);
  int owner = engine.streamOwner;
  bool usable = engine.frameContinuousContact && engine.eligible(owner, nowMs);
  frames.push_back({owner, engine.frameStartMs, usable});
  // A packet contains exactly one source even across handoffs.
  if (usable) {
    uint32_t base = owner == 0 ? 180000 : 220000;
    for (auto ir : engine.frameIR) assert(ir > base - 2500 && ir < base + 2500);
  }
  ppg::FrameV3 f{};
  f.seq = frames.size() - 1; f.t0Ms = engine.frameStartMs;
  f.rateHz = 100; f.sampleCount = 100;
  f.red = engine.frameRed; f.ir = engine.frameIR;
  uint8_t bytes[472];
  assert(ppg::encodeV3(f, bytes) == 472);
  assert(ppg::crc16(bytes, 470) == uint16_t(bytes[470] | (bytes[471] << 8)));
  engine.nextFrame(nowMs);
}
static void tick() {
  nowMs += 10;
  for (int ch = 0; ch < ppg::kMultiChannels; ++ch) {
    float pulse = std::sin(2 * 3.141592653589793 * 70 / 60 * nowMs / 1000.0);
    uint32_t base = ch == 0 ? 180000 : 220000;
    uint32_t ir = contact[ch] ? uint32_t(base + 2000 * pulse) : 1000;
    uint32_t red = contact[ch] ? uint32_t(160000 + 800 * pulse) : 1000;
    bool full = engine.feed(ch, red, ir, nowMs * 1000, nowMs);
    engine.estimateAll(nowMs, calibration, 184);
    if (full) complete();
  }
}
static void testFastValidationRejectsFlatAndNoise() {
  uint8_t table[184];
  for (auto &v : table) v = 99;
  for (unsigned seed = 0; seed < 32; ++seed) {
    ppg::MultiPpg local;
    unsigned random = seed + 1;
    for (unsigned ms = 10; ms <= 3900; ms += 10) {
      random = random * 1664525u + 1013904223u;
      int irNoise = seed ? int((random >> 16) % 401) - 200 : 0;
      random = random * 1664525u + 1013904223u;
      int redNoise = seed ? int((random >> 16) % 401) - 200 : 0;
      local.feed(0, 160000 + redNoise, 200000 + irNoise, ms * 1000, ms);
      local.estimateAll(ms, table, 184);
      if (local.eligible(0, ms)) std::fprintf(stderr, "noise accepted seed=%u ms=%u hr=%.2f corr=%.3f n=%u\n", seed, ms, local.channels[0].vitals.heartRate, local.channels[0].vitals.periodicity, local.channels[0].historyCount);
      assert(!local.eligible(0, ms));
    }
  }
  ppg::Vitals weak{70, 0.8f, 99, 0.6f, true, true};
  assert(!ppg::MultiPpg::acceptedWindow(weak, 75));
  assert(ppg::MultiPpg::acceptedWindow(weak, 100));
}
static void testFirstQualifiedLock() {
  ppg::MultiPpg local;
  for (int ch : {0, 5}) {
    auto &s = local.channels[ch];
    s.online = s.contact = s.ready = true;
    s.contactRun = 4; s.lastSampleMs = 10000;
    s.vitals.hrValid = s.vitals.spo2Valid = true;
  }
  local.channels[0].readySinceMs = 9900;
  local.channels[5].readySinceMs = 9800;
  local.nextFrame(10000);
  assert(local.selected(10000) == 5); // CH7 qualified first, despite CH2 priority.
  local.nextFrame(10000);
  assert(local.selected(10000) == 5); // Healthy source retains ownership.
  local.channels[5].ready = false;
  local.nextFrame(10000);
  assert(local.selected(10000) == 0); // Unstable source hands off to ready backup.
  local.fault(0);
  local.nextFrame(10000);
  assert(local.selected(10000) == -1); // Invalid raw fallback is never selected.
  // Eligibility ages also order correctly across millis rollover.
  for (int ch : {0, 5}) {
    auto &s = local.channels[ch];
    s.online = s.contact = s.ready = true; s.contactRun = 4;
    s.lastSampleMs = 0x20; s.vitals.hrValid = s.vitals.spo2Valid = true;
  }
  local.channels[0].readySinceMs = 0x10;
  local.channels[5].readySinceMs = 0xfffffff0;
  local.nextFrame(0x20);
  assert(local.selected(0x20) == 5);
}
int main() {
  testFirstQualifiedLock();
  testFastValidationRejectsFlatAndNoise();
  static_assert(ppg::kMultiChannels == 6, "Six sources are wired to CH2..CH7");
  for (unsigned i = 0; i < ppg::kMultiChannels; ++i) {
    assert(ppg::kMuxChannels[i] == i + 2);
    assert(ppg::muxMask(i) == (1u << (i + 2)));
    assert(!(ppg::muxMask(i) & 3)); // Never address unused CH0 or CH1.
  }
  assert(ppg::muxMask(ppg::kMultiChannels) == 0);
  for (auto &v : calibration) v = 99;
  for (auto &s : engine.channels) { s.online = true; s.lastSampleMs = nowMs; }
  engine.nextFrame(nowMs);
  const uint32_t contactStarted = nowMs;
  for (int i = 0; i < 280; ++i) tick();
  assert(engine.firstReady(nowMs) == -1); // Do not invent an instant result.
  while (engine.firstReady(nowMs) < 0 && nowMs - contactStarted < 3500) tick();
  assert(engine.eligible(0, nowMs));
  assert(nowMs - contactStarted < 3500); // Old 100-group minimum took >4s.
  for (int i = 0; i < 800; ++i) tick();
  assert(engine.firstReady(nowMs) == 0); // deterministic first channel with two fingers
  assert(engine.selected(nowMs) == 0);
  assert(engine.channels[1].historyCount == 200);
  assert(engine.eligible(1, nowMs)); // backup was continuously acquiring too
  assert(engine.channels[0].samples == engine.channels[1].samples);
  assert(engine.channels[2].samples == engine.channels[3].samples);
  auto oldFrames = frames.size();
  contact[0] = false;
  // Warm backup switches by the next packet boundary, not after a new 4s window.
  for (int i = 0; i < 110; ++i) tick();
  assert(engine.streamOwner == 1 && engine.selected(nowMs) == 1);
  assert(engine.channels[1].historyCount == 200);
  for (int i = 0; i < 110; ++i) tick();
  assert(frames.size() >= oldFrames + 2);
  assert(frames.back().owner == 1 && frames.back().usable);
  for (size_t i = 1; i < frames.size(); ++i) {
    uint32_t dt = frames[i].start - frames[i-1].start;
    assert(dt >= 980 && dt <= 1020); // uninterrupted nominal one-second cadence
  }
  // Loss on one channel never clears the other channels' buffers.
  assert(engine.channels[0].historyCount == 0);
  assert(engine.channels[1].historyCount == 200);
  engine.fault(0);
  assert(engine.selected(nowMs) == 1 && engine.eligible(1, nowMs));
  // A later lower-numbered finger must not steal the currently healthy source.
  engine.channels[0].online = true;
  contact[0] = true;
  for (int i = 0; i < 800; ++i) tick();
  assert(engine.eligible(0, nowMs));
  assert(engine.streamOwner == 1 && engine.selected(nowMs) == 1);
  contact[0] = false;
  for (int i = 0; i < 10; ++i) tick();
  // New last port CH7 participates in the same continuous warm handoff.
  contact[5] = true;
  for (int i = 0; i < 800; ++i) tick();
  assert(engine.eligible(5, nowMs));
  assert(engine.channels[5].samples == engine.channels[4].samples);
  contact[1] = false;
  for (int i = 0; i < 210; ++i) tick();
  assert(engine.streamOwner == 5 && frames.back().owner == 5);
  assert(frames.back().usable && engine.channels[5].historyCount == 200);
  contact[5] = false;
  // No fingers: one invalid raw stream continues; no valid sensor is invented.
  contact[1] = false;
  for (int i = 0; i < 150; ++i) tick();
  assert(engine.firstReady(nowMs) == -1);
  assert(engine.selected(nowMs) == -1);
  assert(!frames.back().usable);
  // A clock/read gap must invalidate stale readiness.
  engine.estimateAll(nowMs + 1000, calibration, 184);
  assert(engine.firstReady(nowMs + 1000) == -1);
  std::puts("Continuous six-source history, first-qualified lock, warm failover, packet isolation, CRC and no-contact behavior passed");
}

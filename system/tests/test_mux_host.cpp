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
static bool contact[4] = {true,true,false,false};
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
  for (int ch = 0; ch < 4; ++ch) {
    float pulse = std::sin(2 * 3.141592653589793 * 70 / 60 * nowMs / 1000.0);
    uint32_t base = ch == 0 ? 180000 : 220000;
    uint32_t ir = contact[ch] ? uint32_t(base + 2000 * pulse) : 1000;
    uint32_t red = contact[ch] ? uint32_t(160000 + 800 * pulse) : 1000;
    bool full = engine.feed(ch, red, ir, nowMs * 1000, nowMs);
    engine.estimateAll(nowMs, calibration, 184);
    if (full) complete();
  }
}
int main() {
  for (auto &v : calibration) v = 99;
  for (auto &s : engine.channels) { s.online = true; s.lastSampleMs = nowMs; }
  engine.nextFrame(nowMs);
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
  // No fingers: one invalid raw stream continues; no valid sensor is invented.
  contact[1] = false;
  for (int i = 0; i < 150; ++i) tick();
  assert(engine.firstReady(nowMs) == -1);
  assert(engine.selected(nowMs) == -1);
  assert(!frames.back().usable);
  // A clock/read gap must invalidate stale readiness.
  engine.estimateAll(nowMs + 1000, calibration, 184);
  assert(engine.firstReady(nowMs + 1000) == -1);
  std::puts("Continuous four-source history, priority, warm failover, packet isolation, CRC and no-contact behavior passed");
}

#pragma once
#include <stdint.h>
#include <string.h>
#include "ppg_vitals.h"
#include "sample_clock.h"

namespace ppg {
constexpr int kMultiChannels = 4;
constexpr int kMultiHistory = 200;
constexpr int kMultiMinimum = 100;
constexpr int kMultiFrameSamples = 100;
constexpr uint32_t kMultiContactIR = 100000;

struct ChannelSignal {
  bool online = false;
  bool contact = false;
  bool ready = false;
  unsigned contactRun = 0;
  unsigned goodWindows = 0;
  unsigned historyCount = 0;
  unsigned group = 0;
  uint32_t redSum = 0, irSum = 0;
  uint32_t red = 0, ir = 0, samples = 0, faults = 0;
  uint32_t lastSampleMs = 0, lastEstimateMs = 0;
  float rawHz = 0;
  float redHistory[kMultiHistory]{}, irHistory[kMultiHistory]{};
  SampleClock<kMultiHistory> clock;
  Vitals vitals{0,0,0,0,false,false};

  void clearSignal() {
    contact = ready = false;
    contactRun = goodWindows = historyCount = group = 0;
    redSum = irSum = 0;
    rawHz = 0;
    clock.clear();
    vitals = Vitals{0,0,0,0,false,false};
  }
};

// Each input channel maintains independent contact, waveform and timing history.
// Only streamOwner contributes raw samples to an output block. Ownership changes
// at complete block boundaries, so a packet never mixes sensors or resets a
// healthy backup's estimator. Hardware drains all four FIFOs between packets.
class MultiPpg {
 public:
  ChannelSignal channels[kMultiChannels];
  int streamOwner = -1;
  unsigned frameCount = 0;
  uint32_t frameStartMs = 0;
  uint32_t frameRed[kMultiFrameSamples]{}, frameIR[kMultiFrameSamples]{};
  bool frameContinuousContact = true;

  void fault(int channel) {
    ChannelSignal &s = channels[channel];
    s.online = false;
    ++s.faults;
    s.clearSignal();
    // With no samples from this device, a partial packet cannot be completed.
    // Discard only that packet; other channels' warm histories survive.
    if (streamOwner == channel) { frameCount = 0; streamOwner = -1; }
  }

  bool eligible(int channel, uint32_t nowMs) const {
    const ChannelSignal &s = channels[channel];
    return s.online && s.ready && s.contact && s.contactRun >= 4 &&
           nowMs - s.lastSampleMs < 300 && s.vitals.hrValid && s.vitals.spo2Valid;
  }

  int firstReady(uint32_t nowMs) const {
    for (int i = 0; i < kMultiChannels; ++i) if (eligible(i, nowMs)) return i;
    return -1;
  }

  int selected(uint32_t nowMs) const {
    return streamOwner >= 0 && eligible(streamOwner, nowMs) ? streamOwner : -1;
  }

  void nextFrame(uint32_t nowMs) {
    streamOwner = firstReady(nowMs);
    if (streamOwner < 0) {
      // Keep the existing invalid-value behavior and one raw stream even while
      // warming up/no finger. Do not claim these fallback readings are valid.
      for (int i = 0; i < kMultiChannels; ++i)
        if (channels[i].online && channels[i].contact) { streamOwner = i; break; }
      if (streamOwner < 0)
        for (int i = 0; i < kMultiChannels; ++i)
          if (channels[i].online) { streamOwner = i; break; }
    }
    frameCount = 0;
    frameContinuousContact = true;
  }

  bool feed(int channel, uint32_t red, uint32_t ir, uint32_t nowUs, uint32_t nowMs) {
    ChannelSignal &s = channels[channel];
    s.red = red; s.ir = ir; ++s.samples;
    s.lastSampleMs = nowMs;
    s.online = true;
    s.contact = ir >= kMultiContactIR;
    if (!s.contact) {
      s.clearSignal();
    } else {
      ++s.contactRun;
      s.redSum += red; s.irSum += ir;
      if (++s.group == 4) {
        if (s.historyCount == kMultiHistory) {
          memmove(s.redHistory, s.redHistory + 1, (kMultiHistory - 1) * sizeof(float));
          memmove(s.irHistory, s.irHistory + 1, (kMultiHistory - 1) * sizeof(float));
          --s.historyCount;
        }
        s.redHistory[s.historyCount] = s.redSum / 4.0f;
        s.irHistory[s.historyCount++] = s.irSum / 4.0f;
        s.clock.push(nowUs);
        s.redSum = s.irSum = s.group = 0;
      }
    }
    if (channel == streamOwner && frameCount < kMultiFrameSamples) {
      if (!frameCount) frameStartMs = nowMs;
      frameRed[frameCount] = red; frameIR[frameCount++] = ir;
      frameContinuousContact = frameContinuousContact && s.contact;
    }
    return frameCount == kMultiFrameSamples;
  }

  void estimateAll(uint32_t nowMs, const uint8_t *table, int tableLen) {
    for (int i = 0; i < kMultiChannels; ++i) {
      ChannelSignal &s = channels[i];
      if (!s.online || nowMs - s.lastSampleMs >= 300) {
        s.clearSignal(); continue;
      }
      if (nowMs - s.lastEstimateMs < 250) continue;
      s.lastEstimateMs = nowMs;
      float fs = s.clock.rateHz();
      s.rawHz = fs * 4;
      s.vitals = Vitals{0,0,0,0,false,false};
      if (s.contact && s.historyCount >= kMultiMinimum && fs > 0) {
        s.vitals = estimate(s.redHistory, s.irHistory, acRed_, acIR_,
                           s.historyCount, fs, 30, 220, table, tableLen);
      }
      bool accepted = s.vitals.hrValid && s.vitals.spo2Valid &&
                      s.vitals.spo2 >= 70 && s.vitals.spo2 <= 100;
      s.goodWindows = accepted ? s.goodWindows + 1 : 0;
      s.ready = s.goodWindows >= 2;
    }
  }
 private:
  float acRed_[kMultiHistory]{}, acIR_[kMultiHistory]{};
};
} // namespace ppg

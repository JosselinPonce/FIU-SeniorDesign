#pragma once
#include <stdint.h>
#include <string.h>
#include "ppg_vitals.h"
#include "sample_clock.h"

namespace ppg {
// Logical PPG1..PPG6 map to the rewired physical TCA9548A ports CH2..CH7.
constexpr uint8_t kMuxChannels[] = {2, 3, 4, 5, 6, 7};
constexpr int kMultiChannels = sizeof(kMuxChannels) / sizeof(kMuxChannels[0]);
constexpr uint8_t muxMask(unsigned index) {
  return index < kMultiChannels ? static_cast<uint8_t>(1u << kMuxChannels[index]) : 0;
}
constexpr int kMultiHistory = 200;
constexpr int kMultiMinimum = 75; // First attempt at ~3 s, rather than ~4 s.
constexpr uint32_t kMultiEstimateEveryMs = 125;
constexpr float kMultiFastPeriodicity = 0.7f; // Stronger evidence for <4-s windows.
constexpr int kMultiFrameSamples = 100;
constexpr uint32_t kMultiContactIR = 100000;

struct ChannelSignal {
  bool online = false;
  bool contact = false;
  bool ready = false;
  unsigned contactRun = 0;
  unsigned goodWindows = 0;
  uint32_t readySinceMs = 0;
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
    readySinceMs = 0;
    redSum = irSum = 0;
    rawHz = 0;
    clock.clear();
    vitals = Vitals{0,0,0,0,false,false};
  }
};

// Each input channel maintains independent contact, waveform and timing history.
// Only streamOwner contributes raw samples to an output block. Ownership changes
// at complete block boundaries, so a packet never mixes sensors or resets a
// healthy backup's estimator. Hardware drains all sensor FIFOs between packets.
class MultiPpg {
 public:
  static bool acceptedWindow(const Vitals &v, int length, float fs = 25.0f) {
    return v.hrValid && v.spo2Valid && v.spo2 >= 70 && v.spo2 <= 100 &&
           // At least 2.5 estimated pulse periods in a short window prevents a
           // high correlation at a long, poorly supported lag qualifying noise.
           (length >= 100 || (v.periodicity >= kMultiFastPeriodicity && fs > 0 &&
                             v.heartRate * length >= 150.0f * fs));
  }
  ChannelSignal channels[kMultiChannels];
  int streamOwner = -1;
  int activeSource = -1; // Qualified source; separate from invalid raw fallback.
  unsigned frameCount = 0;
  uint32_t frameStartMs = 0;
  uint32_t frameRed[kMultiFrameSamples]{}, frameIR[kMultiFrameSamples]{};
  bool frameContinuousContact = true;

  void fault(int channel) {
    ChannelSignal &s = channels[channel];
    s.online = false;
    ++s.faults;
    s.clearSignal();
    if (activeSource == channel) activeSource = -1;
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
    int first = -1;
    for (int i = 0; i < kMultiChannels; ++i) {
      if (!eligible(i, nowMs)) continue;
      // Largest unsigned age = earliest continuously qualified source. Ties
      // use channel order; a later lower channel cannot preempt a healthy lock.
      if (first < 0 || nowMs - channels[i].readySinceMs >
                       nowMs - channels[first].readySinceMs) first = i;
    }
    return first;
  }

  int selected(uint32_t nowMs) const {
    return activeSource >= 0 && activeSource == streamOwner &&
           eligible(activeSource, nowMs) ? activeSource : -1;
  }

  void nextFrame(uint32_t nowMs) {
    if (activeSource < 0 || !eligible(activeSource, nowMs))
      activeSource = firstReady(nowMs);
    streamOwner = activeSource;
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
      if (nowMs - s.lastEstimateMs < kMultiEstimateEveryMs) continue;
      s.lastEstimateMs = nowMs;
      float fs = s.clock.rateHz();
      s.rawHz = fs * 4;
      s.vitals = Vitals{0,0,0,0,false,false};
      if (s.contact && s.historyCount >= kMultiMinimum && fs > 0) {
        // During qualification, try recent settled contact before the older
        // startup/pressure transient. Ready channels retain the longer window.
        const bool recentFirst = !s.ready && s.historyCount > kMultiMinimum;
        const int length = recentFirst ? kMultiMinimum : s.historyCount;
        const int offset = s.historyCount - length;
        s.vitals = estimate(s.redHistory + offset, s.irHistory + offset, acRed_, acIR_,
                           length, fs, 30, 220, table, tableLen);
        const bool accepted = acceptedWindow(s.vitals, length, fs);
        // Keep a full-history estimate available when the shorter window fails.
        // For an already ready source, also allow a good recent window to avoid
        // waiting for an old disturbance to age out of all eight seconds.
        if (!accepted && s.historyCount > kMultiMinimum) {
          const int fallbackLength = recentFirst ? s.historyCount : kMultiMinimum;
          const int fallbackOffset = s.historyCount - fallbackLength;
          s.vitals = estimate(s.redHistory + fallbackOffset, s.irHistory + fallbackOffset,
                             acRed_, acIR_, fallbackLength, fs, 30, 220, table, tableLen);
          if (!acceptedWindow(s.vitals, fallbackLength, fs))
            s.vitals.hrValid = s.vitals.spo2Valid = false;
        } else if (!accepted) {
          s.vitals.hrValid = s.vitals.spo2Valid = false;
        }
      }
      bool accepted = s.vitals.hrValid && s.vitals.spo2Valid &&
                      s.vitals.spo2 >= 70 && s.vitals.spo2 <= 100;
      s.goodWindows = accepted ? s.goodWindows + 1 : 0;
      const bool wasReady = s.ready;
      s.ready = s.goodWindows >= 2;
      if (s.ready && !wasReady) s.readySinceMs = nowMs;
      if (!s.ready) s.readySinceMs = 0;
    }
  }
 private:
  float acRed_[kMultiHistory]{}, acIR_[kMultiHistory]{};
};
} // namespace ppg

#pragma once
#include <stdint.h>

// Time basis for a contiguous estimator window. Unsigned subtraction handles
// micros() rollover; a window is only a few seconds long. FIFO overflow and
// contact interruption must clear the window rather than reuse this clock.
template<int Capacity> class SampleClock {
 public:
  void clear() { count_ = 0; }
  void push(uint32_t timeUs) {
    if (count_ == Capacity) {
      for (int i = 1; i < Capacity; ++i) times_[i - 1] = times_[i];
      --count_;
    }
    times_[count_++] = timeUs;
  }
  float rateHz() const {
    if (count_ < 2) return 0;
    uint32_t span = times_[count_ - 1] - times_[0];
    return span ? (count_ - 1) * 1000000.0f / span : 0;
  }
 private:
  uint32_t times_[Capacity]{};
  int count_ = 0;
};

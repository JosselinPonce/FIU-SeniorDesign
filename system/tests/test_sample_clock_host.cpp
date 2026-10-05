#include <cassert>
#include <cmath>
#include <cstdint>
#include "../esp32/mux_diagnostic/sample_clock.h"
#include "../esp32/ppg_transmitter/ppg_vitals.h"

int main() {
  constexpr int n = 100;
  float red[n], ir[n], acRed[n], acIr[n];
  const float rawRates[] = {96.0f, 100.0f, 103.5f, 108.0f};
  for (float rawRate : rawRates) {
    SampleClock<n> clock;
    const float fs = rawRate / 4;
    const float targetBpm = 70;
    for (int i = 0; i < n; ++i) {
      float t = i / fs;
      // A physical 70 BPM pulse, sampled with different sensor clock rates.
      red[i] = 180000 + 1000 * std::sin(2 * 3.141592653589793 * targetBpm / 60 * t);
      ir[i] = 200000 + 2000 * std::sin(2 * 3.141592653589793 * targetBpm / 60 * t);
      clock.push(static_cast<uint32_t>(std::lround(t * 1000000)));
    }
    auto measured = ppg::estimate(red, ir, acRed, acIr, n, clock.rateHz(),
                                  30, 220, nullptr, 0);
    assert(measured.hrValid);
    assert(std::fabs(measured.heartRate - targetBpm) < 1.0f);
    auto nominal = ppg::estimate(red, ir, acRed, acIr, n, 25,
                                 30, 220, nullptr, 0);
    if (rawRate > 103) assert(nominal.heartRate < measured.heartRate - 1.5f);
  }
  SampleClock<4> rollover;
  rollover.push(UINT32_MAX - 9999);
  rollover.push(10000);
  assert(std::fabs(rollover.rateHz() - 50) < 0.01f);
  rollover.clear();
  assert(rollover.rateHz() == 0);
  // Sliding windows must discard the old rate as new timestamps arrive.
  const uint32_t times[] = {0u, 40000u, 80000u, 120000u, 160000u, 200000u, 240000u, 280000u};
  for (uint32_t t : times) rollover.push(t);
  assert(std::fabs(rollover.rateHz() - 25) < 0.01f);
}

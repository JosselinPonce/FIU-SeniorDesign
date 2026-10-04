// Host test for esp32/ppg_transmitter/ppg_vitals.h. Exits non-zero on failure.
// Synthetic PPG: a systolic peak plus a dicrotic bump at 40% of the beat with
// 45% of its height -- the feature that makes Maxim's valley picker count two
// beats per heartbeat -- on top of baseline drift and noise.
#include <cstdio>
#include <cstdlib>
#include <cmath>
#include <initializer_list>
#include "../esp32/ppg_transmitter/ppg_vitals.h"

constexpr float kFs = 25.0f;
constexpr int kN = 200;          // 8 s window, as on the ESP32
static int failures = 0;

static float pulse(float phase) {        // phase in [0,1)
  auto g = [](float x, float mu, float s) { return std::exp(-0.5f * (x - mu) * (x - mu) / (s * s)); };
  return g(phase, 0.15f, 0.06f) + 0.45f * g(phase, 0.40f, 0.07f);   // systolic + dicrotic
}

static void makeSignal(float bpm, float dc, float acFrac, float noise, float* out, unsigned seed) {
  std::srand(seed);
  for (int i = 0; i < kN; ++i) {
    const float t = i / kFs;
    const float ph = std::fmod(t * bpm / 60.0f, 1.0f);
    const float wander = 0.004f * dc * std::sin(2 * M_PI * 0.15f * t);   // breathing drift
    const float n = noise * dc * ((std::rand() / (float)RAND_MAX) - 0.5f);
    out[i] = dc * (1.0f - acFrac * pulse(ph)) + wander + n;   // light absorbed on each beat
  }
}

int main() {
  float red[kN], ir[kN], a[kN], b[kN];
  uint8_t idTable[184];
  for (int i = 0; i < 184; ++i) idTable[i] = static_cast<uint8_t>(i);  // spo2 == index, to check R

  std::printf("%-8s %-10s %-8s %s\n", "true", "estimated", "error", "periodicity");
  for (float bpm : {45.f, 60.f, 72.f, 80.f, 95.f, 110.f, 130.f, 150.f, 180.f}) {
    for (unsigned seed = 1; seed <= 5; ++seed) {
      makeSignal(bpm, 240000, 0.005f, 0.0006f, ir, seed);
      makeSignal(bpm, 180000, 0.004f, 0.0006f, red, seed + 100);
      auto v = ppg::estimate(red, ir, a, b, kN, kFs, 30, 220, idTable, 184);
      const float err = v.heartRate - bpm;
      if (seed == 1) std::printf("%-8.0f %-10.1f %-8.2f %.2f\n", bpm, v.heartRate, err, v.periodicity);
      if (!v.hrValid || std::fabs(err) > 2.0f) {
        std::printf("FAIL bpm=%.0f seed=%u est=%.1f valid=%d\n", bpm, seed, v.heartRate, v.hrValid);
        ++failures;
      }
    }
  }

  // Firmware first attempts an estimate after two warm-up frames (3 s).
  // Exercise the shorter window across heart rates and noise seeds too.
  for (float bpm : {45.f, 60.f, 72.f, 80.f, 95.f, 110.f, 130.f, 150.f, 180.f}) {
    for (unsigned seed = 1; seed <= 5; ++seed) {
      makeSignal(bpm, 240000, 0.005f, 0.0006f, ir, seed);
      makeSignal(bpm, 180000, 0.004f, 0.0006f, red, seed + 100);
      auto v = ppg::estimate(red, ir, a, b, 75, kFs, 30, 220, idTable, 184);
      if (!v.hrValid || std::fabs(v.heartRate - bpm) > 3.0f) {
        std::printf("FAIL 3 s bpm=%.0f seed=%u est=%.1f valid=%d\n", bpm, seed, v.heartRate, v.hrValid);
        ++failures;
      }
    }
  }
  // Two seconds do not cover the estimator's full configured lag range.
  auto early = ppg::estimate(red, ir, a, b, 50, kFs, 30, 220, idTable, 184);
  if (early.hrValid || early.spo2Valid) { std::printf("FAIL premature estimate\n"); ++failures; }

  // Ratio of ratios: red AC/DC = 0.004*k, IR AC/DC = 0.005*k -> R = 0.8 exactly
  // for identical pulse shapes (noise off), so the table index must be 80.
  makeSignal(75, 240000, 0.005f, 0, ir, 7);
  makeSignal(75, 180000, 0.004f, 0, red, 7);
  auto s = ppg::estimate(red, ir, a, b, kN, kFs, 30, 220, idTable, 184);
  std::printf("\nR expected 0.800, got %.3f -> table index %d (valid=%d)\n", s.ratio, s.spo2, s.spo2Valid);
  if (!s.spo2Valid || std::fabs(s.ratio - 0.8f) > 0.02f) { std::printf("FAIL ratio\n"); ++failures; }

  // Pure noise must not produce a heart rate (or an SpO2).
  std::srand(99);
  for (int i = 0; i < kN; ++i) {
    ir[i] = 240000 + 300 * ((std::rand() / (float)RAND_MAX) - 0.5f);
    red[i] = 180000 + 300 * ((std::rand() / (float)RAND_MAX) - 0.5f);
  }
  auto z = ppg::estimate(red, ir, a, b, kN, kFs, 30, 220, idTable, 184);
  std::printf("noise only: hrValid=%d spo2Valid=%d periodicity=%.2f\n", z.hrValid, z.spo2Valid, z.periodicity);
  if (z.hrValid || z.spo2Valid) { std::printf("FAIL noise accepted\n"); ++failures; }

  auto shortNoise = ppg::estimate(red, ir, a, b, 75, kFs, 30, 220, idTable, 184);
  if (shortNoise.hrValid || shortNoise.spo2Valid) { std::printf("FAIL 3 s noise accepted\n"); ++failures; }
  for (int i = 0; i < kN; ++i) { ir[i] = 240000; red[i] = 180000; }
  auto flat = ppg::estimate(red, ir, a, b, 75, kFs, 30, 220, idTable, 184);
  if (flat.hrValid || flat.spo2Valid) { std::printf("FAIL flat contact accepted\n"); ++failures; }

  std::printf("\n%s (%d failures)\n", failures ? "FAILED" : "ALL PASSED", failures);
  return failures ? 1 : 0;
}

// Bench build of the actual transmitter, with USB dashboard telemetry enabled.
// BLE still exposes Luis's existing single protocol-v3 stream.
#define PPG_BENCH_TELEMETRY 1
// Existing encoded outgoing frame, mirrored to USB for waveform replay only.
#define PPG_SERIAL_RAW 1
#include "../ppg_transmitter/ppg_transmitter.ino"

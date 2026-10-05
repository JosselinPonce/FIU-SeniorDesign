# ESP32 multi-PPG firmware

> **Branch: `samantha/multi-ppg`.** The multi-PPG documentation below describes this branch only. Luis’s original guide is retained as the ecosystem reference.

Four MAX30102 modules connect through one TCA9548A MUX. The ESP32 selects
one usable source for Luis's existing protocol-v3 stream for the Raspberry Pi.
All four modules remain awake and sample continuously. Each has independent
contact, timing and waveform history, so a qualified backup does not restart
its estimator when the outgoing source changes.

**Current acquisition behavior supersedes the earlier sleeping-sensor design
in the implementation PDF.** See [the continuous acquisition guide](mux_diagnostic/README.md)
for the current dashboard, warm backup selection and packet-boundary handoff.

**Power on starts the flashed firmware automatically.** No editor, laptop,
terminal, or USB permission command is required during normal operation.

## Documentation

- **[Technical guide (PDF)](../../docs/Team18_Multi_PPG_Implementation_Guide.pdf)** — architecture, folder/file responsibilities, algorithm timing, invalid readings, test evidence, and limitations.
- [Editable guide](../../docs/MULTI_PPG_IMPLEMENTATION_GUIDE.md).
- [Luis's original ecosystem guide](../../docs/Team18_System_Guide.pdf) — Pi, phone, database and web architecture/setup.

The new guide replaces the former `MULTI_PPG.md` and `BENCH_REVIEW.md`; their
findings are consolidated there. The previous PDF is replaced at the same
path, avoiding multiple competing editions.

## Files

| Path | Purpose |
|---|---|
| `ppg_transmitter/ppg_transmitter.ino` | Startup, MUX selection, acquisition, history and BLE transmission |
| `ppg_transmitter/ppg_multi.h` | Per-channel histories, quality, deterministic selection and one-source packets |
| `ppg_transmitter/sample_clock.h` | Measured estimator time basis for each source |
| `ppg_transmitter/ppg_vitals.h` | Luis's unchanged pulse/SpO2 estimator |
| `ppg_transmitter/ppg_frame.h` | Luis's unchanged binary encoder and CRC |
| `flash_esp32.sh` | Luis's terminal compile/upload script |
| `decode_serial_capture.py` | Converts optional diagnostic RAW serial packets into CSV |
| `../tests/` | Protocol, synthetic-estimator and simulated-MUX tests |

## Flash and inspect from any terminal

Run from the repository root. Install Arduino CLI, ESP32 core 3.3.12 and
SparkFun MAX3010x library 1.1.2 as documented in the guide. Close an existing
serial monitor before uploading. Substitute the actual serial port if needed.

```bash
bash system/esp32/flash_esp32.sh /dev/ttyUSB0
~/.local/bin/arduino-cli monitor -p /dev/ttyUSB0 -c baudrate=115200
```

Upload only when installing or updating firmware. To save optional diagnostics:

```bash
~/.local/bin/arduino-cli monitor -p /dev/ttyUSB0 -c baudrate=115200 \
  2>&1 | tee -a /tmp/team18-esp32-serial.log
```

The Fedora serial permission applies to computer access, not firmware startup.
See the guide for temporary access and Luis's persistent udev rule.

## Interpreting output

The normal transmitter prints one compact line per 100-sample packet.
Unavailable USB vitals display `--`; BLE preserves `-999` and validity flags.
`link=down` means Pi receipt is not established.

The dashboard-enabled build uses the same transmitter and BLE implementation,
with additional USB JSON telemetry. All four sensor counters and histories
advance continuously. The first usable channel in order 0–3 is selected at a
complete packet boundary; every packet contains 100 red/IR pairs from exactly
one source. Initial contact still needs enough samples for a usable estimate,
but another sensor's history is retained through a handoff. With no usable
contact, the firmware continues a single raw stream with invalid vital flags;
it does not invent valid measurements. Acquisition faults can still cause gaps.

Host tests cover warm backup failover, channel priority, packet isolation,
cadence under simulated contact loss, timing correction, protocol CRC and the
UI. Live hardware, reference accuracy and Pi/phone delivery must be checked
separately. Keeping all four awake increases sensor activity and power use
compared with the old sleep policy.

## Tests and PDF build

```bash
python3 -m unittest discover -s system/tests -v
```

The PDF uses `docs/tools/build_multi_ppg_guide.py`. In a virtual environment
with `markdown-it-py` and `weasyprint` installed:

```bash
python docs/tools/build_multi_ppg_guide.py
```

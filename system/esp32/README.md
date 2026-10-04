# ESP32 multi-PPG firmware

> **Branch: `samantha/multi-ppg`.** The multi-PPG documentation below describes this branch only. Luis’s original guide is retained as the ecosystem reference.

Four MAX30102 modules connect through one TCA9548A MUX. The ESP32 selects
one module with sustained optical contact, keeps the others asleep, and
builds Luis's existing single-source protocol-v3 stream for the Raspberry Pi.

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

- `WARMUP`: accumulating clean history; first estimate attempted after about three seconds.
- `NO_ACCEPTED_PULSE`: an estimate was attempted but rejected. There is no fixed tenth-reading trigger.
- `bpm=-- spo2=--`: unavailable USB display. BLE still carries numeric `-999` and original validity flags.
- `bpm=` / `spo2=`: main estimates; `maxim=` is a separate serial-only comparison.
- `link=down`: no BLE client connection; Pi receipt is not established.

**Validation status:** selection and contact switching were exercised; 21
host tests passed. Some accepted rate estimates jumped substantially.
Measurement accuracy and live ESP32 → Pi → phone delivery remain unverified.
The MUX selects contact, not the best pulse-quality sensor.

## Tests and PDF build

```bash
python3 -m unittest discover -s system/tests -v
```

The PDF uses `docs/tools/build_multi_ppg_guide.py`. In a virtual environment
with `markdown-it-py` and `weasyprint` installed:

```bash
python docs/tools/build_multi_ppg_guide.py
```

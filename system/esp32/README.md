> **October 18 validation latency update:** First attempts now use 75 grouped
> samples (about 3 seconds) and run every 125 ms. Shorter-than-100-group windows
> need periodicity >=0.7 and at least 2.5 estimated pulse periods, in addition to
> existing vital validity/range checks. Two accepted updates still qualify a
> source. Unready sensors try the recent 3-second window before older history;
> longer-window estimates remain available. Hardware faults still reset history.
> Startup now proceeds when at least one sensor initializes; offline channels
> retry in the background instead of blocking healthy channels and BLE.
> If none initialize, the dashboard receives a BLOCKED hardware status.
> This reduces software waiting; it does not guarantee a valid result in 3 seconds.

> **October 16, 2026 wiring update:** The current firmware uses six PPGs on
> physical TCA9548A channels **2, 3, 4, 5, 6, 7**, respectively PPG1–PPG6.
> GPIO21/SDA, GPIO22/SCL, MUX address 0x70 and sensor address 0x57 are unchanged.
> All six acquire continuously; only one supplies each unchanged BLE packet.
> **October 18 selection correction:** The first continuously qualified source
> stays selected while usable. A later lower-numbered channel does not preempt it.
> On loss, the earliest-qualified healthy backup takes over at a packet boundary.
> CH2 → CH7 breaks ties only. Warm backups retain their histories.
> I2C remains at 400 kHz. A 100-kHz hardware trial increased read failures
> and was reverted. Repeated CH4/CH7 I2C faults remain unresolved.
> The four-sensor/CH0–3 instructions and October 4 measurements below describe
> the earlier wiring. The October 18 capture below provides limited six-sensor bench evidence.

# ESP32 multi-PPG firmware

> **Branch: `Josselin-Testing-101`.** Current wiring uses six sources; older PDFs retain historical four-source details.

Six MAX30102 modules connect through one TCA9548A MUX. The ESP32 selects
one usable source for Luis's existing protocol-v3 stream for the Raspberry Pi.
All six modules remain awake and sample continuously. Each has independent
contact, timing and waveform history, so a qualified backup does not restart
its estimator when the outgoing source changes.

**Current acquisition behavior supersedes the earlier sleeping-sensor design
in the implementation PDF.** See [the continuous acquisition guide](mux_diagnostic/README.md)
for the current dashboard, warm backup selection and packet-boundary handoff.

**Power on starts the flashed firmware automatically.** No editor, laptop,
terminal, or USB permission command is required during normal operation.

## October 18 performance capture

FIFO pointer/overflow registers are read in one contiguous transaction rather
than three separate reads. Bench firmware buffers USB output and updates one
sensor row every 80 ms (about 480 ms per six-row cycle). It also logs the
unchanged outgoing raw packets and per-frame maximum polling/estimation times.
These diagnostics do not alter the BLE packet format or receiver code.

During a reviewed 64-frame segment, all six sample counters advanced; recorded
packets had no CRC failures and no new sensor-fault events occurred. Maximum
observed polling and estimation durations were about 5.08 ms and 2.25 ms.
PPG4/CH5 took approximately 12.33 seconds from observed contact to TRACKING.
This is **not** a three-second acquisition guarantee or an accuracy validation.
Earlier CH4/CH7 faults remain relevant despite their absence in this segment.

An offline replay of the captured PPG4 waveform first qualified at about
17.1 seconds with the original four-source engine and 11.9 seconds with the
current engine. Replay uses interpolated sample timestamps, so it is a
controlled algorithm comparison rather than an exact hardware timing test.
Rejected pulse windows, rather than slow MUX polling, account for the long
observed validation delay. Additional filtering variants were tested offline
and not installed because they did not improve first qualification.
Pi/phone receipt and comparison against a reference instrument remain untested
in this capture. Bench logs are local `/tmp` artifacts and are not committed.

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
separately. Keeping all six awake increases sensor activity and power use
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

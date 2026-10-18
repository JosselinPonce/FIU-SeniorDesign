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

# Continuous six-PPG acquisition and bench dashboard

The confirmed hardware is ESP32 GPIO21/SDA and GPIO22/SCL -> one TCA9548A
at 0x70 -> six MAX30102s at 0x57 on separate MUX channels 2–7. The photos
and schematic show one MUX; the small black power converter is not another.

This implementation replaces the earlier sequential sleep/probe design.
All six sensors stay awake and collect at nominal 100 raw samples/second.
The MUX exposes only one I2C channel at a time, but disconnecting a channel
leaves its sensor sampling into its own FIFO. The firmware drains all six
FIFOs frequently and maintains independent waveform and timing history.

## One outgoing stream, warm backups

Each sensor has its own contact state, 200 grouped-sample history (roughly eight
seconds), and measured sample-clock time basis. Four raw pairs are averaged
into one estimator sample. A first estimate needs 75 grouped samples (roughly
three seconds), and two accepted 125 ms updates qualify the source.
Short windows require periodicity >=0.7 and at least 2.5 estimated pulse periods. These updates
overlap; they are not independent validations. Signal processing uses Luis's
unchanged `ppg_vitals.h` estimator and existing SpO2 table. The provisional IR
contact threshold remains 100000.

At each complete packet boundary, retain the current qualified source while
it stays usable. Otherwise choose the earliest continuously qualified backup;
simultaneous qualification is resolved by PPG1/CH2 through PPG6/CH7 order. All other sources keep their
histories and sampling counters. Removing the selected finger does not clear
a healthy backup's history. A backup that is already qualified supplies the
next packet without a new four-second warm-up.

Each packet still contains exactly 100 red/IR pairs from one sensor. The format,
CRC, BLE service/characteristic UUIDs and MTU chunking are unchanged. Sequence
numbers continue through a handoff. Switching occurs at packet boundaries, so
normal packet cadence is about one second; this is not a promise of an
instantaneous mid-packet switch. A packet straddling contact loss is marked
invalid. With no usable source, a single raw fallback stream continues with
`-999` vitals and original invalid flags. Missing data or hardware faults cannot
be concealed; an unreadable source can force a partial packet to be discarded.

The Pi and phone software are unchanged. Actual BLE receipt and end-to-end
operation need a connected receiver test. Correct sample timing alone does not
establish physiological measurement accuracy.

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

## Dashboard and terminal commands

`mux_diagnostic.ino` now builds the **actual transmitter** with
`PPG_BENCH_TELEMETRY=1`. It includes the production source rather than maintaining
a different acquisition implementation. BLE remains enabled and carries only
one source. USB JSON telemetry provides all six sensors' status to the
optional laptop dashboard.

From the repository root, close any serial monitor first:

```bash
bash system/esp32/bench/run_diagnostic.sh flash /dev/ttyUSB0
bash system/esp32/bench/run_diagnostic.sh dashboard /dev/ttyUSB0
```

The dashboard shows:

- `WAITING`: no finger contact.
- `VALIDATING`: contact exists, but no accepted signal is ready yet.
- `READY`: a qualified backup is continuously acquiring.
- `TRACKING`: selected for the single outgoing stream.
- `FAULT` or `STALE`: unavailable hardware or missing updates.

Unlike the old sleep policy, all six rows contain recent observations. Age
identifies the time since the host received that row. The selected-source banner
comes from a dedicated `selected_channel` field, so a background sensor's update
cannot replace the displayed selection. The output line shows packet sequence,
source, validity and BLE connection state. `TRACKING` alone displays BPM/SpO2. Backups show contact and readiness,
but their local estimates do not appear as additional vital readouts.

Logs default to timestamped JSONL files in `/tmp`. Each event gets a UTC host
receive timestamp. `frame` events expose packet cadence, sequence and source;
`sensor_fault` events identify FIFO, MUX and I2C failures. `raw_hz` exposes the
measured estimator time basis. Unknown physical labels remain unspecified.

```bash
python3 system/esp32/bench/dashboard.py --port /dev/ttyUSB0 \
  --log /tmp/team18-continuous.jsonl --map-out /tmp/team18-ppg-map.json
```

Use q or Ctrl+C to close the dashboard; flashed acquisition and BLE continue.
For normal autonomous operation without extra USB telemetry:

```bash
bash system/esp32/flash_esp32.sh /dev/ttyUSB0
```

The launcher `restore` action installs this normal build. It does not restore
the obsolete sleep/probe design. No editor, laptop or dashboard is required at
power-up for either build.

## Hardware test

1. Confirm all four sample counters advance, including sensors without fingers.
2. Place fingers on two sensors and support the hand until both qualify.
3. Confirm the first qualified source remains selected when another source becomes ready.
4. Remove its finger while keeping the other steady. Confirm the backup stays
   warm and supplies the next complete packet without a validation restart.
5. Repeat with each pair. Compare packet start-time differences and consecutive
   sequence numbers around handoffs, and inspect fault events.
6. Remove all fingers: no valid selected source should be reported, and the
   fallback packets must retain invalid vital flags.
7. Compare simultaneous stable readings with a reference device. One matching
   number is insufficient to establish accuracy across sensors or conditions.

Actual physical positions remain to be labeled:

| Sensor | MUX | Channel | Physical position |
| --- | --- | --- | --- |
| PPG1 | 0x70 | 0 | Not confirmed |
| PPG2 | 0x70 | 1 | Not confirmed |
| PPG3 | 0x70 | 2 | Not confirmed |
| PPG4 | 0x70 | 3 | Not confirmed |

## Files and validation

- `../ppg_transmitter/ppg_transmitter.ino`: hardware FIFO polling, startup,
  recovery, existing BLE handling, one-source packet encoding and optional
  dashboard telemetry.
- `../ppg_transmitter/ppg_multi.h`: independent per-channel histories, selection
  priority, freshness and single-source packet collection.
- `../ppg_transmitter/sample_clock.h`: actual estimator-window timing.
- `../ppg_transmitter/ppg_vitals.h`, `ppg_frame.h`: unchanged Luis estimator and
  packet encoder.
- `mux_diagnostic.ino`: dashboard-enabled build of that transmitter.
- `sample_clock.h`: compatibility include for earlier bench timing tests.
- `../bench/dashboard.py`: live UI, reconnect/stale checks, logging and mapping.
- `../bench/run_diagnostic.sh`: editor-independent flash/dashboard/normal-build commands.
- `../../tests/test_mux_host.cpp`: actual shared engine exercised with synthetic
  PPGs; validates two-contact priority, warm failover, history preservation,
  no mixed packets, CRC, simulated frame cadence and invalid no-contact output.
- `../../tests/test_sample_clock_host.cpp`: known 70 BPM signals at multiple
  sample rates, timestamp rollover and reset checks.
- `../../tests/test_bench_dashboard.py`: selection, stale data, concurrent
  background updates and handoff UI checks.

Earlier six-second per-channel captures and the 0.55-second sequential sweep
measurement describe the superseded bench design. They do not validate this
continuous-acquisition implementation. The earlier implementation PDF describes
the sleep policy; use this document for the current acquisition behavior.

## Live continuous-mode verification

The October 4 capture recorded a warm PPG1-to-PPG4 handoff with consecutive
packets #91/#92, 974 ms between packet start times, 7.73 s of preserved backup
history and no sensor faults. See the [bench report](../../../docs/bench/CONTINUOUS_PPG_HANDOFF_2026-10-04.md)
for the evidence and remaining accuracy limitations.

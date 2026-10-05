# Continuous four-PPG acquisition and bench dashboard

The confirmed hardware is ESP32 GPIO21/SDA and GPIO22/SCL -> one TCA9548A
at 0x70 -> four MAX30102s at 0x57 on separate MUX channels 0–3. The photos
and schematic show one MUX; the small black power converter is not another.

This implementation replaces the earlier sequential sleep/probe design.
All four sensors stay awake and collect at nominal 100 raw samples/second.
The MUX exposes only one I2C channel at a time, but disconnecting a channel
leaves its sensor sampling into its own FIFO. The firmware drains all four
FIFOs frequently and maintains independent waveform and timing history.

## One outgoing stream, warm backups

Each sensor has its own contact state, 200 grouped-sample history (roughly eight
seconds), and measured sample-clock time basis. Four raw pairs are averaged
into one estimator sample. A first estimate needs 100 grouped samples (roughly
four seconds), and two accepted 250 ms updates qualify the source. These updates
overlap; they are not independent validations. Signal processing uses Luis's
unchanged `ppg_vitals.h` estimator and existing SpO2 table. The provisional IR
contact threshold remains 100000.

At every complete outgoing packet boundary, the first usable sensor in order
PPG1/CH0, PPG2/CH1, PPG3/CH2, PPG4/CH3 wins. If two fingers provide usable
signals, the lower-numbered channel has priority. All other sources keep their
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

## Dashboard and terminal commands

`mux_diagnostic.ino` now builds the **actual transmitter** with
`PPG_BENCH_TELEMETRY=1`. It includes the production source rather than maintaining
a different acquisition implementation. BLE remains enabled and carries only
one source. USB JSON telemetry provides all four sensors' status to the
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

Unlike the old sleep policy, all four rows contain recent observations. Age
identifies the time since the host received that row. The selected-source banner
comes from a dedicated `selected_channel` field, so a background sensor's update
cannot replace the displayed selection. The output line shows packet sequence,
source, validity and BLE connection state. `READY` and `TRACKING` rows can show
local estimates; this does not create four BLE streams.

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
3. Confirm the lower-numbered ready source is selected.
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

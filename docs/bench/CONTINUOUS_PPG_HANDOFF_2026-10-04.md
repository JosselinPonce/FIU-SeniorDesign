# Continuous PPG acquisition: bench verification

Date: October 4, 2026 (America/New_York). Branch: `samantha/multi-ppg`.
Source capture: `/tmp/team18-continuous-ppg.jsonl`.

The firmware and dashboard were changed from sleeping sequential probes to four
continuously sampling MAX30102s behind one TCA9548A at 0x70, channels 0–3.
Only one sensor supplies each unchanged protocol-v3 outgoing packet. A ready
backup retains its own waveform and measured timing history across a switch.

## Observed acquisition and handoff

At review, the capture contained 164 output-frame events with consecutive
sequence numbers and zero sensor-fault events. Packet start-time intervals
were 938–1027 ms, with a 1002 ms median. These are ESP32 packet-build timestamps,
not measurements of receiver arrival or guaranteed deadlines.

All four raw counters continued advancing, with observed rates approximately
99.74, 104.57, 103.48 and 103.50 samples/second for PPG1–4. Sensors without
contact were still acquiring. Nominal packet rate remains 100 samples/second;
heart-rate estimation uses measured per-channel timing.

A recorded contact-loss handoff:

| Packet | Sensor | ESP32 start time | Validity |
| --- | --- | --- | --- |
| 91 | PPG1, CH0 | 91362 ms | Invalid; packet straddled contact loss |
| 92 | PPG4, CH3 | 92336 ms | Accepted by estimator |

The interval was 974 ms. PPG4 was already `READY` with approximately 7.73 s of
history, then became `TRACKING`. It did not clear/rebuild its estimator window.
The invalid packet preserves the existing invalid-value behavior rather than
claiming valid measurements through contact removal.

Another switch from PPG3/CH2 (packet 67) to PPG1/CH0 (packet 68) occurred as the
lower-numbered channel became eligible. Both packets had accepted estimates,
and their start times were 967 ms apart. This exercises channel priority.

BLE connection state was true in these frame events. That shows a BLE central
was connected; it does not identify the central or prove Pi/phone/database
receipt. The on-wire UUIDs, 472-byte packet layout, encoding and CRC are unchanged.

## Remaining accuracy limits

This capture validates acquisition and handoff behavior, not physiological
accuracy. Some accepted estimates changed from about 32 to 62 BPM within one
second. An estimator quality pass is therefore not sufficient evidence of
correct pulse rate. A simultaneous reference-device comparison and waveform
analysis remain necessary. No numeric offset was applied to force agreement.

## Software checks

Both normal and dashboard-enabled ESP32 builds compiled. The host suite had
34 passing tests, including the actual shared acquisition engine on independent
synthetic signals: two-contact channel priority, warm failover, retained backup
history, packet-source isolation, CRC, simulated packet cadence, faults/staleness
and invalid no-contact output. Dashboard tests confirm that background updates
do not replace the selected outgoing source.

These results cover the recorded test and simulated cases, not every possible
motion, wiring, radio or power failure. An absent usable backup cannot provide
valid data, and unreadable hardware can still cause a real acquisition gap.

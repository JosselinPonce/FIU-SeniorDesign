# Four PPGs, one existing data stream

## Relationship to Luis's system

Compared on 2026-10-03 after fetching origin: `origin/LuisFullSystem`
(`f2c6b3c`) is the parent of Samantha's `e01b611`. Samantha changed only
`ppg_transmitter/ppg_transmitter.ino`. The Pi relay, phone, website,
protocol encoder/decoders, and vitals estimator are inherited from Luis.
The supplied Team18_System_Guide.pdf documents Luis's single-sensor version;
its MUX-free wiring and four-second warm-up predate this extension.

## Wiring and selection

ESP32 SDA GPIO21 / SCL GPIO22 -> TCA9548A at 0x70 -> MAX30102 modules
at 0x57 on channels 0, 1, 2, 3. Modules share a suitable power supply and
common ground. Follow the voltage requirements of the actual breakout
modules; the MUX switches I2C paths, **not power**. Sensor shutdown stops
sampling/LED activity while its power rails remain connected.

The firmware configures all four modules, verifying each shuts down before
configuring the next. All four must initialize. It probes sequentially,
starting with PPG1. A probe waits 100 ms for settling, then collects 20 fresh
samples, requiring at least 16 above the existing IR threshold of 100,000.
The first passing sensor stays active; all others stay asleep. A DC threshold
indicates optical contact, not proof of a pulse; the existing estimator still
requires periodicity before marking vitals valid.

After 50 consecutive below-threshold samples (500 ms), discard the partial
frame and history, then search starting after the previous active sensor.
A shorter contact interruption resets estimator history as well. Failed
shutdown verification stops the search rather than waking another sensor.
No contact means all sensors sleep between scans (250 ms retry pause).
No frames are fabricated while searching; the Pi can therefore show stale/
missing data during those gaps. This is also how Samantha's branch behaved.
FIFO timeouts discard partial frames; detected overflows discard the frame
and rebuild history. A physically stuck bus may still require hardware reset.

## Vitals and compatibility

Two one-second warm-up frames precede the first estimate attempt at three
seconds of uninterrupted contact. History then grows to eight seconds.
Luis's estimator and calibration remain unchanged. A result is not guaranteed
at three seconds: noise, motion, flat signals, or poor contact may still fail
its quality checks. Two seconds cannot cover the estimator's configured lag
range. Synthetic tests check the shorter window; this is not hardware or
clinical accuracy validation.

Exactly one source feeds each packet: 100 paired red/IR samples at 100 Hz,
472-byte protocol v3 frames, original flags, CRC, UUIDs, BLE chunking and
monotonic sequence numbers. No sensor ID is added to the packet. Pi and app
code are unchanged. `-999` still means no valid result, not a measured value.
Serial additionally shows `PPG1`–`PPG4` and `WARMUP`, `CONTACT_UNSTABLE`,
`LOW_QUALITY`, or `TRACKING`. The `maxim=` field is a diagnostic comparison,
not the transmitted estimator. `link=down` means the Pi is not connected.

## Fedora terminal workflow

The optional `.vscode/tasks.json` trial shortcuts have been removed. The
flash script is unchanged from Luis's version. Once flashed, the ESP32 starts
automatically when powered; terminal commands are only for updates and
diagnostics.

Installed for this workstation: `~/.local/bin/arduino-cli` 1.5.1,
ESP32 core 3.3.12, SparkFun MAX3010x library 1.1.2.
Use the existing 40 MHz DIO board settings from Luis's upload script.

If serial access is denied, in your own terminal run:

```bash
sudo setfacl -m u:$(id -un):rw /dev/ttyUSB0
```

This temporary permission lasts until unplugging. Close serial monitors
before uploading. Use Luis's existing script and Arduino CLI from the
repository root in any terminal:

```bash
bash system/esp32/flash_esp32.sh /dev/ttyUSB0
~/.local/bin/arduino-cli monitor -p /dev/ttyUSB0 -c baudrate=115200
```

Bench check: place a finger on each sensor in turn, keep it still for at
least ten seconds, then remove it and move to another sensor. Confirm that
only the selected channel streams, `ovf=0`, `win` is about 1000 ms, and the
Pi receives the same packet format. With contact on two sensors, selection
should stay on the first one until contact is lost. The fixed optical
threshold must be checked against the actual four modules and mounting.

## Verification on 2026-10-03

- All 21 host tests pass, including the real sketch compiled with a simulated
  I2C bus: first-contact lock, idle channels, failover, isolated frame samples,
  brief contact interruption, FIFO overflow/timeout, MUX failure and failed
  shutdown verification. This simulation does not validate electrical timing.
- ESP32 Arduino compile succeeds: 1,128,467 bytes flash / 49,164 bytes RAM.
- Uploaded to the connected ESP32-D0WD-V3 via CP210x at `/dev/ttyUSB0`;
  esptool verified the written flash hashes.
- Live serial confirmed all four channels responding, with open-air IR about
  900–1,150 and no false contact. Finger vitals, physical failover, and the
  live Pi/phone connection still require the interactive bench test.
- During this session the serial log is `/tmp/team18-esp32-serial.log`.
  While capture runs, use `tail -f /tmp/team18-esp32-serial.log`
  in another terminal. Do not open
  a second serial monitor on the same port.

### First interactive finger test

Observed selection PPG4 -> PPG2 -> PPG1 -> no contact, with continuous
frame numbering (0–83) and fresh warm-up on every switch. All 84 completed
frames reported zero FIFO overflows; all reported BLE `link=down`, so this
run did not validate delivery to the Pi or phone.

| Sensor | Frames | Warm-up | Low quality | Tracking | Unstable contact |
|---|---:|---:|---:|---:|---:|
| PPG4 | 60 | 2 | 46 | 12 | 0 |
| PPG2 | 20 | 2 | 15 | 3 | 0 |
| PPG1 | 4 | 2 | 1 | 0 | 1 |

The three-second attempt did not produce valid vitals on any of these
contacts. PPG4 had a consecutive run of estimates around 64–67 BPM, but
also 33–36 BPM estimates; PPG2 produced 31, 73, and 34 BPM. These are firmware
outputs, not validated physiological measurements. The MUX selection worked;
consistent vitals did not. The summary serial log cannot establish whether
poor waveform quality, motion/contact, or estimator behavior caused the
rejections. Capture paired raw red/IR waveforms before tuning the estimator
or loosening validity thresholds. Frame acquisition times also differed by
module (roughly 941–965 ms on PPG2/4 versus 990–1003 ms on PPG1); verify
actual sample timing as part of that investigation.

### Waveform diagnosis and steady-contact retest

A subsequent diagnostic build mirrored each complete packet to USB serial
(`PPG_SERIAL_RAW=1`), preserving the BLE format. The packet CRC was checked
with Luis's Python decoder. Replaying the paired samples through the actual
unchanged C++ estimator reproduced its results. No ADC clipping was observed
in the captured PPG4 windows.

The first contact segment (frames 0–19) yielded no valid estimates. A later
PPG4 placement (frames 32–72) yielded two warm-up frames followed by **38
consecutive valid frames, 78–83 BPM**, then an invalid frame during removal.
Thus persistent invalid readings were not an inevitable MUX or startup
failure. The rejected recording had irregular waveform/baseline variation;
the later recording had a much more regular pulse. Placement, pressure and
motion are likely contributors, but the log cannot separate them. This
retention of the same estimator is deliberate: lowering its threshold is
not supported by this experiment. SpO2 output was 100 during the clean run;
no external reference was used to establish measurement accuracy.

The final normal build disables raw serial output and displays unavailable
values as `--` on USB serial only, with `reason=COLLECTING_SAMPLES`, `CONTACT_INTERRUPTED`,
`NO_ACCEPTED_PULSE`, or `SPO2_RATIO_REJECTED`. Valid output has `reason=OK`.
`peak` reports the largest autocorrelation across candidate lags, including
rejected windows; it is diagnostic and is not the packet's quality field.
An accepted pulse still needs a qualifying local peak and an in-range rate.
The wire protocol retains its original -999 sentinel and validity flags.
The added reason text is only diagnostic; invalid-value handling is unchanged.

For repeatable measurements, support the hand, center the finger pad over
the optical window, and keep light, consistent contact. Test each mounted
sensor in the actual wheel; this stationary bench result does not establish
reliability during steering. BLE remained disconnected during the capture.

To repeat waveform collection, close the serial monitor, compile with
`--build-property compiler.cpp.extra_flags=-DPPG_SERIAL_RAW=1`, upload that
build, and save its serial output. Decode it using:

```bash
python3 system/esp32/decode_serial_capture.py capture.log > samples.csv
```

The session capture and analysis remain local in `/tmp/team18-raw-capture.log`,
`/tmp/team18-raw-samples.csv`, and `/tmp/team18-contact-comparison.png`.
Recompile normally to disable the extra serial traffic. Diagnostic serial
printing changes the time spent in the acquisition loop, so use packet
start-to-start timing as well as `win` when investigating clock rates.

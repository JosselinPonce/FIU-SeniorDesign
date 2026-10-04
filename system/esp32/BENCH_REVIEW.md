# Review of the latest completed bench run

148 complete frames, sequence 0–147, reviewed from the local USB serial log.
These are estimator outputs, not reference measurements. Raw waveforms were
not enabled in this run. Every recorded frame reported `ovf=0` and
`link=down`; this rules out reported FIFO overflow, not all acquisition
errors, and does not verify Pi/phone delivery.

| Contact period | Frames | Accepted BPM range | Findings |
|---|---|---|---|
| PPG4, first placement | 0–43 | 70–79 | 41 accepted frames; no adjacent accepted-frame jump >=10 BPM |
| PPG2, first placement | 44–64 | 30 | Only 1 accepted frame; 18 low-quality frames, 2 warm-up |
| PPG2, next placement | 65–97 | 41–74 | 27 accepted frames; contact interruption, then five accepted 41 BPM / 88% SpO2 frames |
| PPG2, brief placement | 98 | none | Contact interrupted |
| PPG1 | 99–124 | 40–77 | 40 BPM at frame 104 -> 77 at frame 105, both accepted |
| PPG4, later placement | 125–146 | 72–78 | 19 accepted frames; no adjacent accepted-frame jump >=10 BPM |
| PPG3 | 147 | none | Only one warm-up frame; insufficient evidence |

The 10 BPM threshold above is a descriptive review filter, not a medical
limit or an acceptance criterion. Slow variation need not be an error.
PPG1's near doubling is consistent with an estimator choosing a two-beat
period before selecting the one-beat period, but without this run's raw
waveform and a synchronized reference that mechanism is unconfirmed.
The earlier clean PPG4 capture did not establish robustness across modules,
placements, or steering movements. `TRACKING`/`reason=OK` means the existing
algorithm accepted its result; it is not proof of accuracy.

`bpm=` and `spo2=` are the transmitted estimates. `maxim=` is Luis's retained
comparison algorithm, printed only to USB; its larger swings must not be
confused with the transmitted values. The MUX continues to select one source.
No firmware, Pi, or mobile changes were made for this review.

## Next comparison

Use an independent reference simultaneously. For BPM, ECG or a suitable
chest strap is preferable; a medical-purpose finger oximeter provides a
practical pulse-rate comparison and SpO2 agreement check. A manual wrist
pulse count over 60 seconds provides a coarse BPM check, not per-second
accuracy or any SpO2 reference. A stable number alone is not evidence of
accuracy. Finger-oximeter agreement does not establish clinical SpO2
accuracy across its full range.

Proposed engineering bench procedure (not a clinical validation standard):

1. Sit quietly with warm, supported hands. Use light, consistent contact.
2. Record 60–120 seconds for each PPG separately, with the reference reading
   at matching times (a video of both displays can help). Retain startup,
   missing readings and interruptions rather than discarding them silently.
3. Repeat each placement three times. First assess stationary operation;
   test controlled hand motion separately once stationary results are sound.
4. Compare BPM bias, mean absolute error, largest errors, and the fraction of
   attempted measurements that are valid. Report each module separately.
   For SpO2 report differences in percentage points, not relative percent.
5. Account for the reference device's own averaging/display delay. Our
   estimate uses 3–8 seconds of history, so abrupt changes are not instantaneous.

A provisional project target could be at least 95% of time-matched accepted
BPM estimates within ±5 BPM of the reference and at least 90% valid coverage
in a stationary test, evaluated after a predeclared warm-up. Report startup
separately. These are proposed team targets, not claims that this device
meets them or medical standards. No accuracy metrics can be calculated for
this completed run because there was no synchronized reference.

Sources:
- American Heart Association, manual pulse counting:
  https://www.heart.org/en/health-topics/high-blood-pressure/the-facts-about-high-blood-pressure/all-about-heart-rate-pulse
- FDA, pulse oximeter technique and limitations:
  https://www.fda.gov/consumers/consumer-updates/pulse-oximeters-and-oxygen-concentrators-what-know-about-home-oxygen-therapy

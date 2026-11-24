# Ask Sensi educational knowledge

The Edge Function selects up to three concise reference cards for the current question. For a vague follow-up it can use the most recent relevant user question from the already validated conversation history. Only the selected static notes enter the system instructions. Driver questions, prior dialogue and any explicitly shared session summary remain untrusted request data. The PDF is a development reference and is never sent to the provider. General education works without session data. For personal analytics the only source is the summary authorized for the current request.

## Technical provenance

- *Team 18 Biometric Steering Wheel System Guide*, September 21, 2026, pp. 4–11 and 19–27, provides historical system, signal-processing, relay and safety context. Its references on pp. 37–39 provide background on PPG and alarm confirmation. See also the repository's [system guide](../../docs/SYSTEM_GUIDE.md). The September guide describes an earlier single-sensor build.
- The current six-position prototype is represented by firmware revision `b93eee7` on `Josselin-Testing-101`, specifically `system/esp32/README.md`, `ppg_transmitter/ppg_transmitter.ino` and `ppg_transmitter/ppg_multi.h`. Six MAX30102 sensors connect through an I²C multiplexer. Acquisition and qualification are per source. Each BLE packet uses one selected source, with handoff to a qualified backup when needed. The Ask Sensi checkout retains older single-sensor firmware. The multi-source revision verifies the design, while contact and signal quality determine whether a position supplies usable data.
- In the app, see `lib/ble/protocol.ts` for packet validity, `lib/analysis/safetyController.ts` and `flagEngine.ts` for quality gating and confirmed local warnings, `lib/voice/voiceCheck.ts` for the local wellness flow, and `lib/db/repositories.ts` for session storage. The ESP32 acquires the red and infrared PPG samples and estimates vitals. The Raspberry Pi relays BLE frames verbatim. The phone evaluates configured thresholds and owns the deterministic offline Safety Sensi workflow. Direct ESP32 bench mode can bypass the Pi. Diagnostic and session summaries can contain gaps.

## Educational references

- The American Heart Association describes typical adult resting heart rate and factors that affect it. [All About Heart Rate](https://www.heart.org/en/health-topics/high-blood-pressure/the-facts-about-high-blood-pressure/all-about-heart-rate-pulse)
- The FDA describes typical SpO₂ values and limitations of optical readings. [Pulse Oximeter Basics](https://www.fda.gov/consumers/consumer-updates/pulse-oximeters-and-oxygen-concentrators-what-know-about-home-oxygen-therapy)
- Momentary Lab provides background on how to read SpO₂ estimates. [Pulse Oximeter Readings Chart](https://momentarylab.com/blog/healthcare-devices/pulse-oximeter-readings-chart)

These population ranges are educational. Update the cards when verified architecture or safety behavior changes. Keep explanations free of diagnoses, fitness-to-drive claims and inferred values for missing data.

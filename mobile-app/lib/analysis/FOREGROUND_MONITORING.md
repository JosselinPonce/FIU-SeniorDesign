# Foreground safety monitoring

Safety monitoring and recording have separate owners. The app supplies
`setMonitoringContext(connected, foreground, supportedScreen)` and optional
`setRecordingSession(id | null)` to SafetyController. The controller generation
revokes an interrupted monitoring lifecycle; episode IDs and capture IDs scope
answers. Start/End Drive change recording and upload ownership without restarting
an active VoiceCheck. The older combined startSession/endSession controller APIs
remain for existing consumers; the app uses endSession only for full teardown.

Monitoring waits for a configured driver and accepted live readings. It operates
on Dashboard, History, Settings, and vitals details. Onboarding, profile editing,
and development diagnostics suspend monitoring; profile editing cannot start
while a check is active. Returning requires new live confirmation, not replay of
an old question. Voice permission preparation occurs at driver selection; typed
and button responses remain available if voice access is denied.

Pi CRC validation, the mobile deframer/CRC checks, sequence tracking, calibration,
and signal-quality filtering remain unchanged. SensorContinuity guards only the
safety consumer: duplicate sequence numbers cannot advance confirmation. Missing,
backwards, burst (<500 ms), receiver-gap (>=3 s), and device-uptime discontinuities
discard the affected frame and reset evidence. A 500 ms watchdog invalidates an
incident when no unique frame has arrived for 3 s. Thresholds, accepted-coverage
ratios and normal confirmation counts are unchanged; resets retain cooldowns.
Device counters wrap using unsigned arithmetic. Sensor uptime is relative: this
cannot prove the absolute age of a stream delayed consistently before reception.
No communication protocol, ESP32 firmware or Pi behavior was changed.

Backgrounding, disconnecting, freshness expiry and unsupported screens revoke
active capture and consent. Foreground restoration does not resume an old check.
Immediate foreground/screen checks also gate episode publication and the platform
phone handoff. No background BLE, microphone, notification or locked-phone support
is enabled or promised. Foreground-only monitoring must be verified on devices.

An event captures its optional recording ID when VoiceCheck starts. Completion
remains associated with that original recording even if recording ends during
the check; late completion uses the existing final-upload path again. An event
activated without a recording is transient (not persisted or
uploaded), including its result and consent; starting a trip later does not
retroactively attach it. No recording identifier is fabricated. Contact consent
uses the existing deterministic final-recognition/typed/button proofs and captured
profile contact, with foreground monitoring required at handoff. Settings
rehearsals and vitals demos continue to simulate dialing only.

The dashboard and Sensi standby distinguish disconnected, waiting for valid
readings, active monitoring and temporarily unavailable monitoring. Recording is
shown separately. Gemma acknowledgment selection, fallback copy, TTS and the
VoiceCheck safety sequence are unchanged. No native configuration or dependencies
changed; the existing development build can load this JavaScript via Metro.

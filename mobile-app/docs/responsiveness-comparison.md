# Developer responsiveness comparison — Phase 1

Instrumentation only. Neither conversation engine, consent parser, recognition
requirements, voice preference, thresholds nor SafetyController is changed.

## Capture

Use an existing compatible iPhone development build and updated JavaScript. No
native source changed for this instrumentation; no rebuild is required solely
for it. Older binaries must already contain the current offline recognizer and
local playback module.

1. Park; do not start a drive. Select the same installed Zoe Premium voice in
   Settings for both tests. Keep speaker/Bluetooth route and volume unchanged.
2. Settings → Safety checks → Developer responsiveness comparison → Start timing
   capture. It is off by default. Starting/resetting clears the previous capture.
3. Run **Demo — trigger a warning**, using the same scenario each time. Answer
   after the prompt finishes. Start with “Yes, I'm okay”, then repeat with “No,
   I'm feeling dizzy” and decline any contact offer. Demo mode does not dial.
   Do not use the separate dialer-capable rehearsal for this comparison.
4. Refresh timing snapshot. Return home → Driver Assistant → Developer diagnostics.
   Run the same utterances, waiting for Listening; decline offers. Also try a
   neutral open-ended response to exercise model generation: concerning symptoms
   and direct requests may intentionally bypass Foundation Models.
5. Refresh the assistant timing snapshot. Both lanes remain in the same RAM
   timeline. Repeat three times; compare first/cold and later/warm runs separately.
6. Test Stop once during playback and once during listening; refresh afterward.
   Stop timing capture clears records; app restart also loses them. Clear between
   comparison batches. Nothing is written, uploaded or printed by this recorder.

Repeat with Airplane Mode and Wi-Fi/cellular disabled, using locally cached JS
or a development bundle already running on the phone. This instrumentation does
not prove offline operation. The assistant still requires exact en-US on-device
recognition; the legacy warning path's existing capability/fallback policy is
unchanged. Do not infer a shared offline guarantee from a successful demo.

## Reading the timeline

Absolute time within a capture = `record.startedMs + event.elapsedMs`. Subtract
absolute timestamps across records for transitions. All JS timestamps use the
same monotonic clock; native durations use their own monotonic clock and must
not be treated as absolute JS timestamps.

| Measurement | Warning lane | Assistant lane |
| --- | --- | --- |
| Playback | start/completed/stopped/error callbacks | native completion result and elapsed time, returned after cleanup |
| Microphone startup | native `audiostart` delivered to JS | first native listening progress, emitted after audio-engine start; native elapsed time included |
| Recognition | first partial, final callback, window timeout, error, resolution | first text progress, finalizing progress, returned finality/status, native listening/finalizing/first-partial durations |
| Reply generation | no model; recognition resolution → next playback request includes deterministic orchestration | generation promise and native processing duration when model is invoked |
| Audio transitions | playback session setup return, microphone start, release after idle | playback cleanup return, microphone progress, ownership release, cancel completion |

The native assistant playback API has no playback-start event exposed here.
Its result is not equivalent to the warning's `onDone`: cleanup and bridge
delivery occur before the promise returns. The assistant also does not expose
an exact final-result callback timestamp to JS; its returned native finalization
duration is the best existing measure. Warning listeners are removed on normal
resolution/abort, so a missing audio-end event does not prove capture stayed on.
Microphone-start events do not prove first usable sample arrival, acoustic
silence, or perceived speech onset. Those require device observation or a
separately approved native instrumentation phase.

Known configuration, not measured latency: warning listen window 6 seconds;
assistant overall capture budget 15 seconds with approximately 1.3-second
silence endpoint and bounded 2.5-second finalization grace. These are unchanged.
Both iOS playback paths configure default utterance rate × 0.95. Actual voice
identifiers are recorded, without contact or transcript data.

Capture is bounded to 80 operations and 24 first-occurrence events each. Refresh
is manual to avoid React subscriber work in audio callbacks. Any phone warning
check while enabled uses the warning lane; this recorder does not distinguish
live/demo/rehearsal internally. Keep comparison testing outside active drives.
Existing assistant developer transcript diagnostics are separate and unchanged.

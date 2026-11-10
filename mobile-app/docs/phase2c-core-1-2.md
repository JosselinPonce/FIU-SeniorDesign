# Capture core-1-2 — evidence boundary

## Available evidence

The supplied observations are: Listening at 39670 ms; finalizing at 45669 ms; response_unavailable at 45776 ms; wellness interpreted as silent with hasText=false at 51791 ms. No matching physical-device JSON was found in the project's documentation or local diagnostic JSON/log files searched. Local automated-test logs are not device evidence. The event details distinguishing controller publication from React commit were not supplied, so these timestamps cannot independently verify both stages.

Assuming these are recorder-relative timestamps for the same capture, Listening → finalizing spans 5999 ms; finalizing → unavailable spans 107 ms; unavailable → silent interpretation spans 6015 ms.

The first confirmed visible change is entry into response_unavailable, not a proven loss of previously usable final evidence. The first confirmed downstream absence is hasText=false at interpretation. Neither a partial nor the Listening/finalizing phases establish usable final evidence. The exact first rejection/loss boundary remains unproven without native and adapter events.

## Source correlation

- Native `OfflineSpeechDiagnostic` publishes Listening during active capture and finalizing during endpointing or termination. These phases are not recognition result statuses. Its six-second active capture budget can initiate finalization, but a 5999 ms UI interval alone does not establish the native endpoint reason.
- `speechIO.listen` logs native status/reason and final/transcript-presence fields, then checks exact locale/on-device metadata and cancellation epoch. It records adapter outcome separately. Its inner catch returns error/native_adapter_failed with a fixed stage; ownership rejection happens outside that catch.
- `VoiceCheck.ask` requests unavailable only for a current listen rejection or returned error/incomplete evidence. The controller publishes response_unavailable only while the interaction remains current. Native cancelled or stale evidence does not directly request this status; a later error can.
- Error/incomplete processing preserves a 6000 ms manual-input window. After that window, unsuccessful final evidence yields null text. Deterministic `understand(null)` yields silent. The observed 6015 ms gap is consistent with this path and scheduling overhead, not evidence of another six-second native capture or a speech-permission failure. A listen rejection has a similar manual-window path.
- An ordinary valid successful final is interpreted without the unavailable branch. A logged native success can still be mapped to adapter error if locale/on-device metadata mismatches, or if adapter processing throws. Missing final flags, mismatched transcripts, or cancellation can make evidence unusable, but do not by themselves select unavailable unless an error branch is taken.
- UI publication and React commit observations must match this exact capture, question and order. An earlier successful capture does not establish success for core-1-2, and a later capture's UI does not retroactively invalidate an earlier success.

Thus the sequence supports an unavailable/manual-window/no-usable-text flow. It does not distinguish incomplete empty final, adapter error, ownership rejection, or another error. It does not identify Bluetooth, permissions, the finalization timer, or sequential fallback as the cause. A 107 ms UI interval is not a measurement of the native finalization grace period; use native milestones and reason instead.

## Exact missing records

Retrieve these events for core-1-2:

1. `recognition`: `native recognition completed` with status, reason, hasTranscript, hasFinalText, isFinal, finalResultReceived, localeMatches, onDeviceRequired, and available timings/revision; `native monotonic milestones` with nativeTimingMs.
2. `recognition`: `adapter outcome` with status, usable, current, cancelled, transcriptsMatch, and fixed exception stage/reason if present. Also retain `adapter acquisition rejected`, `adapter cancelled before capture`, or `adapter missing native result` if present. Absence of the native return is legitimate if capture never returned through that branch; it is not automatically record loss.
3. `VoiceCheck controller capture`: `capture registered` and `capture settled`, including current, captureMatches, cancelled.
4. `VoiceCheck decision`: `question opened`, `listen rejected` if any, `result received`, `unavailable requested` if any, `answer selected`, and `question closed`. In particular, verify returned status/usability and channel none versus voice/manual. The supplied silent interpretation strongly suggests no usable text but does not replace the missing channel record.
5. `VoiceCheck UI publication / state published` and `VoiceCheck UI commit / state committed`, including question, phase, source and fallbackText. Include the interpretation event and the next question-open event if needed to distinguish retries, exporting that next capture separately.

If native incomplete/empty_final_after_partial → adapter incomplete → unavailable request all match, the first unusable final is confirmed at the native callback. If native success with valid presence/final flags → adapter error, the boundary is the adapter; contract booleans/stage distinguish the next check. If native success → usable adapter → VoiceCheck current/ID rejection, inspect ownership before changing it. Without this chain there is no evidence-supported production correction.

## Filter an existing snapshot safely

Copy the complete selectable timing JSON from Advanced Settings before stopping capture (Stop clears it). Save it locally as `snapshot.json`. Run the following against that JSON, not a screen transcript. It emits only capture-scoped metadata; it does not upload data or change the app. The snapshot must be the JSON array shown by the existing panel.

```sh
python3 - snapshot.json core-1-2 <<'PY'
import json, sys
records = json.load(open(sys.argv[1]))
target = sys.argv[2]
allowed = set('captureId question phase source channel outcome stage current captureMatches usable hasTranscript hasFinalText transcriptsMatch localeMatches cancelled settled fallbackText isFinal finalResultReceived hasFinalTranscript hasText onDeviceRequired reason status nativeRevision nativeTimingMs nativeMs listeningMs preparationMs finalizingMs endpointReason englishFinalization'.split())
rows = []
for record in records:
    for event in record.get('events', []):
        details = event.get('details', {})
        if details.get('captureId') != target:
            continue
        rows.append({
            'recordId': record['id'], 'operation': record['operation'],
            'point': event['point'],
            'atMs': record['startedMs'] + event['elapsedMs'],
            'details': {k: v for k, v in details.items() if k in allowed},
        })
rows.sort(key=lambda r: (r['atMs'], r['recordId']))
required = ['native recognition completed', 'adapter outcome', 'result received',
            'answer selected', 'question closed', 'state committed']
print(json.dumps({'captureId': target, 'events': rows,
    'missingPoints': [p for p in required if not any(r['point'] == p for r in rows)],
    'snapshotRecordCount': len(records),
    'snapshotFirstRecordId': records[0]['id'] if records else None,
    'matchingPublicationCount': sum(r['operation'] == 'VoiceCheck UI publication' for r in rows),
}, indent=2))
PY
```

For cross-operation timestamps use startedMs + elapsedMs, as above. Raw elapsedMs values have different operation origins. Do not compare them directly. Native milestones have their own native timing basis; inspect their relative ordering/differences separately. This filter cannot recover records already evicted or cleared. MissingPoints means absent from this snapshot, not proof that the event did not happen.

For a new capture: Debug build → Advanced Settings → keep aligned session OFF → clear/start timing capture → exactly one English rehearsal → finish/cancel safely → refresh and copy immediately. Use the actual new capture ID, which may no longer be core-1-2. Do not restart or stop the recorder before saving. Pair the unavailable screenshot with question/capture metadata, without sharing personal statements/profile data.

## Separate finding: repeated phase publications and diagnostic retention

The native activity timer calls checkEndpoint every 0.1 seconds. When no endpoint is selected, it publishes progress. Recognition callbacks can also publish progress. The JS adapter forwards progress phase; the safety controller republishes a new check state and calls onChange even if the phase is unchanged. The periodic native work also checks endpoint/readiness; it must not simply be removed. The unchanged Listening label does not require repeated identical state publications, but suppressing production publications would be a separate behavior/performance change requiring subscriber review.

New Debug UI-publication instrumentation opens one recorder operation for every such publication. The recorder retains 80 operations and discards later callbacks to evicted operations. A long-running recognition/decision operation can therefore be evicted before its native result/decision is logged. A synthetic execution of the actual recorder confirmed this: open recognition, add 80 publication records, then emit completion; the recognition record and completion are absent. This is a concrete diagnostic retention limitation, not proof it happened to core-1-2. Six seconds of 100 ms publications alone is about 60 records; other events and phases determine whether the limit was exceeded. React UI commit instrumentation depends on phase/ID changes and does not necessarily run every 100 ms.

The smallest evidence-supported proposed correction is to deduplicate **Debug publication recording only** by capture/question/phase/fallback presence, while preserving all native timer/progress and production state behavior. Alternatively, a separate bounded capture-event recorder could preserve in-flight records, but is a larger change. Increasing the global limit merely postpones eviction. No correction was applied in this inspection. If the required data was evicted, extraction cannot repair this snapshot: deduplicate the Debug recording before another capture, or inspect the existing adapter/native return using the debugger without dumping text. Do not infer a recognition cause from missing diagnostics.

## Scope and checks

Only this report was added. No production or diagnostic source, recognition, audio, timing, safety, consent, Gemma, or emergency code changed; no commits or pushes. Existing uncommitted work was preserved. Recorder eviction was reproduced synthetically, not on the iPhone. Relevant recorder/VoiceCheck/adapter tests: **63 passed, 0 failed**. `git diff --check` passed. Physical record correlation still requires the missing snapshot events listed above.

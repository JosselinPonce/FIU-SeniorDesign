# Phase 2C — Debug publication deduplication

Implemented the diagnostic-only correction proposed in `phase2c-core-1-2.md`. This fixes an avoidable diagnostic-retention problem, not the physical English recognition failure.

## Exact changes

- `lib/voice/responsivenessDiagnostics.ts`: added a publication-specific recorder method and Debug-gated helper. Only consecutive publications with identical capture ID, question, phase, and fallback-copy presence are suppressed. The cache retains one metadata tuple, resets on clear/start/stop, ignores disabled input, and copies only those four diagnostic fields. Other operations and their event callbacks are unchanged. The existing 80-record/24-event bounds remain.
- `lib/analysis/safetyController.ts`: routed the existing publication observation through that helper. Every production state assignment and `onChange` call still executes exactly as before; no native progress, UI publication, timer, recognition, ownership, interpretation, consent or call decision is suppressed.
- `tests/responsivenessDiagnostics.test.ts`: added four regressions covering delayed completion after 1,000 repeated Listening publications and 1,000 repeated unavailable publications; preservation of native/adapter/decision/controller/UI events; capture/question/phase/fallback transitions and return transitions; cache reset/opt-in; Release no-op and transcript/profile exclusion.
- This report.

The delayed-completion regression uses the actual recorder with a controlled clock and a deferred promise. It does not simulate real Apple recognition accuracy or device latency. It verifies that duplicate UI publications do not consume the buffer or evict the unfinished capture chain. Meaningful transitions and unrelated operations can still eventually fill the bounded buffer: this is not indefinite retention, and a prompt single-capture export remains necessary.

## Privacy and Release

The helper checks `__DEV__` before calling the recorder. Release performs no publication deduplication/cache update/recording through the helper. Debug additionally requires explicit timing-capture opt-in. Storage is bounded process RAM only, cleared by the existing stop/reset controls; no transcript, profile, audio, file write, upload, or new permission is involved. The deduplication key uses fallback **presence**, not fallback text. Diagnostic UI remains Debug-only. Shared source utilities may be present in a Release bundle; their collection functionality is gated off, rather than claiming every utility byte is absent.

## Checks

- Relevant recorder/controller/VoiceCheck/adapter tests: **103 passed, 0 failed**.
- Full automated suite: **643 passed, 0 failed, 0 skipped**.
- `tsc --noEmit`: passed.
- `git diff --check`: passed.
- Production iOS/Hermes Expo export: passed. This is a JavaScript export check, not a signed native build or IPA/device validation.
- No production recognition, audio-session policy, microphone behavior, timing, Gemma, safety decisions, consent or emergency authorization changed. No dependency installation, commits or pushes. Existing uncommitted work preserved.

## Retrieve the complete core capture chain

1. Use the updated JavaScript in a physical-iPhone Debug development build. No new native method is required. Stop recording/monitoring and unrelated audio diagnostics; preserve the previously failing route for the baseline. Keep aligned-session reuse OFF and do not enable duplex experiments.
2. Settings → Advanced Settings → Developer responsiveness comparison → **Start timing capture**, or **Clear timing snapshot** if already enabled.
3. Settings → Health & Safety → **Try the voice check**. Use a synthetic English response after readiness/Listening. Note the active prompt and screenshot any unavailable UI. Finish or cancel using the existing controls; the rehearsal remains simulated.
4. Immediately return to Advanced Settings → **Refresh timing snapshot** and copy the JSON before stopping capture or restarting the app. Export one rehearsal at a time. Stop capture after copying to clear RAM.
5. Filter using the metadata-only extraction procedure in `phase2c-core-1-2.md`, replacing `core-1-2` with the actual new ID. IDs can change across launches/questions. The old evicted data cannot be recovered by this correction.
6. For that exact ID retain native status/reason, presence/final/contract flags, adapter outcome, controller-current/capture flags, VoiceCheck result/unavailable request/answer channel/closure, controller publication and React commit. Compare timestamps using `startedMs + elapsedMs`; do not compare operation-local elapsed values directly. Verify that repeated unchanged Listening publications collapse to one observation while finalizing, unavailable and cleared transitions remain.

Native incomplete → adapter incomplete → unavailable request confirms a native final-evidence failure. Native success → adapter error points to contract/adapter processing. A valid accepted success followed by a different capture's error identifies a later-question failure. Missing records still mean unknown, not a diagnosis. The physical recognition failure is not claimed fixed; its first evidence-supported failing boundary still needs this device capture.

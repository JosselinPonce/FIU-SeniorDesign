# Isolated Gemma development proof of concept

The development diagnostic remains isolated. Phase 2 now reuses this same runtime
for allowlisted acknowledgments in event-triggered VoiceCheck (see
`lib/assistant/SENSI_GEMMA.md`). Diagnostic generated output is still untrusted
display-only text; safety may speak only an exactly validated acknowledgment.

## Runtime and build

- Exact dependency: `llama.rn@0.10.1` (stable release, not a branch or RC).
- Expo SDK 54 / React Native 0.81.5 / Hermes / New Architecture.
- Compatibility evidence: the upstream v0.10 New Architecture requirement and
  Callstack's Expo example using Expo 54.0.33, RN 0.81.5, and llama.rn ^0.10.1:
  https://github.com/callstackincubator/ai/blob/main/apps/expo-example/package.json
- Release: https://github.com/mybigday/llama.rn/releases/tag/v0.10.1
- This evidence permits a PoC; physical device success is not guaranteed.
- Expo configuration records the llama.rn plugin and C++20 settings. Increased
  memory entitlements and experimental Android accelerators are disabled.
- The existing iOS native speech/Apple modules remain installed.
- Reproduce native configuration with `npx expo prebuild --platform ios --no-install`
  or `--platform android`, followed by native dependency installation/build.
  Do not use `--clean` on an existing working tree with native edits.
- Expo Go cannot load the native runtime. No SDK upgrade is required/planned.

## Approved artifact

- Base model: `google/gemma-3-270m-it-qat`.
- Conversion publisher: `ggml-org/gemma-3-270m-it-qat-GGUF`.
- Immutable repository revision: `7dba9faa7cdb58c7dc44b238c7dbb00e391fbf65`.
- File: `gemma-3-270m-it-qat-Q4_0.gguf`.
- Exact size: `241410624` bytes.
- SHA-256: `3626e245220ca4a1c5911eb4010b3ecb7bdbf5bc53c79403c21355354d1e2dc6`.
- Download URL:
  https://huggingface.co/ggml-org/gemma-3-270m-it-qat-GGUF/resolve/7dba9faa7cdb58c7dc44b238c7dbb00e391fbf65/gemma-3-270m-it-qat-Q4_0.gguf

On 2026-10-25, the checksum and size were cross-checked directly against BOTH:

1. Publisher API metadata (LFS sha256/size and repository revision):
   https://huggingface.co/api/models/ggml-org/gemma-3-270m-it-qat-GGUF?blobs=true
2. The immutable Git LFS pointer:
   https://huggingface.co/ggml-org/gemma-3-270m-it-qat-GGUF/raw/7dba9faa7cdb58c7dc44b238c7dbb00e391fbf65/gemma-3-270m-it-qat-Q4_0.gguf

This verifies consistency with publisher metadata; it is not an independently
signed Google attestation of the third-party conversion. No model weights were
downloaded during implementation. On-device provisioning must reproduce this hash
before the artifact is accepted. Never replace the expected hash with the hash
of an arbitrary downloaded file.

## Provision and use

1. On a native development build, end/save any drive.
2. Open Settings → Advanced Settings → Gemma proof of concept.
3. Review https://ai.google.dev/gemma/terms and
   https://ai.google.dev/gemma/prohibited_use_policy before accepting/downloading.
4. Tap **Accept terms and download approved model**. This alone starts a download;
   there is no startup/drive download or personal token. Provisioning is disabled
   during active drives, and interrupted/backgrounded work requests cancellation.
5. Download goes to an app-private `.part` file. Exact size and incremental SHA-256
   are verified before moving to persistent Documents/gemma-poc storage. Transfer
   and SHA-256 progress show bytes, percentage, and stage elapsed time. Partial
   files are discarded after the native writer/verification actually settles;
   retry starts a new download. Allow at least 483 MB free.
6. **Check installed model** verifies the full hash again. **Initialize model** also
   verifies before native loading. Check is optional: after provisioning, go
   directly to Initialize rather than requesting an extra manual verification.
   Only one context/request can run at a time.
7. Run the fixed acknowledgment test. There is no free-text input, microphone,
   generated speech, chat history, or emergency action. Timings and errors appear.
8. **Unload model safely** or **Unload and return** releases native resources.
9. Test again in airplane mode after provisioning.

Do not put GGUF weights in the repository or an OTA JavaScript update. Gemma's
terms, notices, use restrictions, and any redistribution obligations apply to
weights independently of llama.rn's MIT runtime license. Before public model
distribution, package the required license/NOTICE and review app backup policy;
this screen is restricted to development builds.

## Limits and recovery

- Initial settings: 512-token context, 64-token batch, 2 CPU threads, 32 output
  tokens, greedy sampling. iOS requests Metal; Android uses CPU. No automatic
  alternative model or cloud fallback exists.
- Generation deadline: 10 seconds. Initialization deadline: 30 seconds including
  integrity checking. Installed-file check: 120 seconds. Disposal: 30 seconds.
- Provisioning: download has a 15-minute maximum and a 60-second no-new-bytes
  watchdog (also applies while connecting). Duplicate progress does not reset it.
  SHA-256 verification has its own 120-second budget after transfer completes.
  Preparation/activation storage operations each have a 120-second budget.
- On transfer timeout/cancellation use native `cancelAsync`, not resume-data
  generation via `pauseAsync`. Native URLSession handles HTTPS/CDN redirects;
  the URL, exact artifact size, and SHA-256 remain unchanged.
- Provisioning waits at most 15 seconds for cleanup before returning an actionable
  error and unlocking navigation. An internal staging-file lease stays reserved
  until native work and deletion really settle. A retry is refused while that
  lease is held; no second writer, late activation, or force-unlock is allowed.
  Cleanup continues in the background and permits a retry when it completes.
  A permanently unresponsive native task still requires an app restart. Force
  quit the old app before loading this update if the previous download is stuck;
  do not Fast Refresh an active transfer to reset its JavaScript ownership.
- A deadline requests cancellation and reports an error. It cannot forcibly kill
  native initialization or an unresponsive C++ operation. Ownership remains locked
  until native work AND any pending stop settle; no overlapping release/reuse.
- Backgrounding or a drive starting disposes the diagnostic. The normal app shell
  immediately resumes for a drive/safety event; this module does not own safety UI.
- Missing/corrupt files are rejected before native load. Native module absence,
  unsupported platform/backend, or allocation errors appear on screen. CPU-only
  older iPhones and Android chipset coverage require physical validation.
- Native OOM/crashes cannot reliably be caught in JavaScript. Do not interpret a
  successful simulator build or mock test as proof of device support.

## Validation

`node --test tests/gemmaPoc.test.ts`, `npm run typecheck`, and `npm test`.
Record physical-device cold load, first response, sustained memory/thermal use,
background/cancel behavior, repeated unload/reload, and offline operation. Existing
deterministic safety suites must remain green before any later integration phase.

Implementation validation on 2026-10-25:

- TypeScript checking passed.
- Gemma tests: 11 passed. Full existing-plus-new test suite: 402 passed.
- Expo iOS prebuild and CocoaPods installation passed.
- iOS development Metro export passed.
- Xcode 27 Debug simulator build passed (generic iOS Simulator destination,
  code signing disabled). This validates native compilation, not Metal inference.
- No weights were downloaded and no physical-device inference was performed.
- Android native build and device validation remain outstanding.

## Native SHA-256 optimization

The original verifier read 1 MiB through Expo FileHandle into JavaScript and ran
`@noble/hashes` synchronously on Hermes. It was chunked (not a whole-file load),
had no base64 conversion, and yielded between chunks, but each read/hash still
blocked JS. The physical iPhone result of 137.4 MB in 121 seconds measured about
1.14 MB/s for that combined path. It does not isolate read, hash, and render costs.

The local `modules/model-file-hash` Expo module replaces that path with native
streaming SHA-256: CryptoKit/FileHandle on iOS, MessageDigest/FileInputStream on
Android. Both use a worker thread, a bounded 1 MiB buffer, size/regular-file checks,
and cancellation between reads. Only a 32-byte digest (hex encoded) and progress
events cross the bridge; progress is throttled to about 5 updates per second.
No third-party native dependency or new npm package is required. Expo SDK 54's
installed file API exposes native MD5, not an equivalent streaming SHA-256 API.

The expected artifact checksum, exact byte count, verification deadlines and
activation gates are unchanged. Every explicit diagnostic verification rehashes the file.
Stage 2A adds an app-local verification receipt bound to the artifact, URI, size,
modification time and creation time. Unchanged verified installations may reuse
that receipt; missing or changed metadata/receipts require native hashing.
Provisioning always hashes before activation;
loading checks again to detect changes after provisioning. Tests ensure a later
corrupt file cannot inherit a previously verified result.

A native rebuild is REQUIRED (reload/OTA JS alone cannot add this module):
`npx expo run:ios --device`, or `npx expo run:android` for Android development.
Install over the existing app rather than uninstalling to preserve app documents.
Force quit the old app before installing/retesting. If a previous timed-out
download was discarded, provision it again. After success, initialize and run the
fixed prompt; check cancellation and repeated verification as separate tests.
Physical-device timing of the new verifier still needs measurement.

Optimization validation: all 418 tests and TypeScript checking passed; the iOS
Debug simulator build linked ModelFileHash successfully. A real CryptoKit hash
test matches Node crypto on a streamed multi-chunk fixture and checks repeated
hashing, incomplete-file rejection, and cancellation. Android autolinking resolves
the module; Android native build/device execution remains unverified.

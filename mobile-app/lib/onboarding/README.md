# Stage 2A: launch setup

The existing Onboarding component now presents six safe-area-aware, themed pages:
Welcome → How DriveSense Works → Safety and Privacy → Meet Sensi → Gemma License
and Download → Setup Complete. The existing approved branding image and slogan,
Sensi launcher glyph, VoicePicker and shared buttons/themes are reused. There is
no Skip action or general-chat interface. Profile creation/selection is unchanged.

`SensiSetup` persists only versioned local app settings (`drivesense:setup:v1`):
page, separate notice/terms acknowledgments, artifact checksum, notice/terms
versions and completion. It does not create profiles or recordings. Legacy
`onboarded=1` alone does not waive the new notices. Interrupted progress resumes,
but model/runtime readiness is never restored merely from a completion flag.

After explicit acknowledgment, setup first tries the existing model. Missing,
incomplete or checksum-invalid weights can invoke the existing ModelProvisioner;
initialization/service failures do not cause speculative replacement downloads.
Provisioning remains a single exclusive staging-file owner with the same URL,
revision, byte count, checksum, disk check, cancellation and cleanup behavior.
Partial transfers are discarded, not resumed, as in the existing implementation.
The native SHA-256 bridge verifies bytes before activation. No JavaScript weight
hashing or additional runtime/dependency was introduced.

`VerifiedModelFile` stores an app-local receipt for the exact artifact, file URI,
size, modification time and creation time. Unchanged sandbox-managed files may
reuse it for loading; unknown or changed metadata requires native hashing. An
explicit diagnostic Check always forces hashing and invalidates any previous
receipt before hashing. This is a sandbox file-change policy, not an externally
signed attestation or protection against malicious code preserving all metadata.
After initial provisioning it avoids immediately hashing identical bytes again.

Setup initializes the existing llama.rn context and safely unloads it; it does
not generate a prompt, start conversation/audio, or invoke safety/call handlers.
Only verification plus successful initialization and cleanup can reach completion.
On later cold launches, completed notices are not repeated: local integrity and
runtime readiness are checked without an automatic network download. Missing,
corrupt or unusable models show recovery with explicit retry. Compatible hardware
and the existing native modules are required; unsupported devices cannot silently
skip mandatory setup.

Boot/install operations are deferred while monitoring, a recording or a safety
check is already active. Setup does not reopen after inference fails during a running app;
the existing deterministic fallback remains authoritative. Backgrounding cancels
setup, including cold-launch checks before the Onboarding view mounts. Retrying
waits for the existing runtime/provisioner cleanup protections.

Official terms and use-policy text were retrieved from Google on 2026-10-25:
https://ai.google.dev/gemma/terms (modified 2026-04-01) and
https://ai.google.dev/gemma/prohibited_use_policy (modified 2024-02-21).
Both are available offline in the legal modal and linked to their live sources.
Acceptance explicitly includes the use restrictions. The official NOTICE, terms
and policy are also written alongside the model. No model weights are bundled or
changed; publisher/revision remain in artifact.ts. DriveSense prototype notices
are labeled as such, not legally reviewed terms.

No native changes are required if llama.rn and native SHA-256 are already in the
installed build. Reload Metro. Physical iPhone validation must cover first
install, existing-model reuse offline, progress/cancellation/retry, returning
launch and missing-model recovery, Dynamic Island/safe areas, large text and both
themes. Existing safety/recording tests remain part of the suite.

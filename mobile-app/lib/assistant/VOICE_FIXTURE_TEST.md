# Physical iPhone Sensi voice fixture

Use a parked physical iPhone with a development build containing the existing
`LocalFoundationModels` playback bridge. Standard playback needs neither Apple
Intelligence nor microphone permission. The explicitly selected offline microphone
test needs microphone/speech permission and on-device en-US support. Neither mode
enables Connected AI, signs in, invokes a backend, modifies preferences/profiles,
or accesses contacts.

1. Load the updated JavaScript in the existing development app. If native playback
   methods are missing, rebuild the development app using the existing project;
   this change adds no native code or dependency. Do not regenerate the project.
2. Reach the dashboard first (complete existing demo admission if configured).
   Then turn off Wi-Fi and cellular data. This isolates the fixture from unrelated
   app sync/Auth activity; the surrounding app's existing network behavior is unchanged.
3. Open **Settings → Developer — Sensi voice fixture → Open Sensi voice playback test**.
   No change to Assistant Mode or Connected readiness is needed.
4. Tap **Start fixture playback**. Hear “How are you feeling?” followed by
   “That's great to hear! Stay focused and drive safely.” Do not answer: recognition
   is a synthetic transcript, not microphone capture.
5. Confirm the displayed voice name, quality, language and identifier match your
   saved English voice (Zoe Premium if selected and available). Expect `complete`,
   `usedFallback: false`, the exact final reply, and native `completed` with that
   voice ID. An unavailable saved voice must produce an error, not substitution.
6. Restart and tap **Stop fixture** during either utterance. Expect `cancelled`,
   native cleanup completion, no further speech, and successful playback on restart.
7. Restart and tap **Close voice test** during playback. The panel closes only
   after native cleanup. Reopen it and verify a new run works. Also switch Settings
   tabs during playback: unmount must stop audio without a late reply.
8. Restart and background the app or lock the phone during speech. Expect playback
   to stop and never resume automatically. Foreground it and inspect the native
   cancellation/interruption result, then restart manually. To test a real iOS
   audio interruption, use Siri during speech; expect `audio_interrupted` (or
   cancellation if app-background cancellation wins). Never place a call to test it.
9. Restart and tap **Simulate safety preemption** during speech. Expect cancellation
   before the success notice, then “simulated lease released.” No safety alert,
   emergency workflow, contact lookup, dialer, or extra speech is triggered. This
   uses the real shared audio arbiter and immediately releases the simulated lease.
   A real active safety owner blocks the fixture; the fixture never replaces it.
10. Repeat Stop, Close and preemption several times. There must be no overlapping
    speech or stuck owner. Other optional previews should work after cleanup.

## Opening-prompt timing regression (no backend)

The Swift playback changes require rebuilding/reinstalling the native development
app; a Metro reload alone is insufficient. The displayed native revision must be
`playback-start-finish-idle-v2`, with `started: true` and callback `didFinish` for
successful playback. Unknown revision means the installed binary is older.

Reach the dashboard, turn Wi-Fi/cellular off, open this diagnostic, and tap
**Test prompt then microphone (offline)**. Hear the entire opening question before
the phase becomes Listening. Say “stop” to finish without a reply, or say the benign
fixture transcript to hear the fixed fixture response. No Auth, Edge Function or
OpenAI request is part of either diagnostic mode. Do not use the real Connected
conversation while testing this regression. Repeat Stop, Close, backgrounding and
simulated safety preemption during the opening and during capture. Failed or
unconfirmed playback must end with an error rather than start the microphone.

The actual app conversation already awaits native playback completion before
calling recognition. This patch fixes a separate duplicate safety-cleanup race
that could deactivate a newly acquired optional audio session, and rejects native
completion lacking start/idle confirmation. Physical causality for the reported
cutoff still requires this offline device retest; host tests cannot prove speaker
output timing or the behavior of the previously installed binary.

The diagnostic entry and conditional module load are behind `__DEV__`; its runner
also refuses nondevelopment construction. It has no release entry. Release-bundle
and physical-device verification still require the corresponding builds; Node
tests verify the conversation, policy, selection guards and cleanup ordering using
injected playback, not actual iOS sound or OS interruptions.

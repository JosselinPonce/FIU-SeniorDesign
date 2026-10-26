# Sensi safety conversation integration (phase 1 history)

Phase 2 supersedes the provider/continuation behavior described below. See
[SENSI_GEMMA.md](./SENSI_GEMMA.md) for the current event-only Gemma acknowledgment
path, scoped typed input, and disabled ordinary-chat continuation. The following
records the preceding integration design, not the current launch behavior.

Live frames still enter SafetyController → FlagEngine → VoiceCheck. Thresholds,
wellness prompts and retry counts, final-speech/contact proof, incident persistence,
acknowledgment learning and phone handoff decisions are unchanged.

CORE keeps its existing modal and phone voice adapter. LOCAL and CONNECTED snapshot
the selected mode for a transient Sensi safety thread. VoiceCheck reports only the
winning button response or successful final speech to that view; partial text is
never shown as accepted speech. Speech status is display metadata, never consent.
The thread is not passed to the provider, logs, SQLite or telemetry uploads.

The shared view sends choices to the existing respondAlert → SafetyController.answer
→ VoiceCheck.answerByButton path. It locks duplicate taps locally; VoiceCheck's
existing question-scoped race/consent validation remains authoritative.

No model is prepared, invoked or awaited during a safety check. AI availability,
network connectivity and the Connected readiness flag cannot suppress a check.
The existing safety audio priority cancels optional Sensi capture/generation/playback
and waits for cleanup. Normal conversation is never resumed automatically.

After a live check resolves OK without a contact action, SafetyController may grant
one explicit Continue with Sensi action. Session/profile changes, another check,
dismissal or consumption revoke it. The shell also checks the selected mode and
normal Connected launch gate. Continue opens the existing assistant; Start conversation
then uses the normal Local/Connected provider and advisory response policy. No safety
transcript or call consent is inherited by this new optional interaction. Unwell,
unanswered, refused/offered-call and emergency branches do not offer continuation.

Sensi safety playback uses the existing phone VoiceIO and installed system voice
identifier selected in Settings. Unlike CORE's legacy automatic fallback, a missing
saved Sensi voice is never replaced: playback is marked unavailable and deterministic
recognition/on-screen choices remain usable. Optional assistant playback continues
to use the existing native completion-checked bridge. No voice service was added.

Physical iPhone checks: all modes with high/low HR and SpO2 scenarios; prompt-before-
capture ordering; installed premium voice identity; missing voice and denied speech
permissions; ordinary assistant preemption; offer/voice/button races; profile/session
cancellation; truthful handoff status; no automatic resumption or Connected request.

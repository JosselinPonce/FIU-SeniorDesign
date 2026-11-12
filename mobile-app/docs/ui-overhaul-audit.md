# UI overhaul — dependencies and approval boundary

## Phase 0 inspection

- DriverPicker creates/edits canonical metric profiles through repositories/profileEditing; UUID id owns sensor/session associations. Optional custom_id is retained by Supabase exports/views as a team label. Hide its UI, preserve existing values and schema.
- Measurements store cm/kg. Conversion helpers use exact 2.54 cm/in and 0.45359237 kg/lb. The BMI formula is correct, but accepts implausible dimensions; a tiny saved height can produce huge BMI. No affected profile data was supplied, so its precise input error is unproven. Restrict BMI presentation only; do not rewrite existing measurements or change profileModel/threshold algorithms.
- SmartWheelScreen owns driver confirmation/editor, Drive/History/Settings tabs and Sensi standby. CORE VoiceCheckModal and SensiSafetyConversation live in the selected-driver shell, above every tab. Keep that foreground routing and safety-modal priority. No background/lock-screen guarantee.
- SettingsView owns category navigation and safety_testing within local state; current Back/title scroll away and returning pages remount the ScrollView. Reuse those routes with a shared header and retained offsets, not a new navigation system.
- SafetyController.simulate uses a separate FlagEngine and simulation owner/generation. Simulated readings do not persist/learn/upload; runCheck(..., demo) cannot dial. Live handoff requires current profile/session, deterministic final/button/typed consent, valid contact and monitoring. phoneHandoff additionally refuses non-live provenance and simulated episode identities.
- Gemma supplies bounded optional acknowledgment after eligible NOT OK, overlaps mandatory guidance and never authorizes calling. Speech prewarm, native English/Spanish recognition and diagnostic captures must remain unchanged.
- Existing fictional dialer test is a separate intentional phone-interface action using a fixed fictional number and fresh confirmation. Keep it clearly secondary to warning simulation.

## Phase 5 proposal — requires explicit approval before implementation

Keep ordinary warning simulations/rehearsals noncalling by default. An opt-in per-run real-contact demonstration must:

1. Explain the possibility of a real call and identify a valid saved contact before starting; block missing/invalid contact with an Edit route.
2. Capture a one-use run token bound to selected profile id/revision, contact number, simulation owner and generation. Never persist it or let it authorize a live incident/another run.
3. Use the same fabricated-reading engine and deterministic VoiceCheck. Require existing genuine-final/button/typed explicit contact consent; silence, partials, ambiguous answers, errors and no-response cannot qualify. Gemma has no authority.
4. After consent and simulation completion, show a fresh final confirmation with the actual contact and real-call warning. Only a current, foreground, uninterrupted token may proceed. Revalidate profile/contact and consume the token before awaiting the existing native tel handoff. Cancellation/background/profile changes/session changes/new safety event invalidate it.
5. Reuse the existing phone-interface opening primitive with a narrowly scoped separate demo provenance guard. Do not broaden live consent or permit normal demo/rehearsal provenance to pass the live guard. Keep iOS confirmation and never directly place a call.
6. Preserve no incident persistence, no fabricated uploads, no learned baseline/threshold updates, visible Simulation labels, and a separate fictional-number test. Clear authorization after completion, cancellation or interruption.

Approval is required by the user's attached request: “Before changing the emergency-contact simulation authorization boundary, explain the proposed design and identify the specific existing safety guards that must remain intact. Pause for approval before implementing that phase.” Independent profile/navigation/presentation work can proceed while this decision is pending.

## Approval and implementation status

The user explicitly approved the scoped real-contact demonstration during this task before its authorization code was changed. The implementation and validation are recorded in `ui-overhaul-report.md`. Ordinary demo/rehearsal provenance remains refused at the live phone boundary. The approved path uses separate controller-owned consent/confirmation state and the existing tel interface primitive.

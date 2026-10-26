# Stage 2C: Settings switches and simulated phone handoff

## Trace and discrepancy

Settings “Try the voice check” → useDriveSession.rehearseVoice →
SafetyController.rehearse → runCheck(mode=rehearsal, episode.id=rehearsal).
Advanced warning simulator → useDriveSession.simulate → a separate FlagEngine
fed fabricated readings → runCheck(mode=demo, episode.id=demo-*).

VoiceCheck accepts question-scoped final recognition, typed answers or buttons.
Its deterministic contact proof is checked by authorizesContact before any
handoff. Gemma output cannot grant consent. Both simulation modes retain their
captured origin throughout the dialogue and publish simulation=true and a
simulation-complete message; neither calls the controller's handoff dependency.
Post-check manual call buttons are hidden for simulated results.

The working tree already contained the simulation-only branch before Stage 2C.
In contrast, the branch's committed HEAD explicitly says rehearsals may hand off
with consent and permits that handoff. An installed bundle built from older
source can reproduce the reported behavior. The installed iPhone bundle was not
inspected; its exact version is unconfirmed. Native rebuilding alone does not
establish that the running JavaScript came from the current working tree.

A separate current-code ambiguity was found: genuine live readings can trigger
an incident during a warning simulator's warm-up. Monitoring remains active.
Now the real event cancels the simulator owner and clears its display before
starting the real question. The old simulator cannot resume or overwrite the
real episode. The header distinguishes “Simulation” from “Live sensors”. A real
incident still requires its own scoped, explicit consent and may open the phone;
this is not promotion of a simulated incident.

## Independent platform guard

Controller handoffs carry an explicit source and episode ID. Immediately before
Linking.openURL, openAuthorizedPhoneInterface rejects rehearsal/demo sources,
simulated IDs even if mislabeled live, missing/unknown provenance, obsolete
standalone requests and unavailable/expired app ownership. The existing foreground,
supported-screen, connection and freshness checks remain. Only a current real
episode can reach the existing tel: interface. iOS phone authorization is unchanged.

Development Settings shows “Simulation safety revision: 2C” in Health & Safety.
Use that marker to verify the running JS bundle before repeating phone tests.
No Stage 2C native change requires another build; any outstanding Stage 2B native
rebuild is still required to remove the old Apple inference methods.

## Switch appearance

The old switches used primary/surface colors, producing gray/beige enabled tracks
and poor dark-mode distinction. Dedicated switch-only tokens now provide a green
enabled track in both themes, visible gray off tracks, and white thumbs.
settingsSwitchColors supplies the same native props to Auto-connect and direct
sensor bench switches, including iOS's off background. Tests require at least
3:1 thumb/track and track/Settings-card contrast. Existing callbacks and state
lifetimes are unchanged; no new persistence policy or connection behavior is added.

## Validation

Hook integration tests execute both real Settings entry points and the real
controller, with native Linking replaced by a spy. Voice, typed and button consent
and refusal all complete without dialing. Other tests cover live final consent,
live preemption during simulator warm-up, stale/cancelled answers, fail-closed
platform provenance and both theme/control states. Physical iPhone validation is
still needed for native switch rendering, bundle identity and phone UI behavior.

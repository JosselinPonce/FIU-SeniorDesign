# Historical test fixtures — not application providers

These snapshots preserve pre-cleanup advisory/transport and consent regression
contracts. Only automated tests import them, with mocked native/Auth/transport
services. Application code must never import this directory. The native Apple
interpreter is removed rather than archived here. The historical index wrapper
has no matching inference methods in the new native bridge. Production safety
uses Gemma, system speech and deterministic VoiceCheck only.

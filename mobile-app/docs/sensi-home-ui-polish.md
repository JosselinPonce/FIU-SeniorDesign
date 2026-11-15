# Final Sensi home UI polish

Follow-up to `sensi-home-ui-refinement.md`. This report describes the current
compact layout; the earlier report retains its historical implementation notes.
Branch remains `samantha/claude-remediation`, HEAD
`c5655837bb220108a250cacd90eff1ffad8e3ec0`. Work is unstaged and uncommitted.

## Exact task manifest

Modified:
- `components/SensiStandby.tsx`
- `lib/i18n/catalog.ts` (three additive English/Spanish entries)
- `tests/sensiNavigation.test.ts`
- `tests/systemReadiness.test.ts` (compact-copy localization test only)

New:
- `docs/sensi-home-ui-polish.md` (this report)

All other preexisting files and earlier uncommitted refinements are preserved.
No dependency, native, model lifecycle or production safety source changed.

## Before and after

| Before | Current layout |
| --- | --- |
| Meet Sensi heading, horizontal icon/greeting, longer introduction | Original horizontal icon/greeting and tagline, followed by the requested short introduction; no Meet Sensi heading |
| Five vertically stacked readiness indicators with explanations | Exactly four compact name/status rows: steering-wheel sensors, Gemma, voice responses, manual responses |
| Downloaded — not verified | Downloaded · Unverified, a display-only alias of the same conservative state |
| Feature icons and long details under each row | Small status icons, explicit readable statuses, no explanatory paragraphs |
| Try Sensi heading, supporting sentence, button and long disclosure | One Try Sensi primary button and “Simulated safety check · No live emergency actions” |

The introduction is now:
“If DriveSense detects unusual health readings, I'll check in to see how you're feeling.”

Readiness rows arrange names and status horizontally when space permits. They
use natural flex wrapping, shrinkable text, bounded status containers, and no
fixed text heights or truncation. The safe-area host, scrolling, theme tokens,
button styling, original glyph component and its size/colors are retained.
Status words accompany icons, and each row is one concise VoiceOver group.

## Functional preservation

Voice Recognition is filtered out only when mapping home-screen rows. The shared
readiness projection still produces recognition information and the existing
read-only observer is unchanged. No microphone permission, English/Spanish
language asset, capture, VoiceCheck Testing or fallback functionality was removed.

`systemReadiness.ts` and `useSystemReadiness.ts` are byte-for-byte unchanged in
this task. Sensor connectivity and overall monitoring prerequisites are unchanged.
Downloaded/resident Gemma remains unverified without safe event-time readiness
proof; no Ready claim or model operation was added. Download percentages remain
based on actual progress. The new compact label changes no readiness decision.

Try Sensi still invokes the existing navigation callback to Safety Testing. The
button itself starts no sensor event, simulation, capture, persistence or phone
action. Detailed disclosures and any separately authorized contact demonstration
continue inside Safety Testing, with the existing fresh-consent and platform
confirmation requirements. No simulation, consent or dialer code changed.

## Validation

Generated outputs are isolated under `/private/tmp`:

- Focused tests: 80 passed, zero failures.
- Full suite: 1,163 passed; zero failures, cancellations or skips.
- Three new tests plus updated rendering expectations cover hierarchy/copy,
  exactly four rows, recognition omission, original glyph, responsive structure,
  status icons, compact Gemma label, unchanged navigation and Spanish strings.
- Existing recognition, diagnostic isolation, simulation, consent and readiness
  regression suites passed without changing their production implementations.
- TypeScript and Git whitespace checks passed.
- Updated Release iOS JavaScript/Hermes export passed.
- Existing eight Debug trace/timing markers were absent in Release bytecode,
  checking UTF-8 and UTF-16 forms. VoiceCheck Testing remains included as intended.
- Unsigned iOS Debug native-shell build passed using the existing isolated SDK 54
  workspace. Only existing script-phase warnings; no protected native workspace,
  signing, installation, IPA packaging or distribution was involved.

Logs:
`/private/tmp/drivesense-sensi-polish-focused.log`,
`/private/tmp/drivesense-sensi-polish-full.log`,
`/private/tmp/drivesense-sensi-polish-typecheck.log`,
`/private/tmp/drivesense-sensi-polish-export.log`,
`/private/tmp/drivesense-sensi-polish-xcodebuild.log`.

## Physical-iPhone acceptance still required

1. Check the compact hierarchy in both themes on smaller iPhones and large
   Dynamic Type sizes. All four labels/statuses must wrap without horizontal
   overflow. Verify the original steering-wheel icon and horizontal greeting.
2. Use VoiceOver: each row should announce its feature/status, with no hidden
   recognition row or verbose explanations. Verify Close and Try Sensi targets.
3. Disconnect/reconnect sensors and observe genuine model/download/TTS state
   changes. Overall readiness and model conservatism must match the previous UI.
4. Tap Try Sensi and confirm existing Safety Testing navigation and disclosures.
   Exercise VoiceCheck Testing and both-language recognition separately to confirm
   that hiding one row did not change capture or fallback behavior.

Automated structural checks are not proof of native layout geometry or actual
microphone/speaker success. No fixed height-reduction claim is made. Ready for
review with all changes unstaged, uncommitted and unpushed.

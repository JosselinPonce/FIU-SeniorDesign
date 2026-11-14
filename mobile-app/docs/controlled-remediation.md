# Controlled remediation of the recovered Claude branch

Latest status: see **Bounded statement ownership correction** below. Earlier phase
counts and final-verification entries describe the preceding remediation.

Started 2026-11-13 from `152055c7dc87de359cb6cbabee75de535b308fc8` on
`samantha/claude-remediation`. Stable reference:
`c6ffb08462a7638a4a113e279c11b9ce651ad8be`.

No commits, pushes, merges, resets, rebases or original-branch changes are part
of this work. LOCAL_HANDOFF.md, local exclusions, archives and local-only state
are preserved. Build generation runs in an isolated temporary source copy.

## Phase 1: SDK rollback

Git confirms the checkpoint lockfile used Expo 54.0.37, React Native 0.81.5,
React 19.1.0, TypeScript 5.9.3 and ExpoModulesCore 3.0.30. Restore its package
files and app.json, including splash, new architecture and iOS 15.1 settings.
Restore the checkpoint's bundled Feather import and matching test module keys;
retain the application UI and the test mocks' harmless ES-module metadata.

One verified compatibility correction: SDK 54.0.37's bundled dependency check
expects expo-file-system ~19.0.24, while the checkpoint pinned 19.0.21. Pin
19.0.24 exactly. The lockfile only changes that dependency and deduplicates the
already-present nested 19.0.24 copy; no unrelated package upgrades.

TypeScript, dependency tree and Expo bundled compatibility checks pass.
Full regression: 824 passed, 0 failed. Release iOS JavaScript/Hermes export and
CocoaPods resolution passed. Unsigned Debug compilation passed (exit 0 and app executable produced). Xcode 27
emits non-fatal command-exit-0 diagnostic noise alongside compiler warnings. Existing
Swift concurrency warnings are retained; no native speech implementation changed.

## Validation limits

Automated model, phone and microphone fixtures do not establish physical-device
success. No signing, Apple account access, provisioning changes or device
installation is authorized. Release export and unsigned Debug compilation are
build checks only.

## Phase 2: deterministic model boundary

`lib/assistant/safetySemantic.ts` refuses model-only OK for every concern value.
NOT_OK advice requires an independently affirmative, category-matching symptom.
The event/capture/consent boundary is unchanged. Updated naturalLanguageSafety
and voiceCheck regressions cover English/Spanish unsafe OK outputs, including
uncertain concern and wrong-category/ungrounded NOT_OK. One older supposed
model-OK fixture was actually decided by the deterministic prefilter; it now
uses a genuinely unclear statement. TypeScript and whitespace passed; full
suite: 834 passed, 0 failed. Legacy language-path fixes follow in Phase 3.

## Phase 3: bilingual final decision boundary

`intent.ts` checks every candidate, including early negated-help and logistic
results, against shared symptom/hedge evidence. Complete deterministic positive
wording is required for OK; an unknown trailing clause clarifies rather than
borrowing certainty from an initial positive phrase. This intentionally narrows
unsupported positive language while preserving the held-out accuracy gate.

`symptomLexicon.ts` distinguishes current affirmative, negated-only and
historical-only evidence; negation permits bounded modifiers but cannot cross
another symptom or contrast connector. English without and Spanish no tengo
are covered. `wellnessLanguage.ts` restores conservative NOT_OK for qualified
current symptoms such as maybe I feel dizzy; uncertainty without an established
physical concern clarifies. This restores the stable checkpoint's dizziness
escalation rather than accepting the Claude change to unclear. Urgent rules,
classifier weights/thresholds, contact consent and emergency-services exclusion
remain separate. Unknown historical/mixed wording remains conservative.

Added safetyDecisionBoundary regressions for all reported examples, unknown
clauses, mixed history/current symptoms, negation, hedges and emergency
separation. Updated the prior hedged-dizziness policy assertion. TypeScript and
whitespace passed; full suite: 868 passed, 0 failed. No physical ASR claim.

## Phase 4: native cancellation

GemmaPoc operation kinds explicitly distinguish inference from verification,
loading, provisioning and unloading. Semantic cancellation/deadline/disposal
now stop native completion. Scoped cancellation handles capture the active
operation object, so old abort callbacks cannot stop a later operation. The
phone adapter captures these handles for its own load/generation only.
Synchronous/asynchronous stop failures retain serialization until natural
completion; delayed stop is awaited before release. The native API cannot
forcibly release an unresponsive completion safely; deterministic UI fallback
continues while native ownership is quarantined by the active operation.
Actual-controller tests cover cancellation, deadline, dispose, delayed stop,
failed stop, late output and stale cancellation handles. Full suite: 874
passed, 0 failed; TypeScript and whitespace passed. No physical model claim.

## Phase 5: explicit warm ownership

The phone adapter returns an immutable check-scoped release token (or null);
the safety controller releases only its acquired token. Core mode/failed
acquisition release nothing. Stale/repeated/unmatched releases are no-ops.
Maintenance, inactive app state, active cleanup, and independently loaded
diagnostic contexts exclude acquisition. Foreground restoration starts no work.
Last release aborts an owned pending load; an unabortable late initializer is
released by GemmaPoc. Native event ownership and delayed cleanup retain the
runtime until safe release; failed release remains quarantined for explicit
maintenance. No unrelated background warming or download was introduced.

Updated phone adapter, controller/hook wiring, automaticMonitoring and warm
lease tests. Tests exercise actual semantic tasks/controller/native fixtures
for stopping-before-release, nested ownership, maintenance, background, stale
releases, cancelled load, disposal races and cleanup failure. Full suite: 880
passed, 0 failed; TypeScript and whitespace passed.

## Phase 6: monotonic timing and bounded simplification

One 2000 ms maximum availability budget is shared by VoiceCheck, semantic task
and native completion. The phone adapter subtracts cold-load time before
starting completion. performance.now deadlines are checked on publication and
consumption, so delayed callbacks cannot promote expired text. Completion
signals replace nominal polling and 64-hop microtask draining; expiry/manual
races clear their timers. Scoped button/typed answers retain immediate priority
and cancel pending advisory work. A rejected advisory completion falls back
without suppressing deterministic guidance. Acknowledgment stays at 1500 ms.

Shared typed/voice interpretation/result creation and localized manual-answer
text replace duplication. The legacy semanticDecision API delegates to the
production combiner rather than retaining another policy. Debug source is
truthfully labeled gemma-grounded. No duplex/barge-in path was introduced.

Additional final ownership audit: event inference also refuses a separately
owned diagnostic context and pending disposal; blocking warm acquisition alone
would not protect that independent owner from event cleanup. Regression tests
cover this boundary. The integration VM supplies the monotonic clock explicitly,
and its assertions distinguish wellness re-asks from contact-offer retries
(which share one spoken sentence). Manual-win fixtures now keep inference
pending instead of relying on a 50 ms polling delay after model completion.

Full suite: 886 passed, 0 failed; TypeScript and whitespace passed. Final clean
copy build/export/regression verification follows below.

## Final verification

The final isolated source copy (fresh locked SDK 54 dependency installation,
then synchronized intended application changes) passed:

| Check | Result |
| --- | --- |
| Full automated regression | 886 passed, 0 failed/cancelled/skipped |
| TypeScript 5.9.3, both workspace and isolated copy | Passed |
| npm dependency tree | Passed |
| Expo bundled SDK compatibility (offline) | Passed; offline registry validation caveat |
| iOS prebuild and CocoaPods | Passed |
| Release iOS JavaScript/Hermes export | Passed |
| Release bundle inspection | New semantic/sentence diagnostics, model lifecycle diagnostics and timing controls absent (UTF-8 and UTF-16 checks) |
| Unsigned physical-iOS Debug compile | BUILD SUCCEEDED, signing disabled; no install |
| Whitespace and intended-file/sensitive-token review | Passed |

The combiner's TypeScript result type also excludes OK. That final type-only
restriction emits identical JavaScript to the tested/exported implementation;
its TypeScript check passes. Native build logs retain upstream deprecation,
Swift concurrency and script-phase warnings; no dependency/native rewrite was
made to suppress them. No native Swift source, sensor thresholds, BLE/Pi
protocol, Supabase schema/RLS, profile/privacy or language preference state was
changed. Test fixtures use fake model, recognition, storage and phone actions.

Both protected branch refs remain unchanged: claude-development at 152055c,
local-ai-prototype at c6ffb08. Remediation HEAD still equals 152055c (uncommitted
work). The index is empty. LOCAL_HANDOFF.md remains untracked, excluded and
byte-for-byte unchanged; .git/info/exclude was not edited. Local archive and
Supabase CLI cache directories remain present. No push, merge, reset or rebase.

### Files by phase (shared files participate in multiple phases)

1. SDK: package.json, package-lock.json, app.json,
   components/DriverConfirmation.tsx, tests/driverSelectionRefinement.test.ts,
   tests/localization.test.ts.
2. Model safety: lib/assistant/safetySemantic.ts,
   tests/naturalLanguageSafety.test.ts, tests/voiceCheck.test.ts.
3. Language: lib/voice/intent.ts, lib/voice/symptomLexicon.ts,
   lib/voice/wellnessLanguage.ts, tests/safetyDecisionBoundary.test.ts,
   tests/naturalLanguageSafety.test.ts.
4. Cancellation: modules/gemma-poc/controller.ts, modules/gemma-poc/phone.ts,
   tests/gemmaPoc.test.ts.
5. Ownership: modules/gemma-poc/phone.ts, lib/analysis/safetyController.ts,
   lib/hooks/useDriveSession.ts, tests/automaticMonitoring.test.ts,
   tests/gemmaWarmLease.test.ts.
6. Timing/simplification: lib/assistant/safetySemantic.ts,
   lib/voice/voiceCheck.ts, lib/analysis/safetyController.ts,
   modules/gemma-poc/controller.ts, modules/gemma-poc/phone.ts,
   tests/voiceCheck.test.ts, tests/gemmaPoc.test.ts, tests/gemmaWarmLease.test.ts,
   tests/phase2aIntegration.test.ts; this report and historical status notes in
   gemma-primary-interpretation-design.md / gemma-primary-interpretation-plan.md.

### Known limits and parked physical-iPhone checklist

- Language interpretation remains bounded, not unrestricted comprehension.
  Unsupported positive clauses and unclear negation/history clarify. A passing
  fixture suite does not prove a zero-error rate on arbitrary real speech.
- The 2-second budget can legitimately fall back when cold load or cleanup
  consumes it. Real acceptance rate, memory pressure and audio contention need
  device measurements. Initialization/stop cannot be forcibly released safely
  if native work does not return; ownership remains held rather than reused.
- Existing urgent-keyword policy remains conservative and separate; this work
  does not redesign urgent negation or sensor severity.
- Install a native shell built with restored SDK 54, after separate approval
  for signing/device access. Do not reuse a native SDK 58 shell.
- While parked, test English/Spanish current symptoms, the reported unsafe-OK
  examples, negated headache, uncertainty, mixed history/current concerns and
  maybe-dizzy escalation. Confirm immediate mandatory guidance for established
  concerns and clarification/manual controls for unsupported wording.
- Test button/typed answers during preparation and advisory waits; late
  generation, missing model, deadline, cancellation, background, profile changes,
  recording transitions and stale scopes must not grant a phone permit.
- Ordinary simulations remain noncalling and never persist/learn fabricated
  data. The existing separately opted-in saved-contact demonstration still
  requires fresh human offer consent and its distinct expiring one-use permit;
  simulation provenance alone never grants live handoff authorization. Test it
  only with a consenting contact and cancel the native phone prompt unless an
  actual call was separately intended. No emergency-service call is introduced.
- Check sentence pacing, capture after final playback, independent app/driver
  languages, Spanish on-device assets, phone/audio interruption, VoiceOver,
  large text, keyboard/scrolling and foreground BLE/Pi monitoring.
- Verify Developer Tools remain unavailable in an installed Release build. Use
  existing opt-in Debug timing metadata for cold/ready model runs without
  adding transcripts, prompts, contacts or generated text to diagnostics.

Recommendation: ready for user review and a separately approved unsigned
Release IPA build step. AltStore distribution is not yet verified: a Release
native archive/IPA, approved signing/install and the parked physical-device
checks above remain outstanding. No signing credentials, Apple account access,
provisioning changes, IPA packaging or physical installation occurred here.

## Final language safety corrections

The follow-up audit identified four language defects. Changes are limited to
`lib/voice/intent.ts`, `lib/voice/symptomLexicon.ts`,
`lib/voice/wellnessLanguage.ts`, `lib/assistant/safetySemantic.ts`, new permanent
`tests/languageSafetyCorrections.test.ts`, and this report. All earlier
uncommitted SDK/lifecycle/timing/consent work is preserved.

### Causes, fixes and policy decisions

1. Normalization removed the punctuation in `estoy bien, no, estoy mareada`,
   turning a corrective no into symptom negation. Shared scanning now separates
   correction/contrast clauses before normalization, and both deterministic and
   semantic consumers pass raw statements to it. Negation cannot cross those
   boundaries. A clear affirmative concern takes precedence over an earlier
   positive. A later positive does not automatically erase an already reported
   concern; unsupported corrections clarify or retain conservative caution.
2. The complete-positive grammar omitted ordinary Spanish answers. It now
   recognizes bien, muy bien, todo esta bien, estoy perfectamente bien and
   supported me siento/me encuentro forms, with the existing bounded polite
   suffixes. A clause-aware negative-wellness guard prevents the expanded
   grammar from clearing no muy bien, no todo esta bien or no estoy
   perfectamente bien, while preserving No, todo esta bien.
   Complete unhedged positives are deterministic; unknown trailing
   clauses, contradictory symptoms and uncertainty still cannot clear as OK.
3. Negation cues omitted no headache and do not/don't have a headache. These
   bounded constructions now apply only within their clause, with existing
   bounded modifier gaps. A negated symptom alone clarifies because it does not
   establish general wellness. A complete positive plus supported negation may
   resolve OK. Another affirmative symptom remains NOT_OK. Without support is
   preserved; arbitrary global negation stripping is not used.
4. The global help-refusal exception suppressed independent urgent physical
   symptoms. Only for that exception, independently affirmative existing urgent
   physical complaint forms now retain urgency (including can't breathe, no
   puedo respirar, chest/pecho pain and existing fainting terms). The original
   urgent vocabulary/default policy is unchanged outside that exception.
   Quoted/reported/past mentions, recognized local negation and positive
   breathing reassurance do not create a new urgent override. Help preference
   never grants contact consent, and urgency never grants automatic calling.

Examples after correction: Spanish corrective dizziness is NOT_OK; each of the
four reported Spanish positives is OK after one capture; I have no headache is
unclear; I am fine but I do not have a headache is OK; help refusal plus can't
breathe is NOT_OK with urgent=true in English and Spanish.

### Verification of the language corrections

The initial new 53-case regression file reproduced 26 failures before the
implementation. After the fixes, a targeted 171-test run and the first full
944-test run passed. Additional guard/typed/negative-affirmation tests bring the
permanent language correction file to 74 cases. Final verification in an isolated
copy under `/private/tmp/drivesense-language-verify-g5jz0qzz` passed:

- Full automated suite: 960 tests passed; zero failures, cancellations or skips.
- TypeScript: passed.
- SDK 54 dependency tree and offline Expo dependency consistency: passed; online
  registry freshness was not checked.
- Release iOS JavaScript/Hermes export: passed. Existing diagnostic labels were
  absent from the exported Hermes bytecode (UTF-8 and UTF-16 checks).
- Git whitespace check: passed; staging area remains empty.
- File fingerprints: only the four listed language source files and this report
  changed among preexisting files; the regression test file is new. Native,
  dependency, configuration, handoff and Git exclusion files are unchanged.

The branch remains `samantha/claude-remediation`, HEAD
`152055c7dc87de359cb6cbabee75de535b308fc8`; both protected development/prototype
refs remain unchanged. These corrections are ready for final independent audit,
with all work left uncommitted and unpushed.

A fresh native compile is not required for these changes: no Swift/Objective-C,
native module dependency, Expo/iOS configuration, native Gemma adapter/controller
or entitlement changed. Fingerprints confirm those files match the independently
audited, successfully compiled SDK 54 implementation. That build remains native
compatibility evidence, not physical-device or current language-quality proof.
A new Release JavaScript/Hermes export validates the changed TypeScript bundle.

No signing, IPA distribution, commit or push is part of this work. Physical ASR
punctuation, capture behavior and on-device model/audio performance remain
unverified. When recognition omits meaning-bearing correction punctuation,
identical text can be ambiguous; this bounded parser is not a general-purpose
language or medical interpretation system.


## Language safety boundary hardening

The acceptance audit reproduced two P1 issues. This follow-up changes only
`lib/voice/{intent,symptomLexicon,wellnessLanguage}.ts`,
`lib/assistant/safetySemantic.ts`, `tests/languageSafetyCorrections.test.ts`, and
this document. Existing uncommitted remediation remains intact.

### Root causes and bounded policy

- The complete-affirmation grammar accepted an arbitrary discourse `no` before
  `good`. Its new deterministic consumer therefore cleared `no good`. Remove
  arbitrary `no`/`nah` prefixes; independently asserted `no good` and supported
  equivalents are negative wellness. Preserve bounded punctuated first-person
  discourse answers (`no, I'm fine`) and existing Spanish discourse answers
  (`No, todo está bien`). Neither `no, good` nor `good, no` establishes a clear
  positive; both clarify. Punctuation-free `no good` is NOT_OK.
- The urgency helper vetoed all quotations globally, while the final wellness
  guard also vetoed all reported speech globally. Mask quoted spans before
  splitting explicit contrast/punctuation clauses, then exclude reported and
  hypothetical clauses from independently asserted evidence. Quoted complaint
  words cannot supply urgent evidence; a separate current complaint can.
  Supported quote styles include straight/curly double and single quotes
  (preserving contractions), plus Spanish guillemets. Masking happens before
  splitting so a contrast word inside a quotation cannot escape its scope.
- The shared lexical scanner retains its existing contract, including callers
  that already normalized transcripts. Intent and semantic grounding apply the
  asserted-clause filter at their decision boundaries. This avoids changing a
  lexical match into a claim about the speaker. Independently asserted current
  nonurgent symptoms also survive unrelated quoted/reported clauses.
- Whole-answer bounded affirmation remains required for OK. Unknown tails,
  contradictory corrections and hedges cannot borrow affirmative words. Clear
  current urgent complaints keep immediate fixed guidance. Calling still uses
  the existing independent consent and native phone confirmation process.
- No general language parser, new model authority, urgency vocabulary expansion,
  deadline, microphone/lifecycle or consent mechanism was introduced.

### Reproduced full VoiceCheck outcomes

`no_response` below means clarification followed by conservative unresolved
handling after a second unclear answer, not reassurance. All comparisons used
final recognition evidence; none authorized a contact call.

| Input | Before | After | Urgent guidance after |
| --- | --- | --- | --- |
| no good | OK, reassurance | NOT_OK | No; ordinary safety guidance |
| not good | NOT_OK | NOT_OK | No |
| no, good | OK | no_response | No |
| good, no | no_response | no_response | No |
| I'm good, no, I'm dizzy | NOT_OK | NOT_OK | No |
| estoy bien, no, estoy mareada | NOT_OK | NOT_OK | No |
| no muy bien / no todo está bien | NOT_OK | NOT_OK | No |
| I have no headache | no_response | no_response | No |
| I'm fine but I can't breathe | urgent NOT_OK | urgent NOT_OK | Yes |
| I don't need help but I can't breathe | urgent NOT_OK | urgent NOT_OK | Yes |
| she said "I can't breathe" | urgent NOT_OK | no_response | No; quoted complaint excluded |
| she said "stay calm" but I can't breathe | urgent NOT_OK | urgent NOT_OK | Yes |
| I don't need help, she said "stay calm", but I can't breathe | no_response | urgent NOT_OK | Yes |
| no necesito ayuda ella dijo "tranquila" pero no puedo respirar | no_response | urgent NOT_OK | Yes |
| no necesito ayuda ella dijo tranquila pero no puedo respirar | urgent NOT_OK | urgent NOT_OK | Yes |

Ordinary good, I'm good, bien, muy bien and todo está bien remain one-capture OK.
The permanent matrix includes quoted/unquoted variants, correction ordering,
negation scope, unknown clauses and punctuation-free recognition transcripts.
The 48 added cases each check classifier and real VoiceCheck results, consent
absence and absence of false reassurance; urgent cases assert exact immediate
English/Spanish guidance and no optional semantic consult. No earlier tests
were removed or weakened. The expanded 122-case language file reproduced 19
failures against the pre-hardening implementation.

### Acceptance limits

Verified fixture behavior is not proof of universal language safety. Reporting
without an explicit boundary is deliberately conservative: `she said stay calm
I can't breathe` clarifies, while `she said stay calm but I can't breathe`
establishes a separate current complaint under this bounded rule. Punctuation
loss can change meaning: an identical transcript can represent a correction or
true negation. Nested/malformed quotations, multiline quoted speech, unfamiliar
reporting verbs, indirect speech and unlisted symptom paraphrases are not a
complete tested grammar. The preexisting conservative urgency policy outside
this quotation/help-refusal boundary remains in place.

Physical-iPhone ASR punctuation, selected-language recognition assets,
microphone/audio interruptions, on-device inference latency and native phone
confirmation remain unverified. No signing, distribution, commit or push was
performed. The goal is another independent acceptance audit, not a claim that
all natural-language constructions are safe.

### Final hardening validation

Validation ran in `/private/tmp/drivesense-hardening-fsqgotdm`:

- Focused classifier/VoiceCheck/lexicon/safety tests: 248 passed, zero failures.
- Complete automated suite: 1,008 passed, zero failures, cancellations or skips.
- TypeScript: passed (`tsc --noEmit`).
- Git whitespace check: passed; staging area remains empty.
- Task-start SHA-256 comparison: exactly the six files listed above changed;
  all other fingerprinted existing files, including SDK manifests/configuration,
  native Gemma integration/lifecycle, VoiceCheck timing/consent implementation,
  `LOCAL_HANDOFF.md` and its Git exclusion, remained unchanged.
- No native/dependency/configuration changes: no native rebuild was needed for
  this TypeScript-only correction. Earlier native build evidence remains
  applicable to native compatibility, not to physical speech accuracy.
- Branch remains `samantha/claude-remediation`, HEAD
  `152055c7dc87de359cb6cbabee75de535b308fc8`; protected refs are unchanged.

Ready for another independent acceptance audit. All work remains uncommitted
and unpushed; passing fixtures do not establish universal language safety.


## Bounded statement ownership correction

### Root cause and representation

The previous filter flattened clauses and discarded any containing a reporting
word. Its coordinator regex recognized only selected following subjects, so
`I can't breathe and she says stay calm` became one reported span. Conversely,
`she said I cannot breathe and I have chest pain` split before the second I and
silently promoted reported content into current driver evidence. The quote regex
also permitted apostrophes inside words only before lowercase letters, so
uppercase contractions escaped single-quote masking.

`statementSegments` now returns bounded normalized text segments with one of
four explicit ownership states: driver, quoted, reported, unresolved. It scans
quotation delimiters before interpreting punctuation or conjunctions. Unicode
word characters on both sides identify word-internal apostrophes independently
of case. Straight/curly single and double quotes plus guillemets are supported;
an unclosed quote remains unresolved. Quoted text is retained as quoted evidence,
not flattened into a driver assertion.

Outside quotes, punctuation, explicit contrast, and coordination create segment
boundaries. Coordination is split consistently, without enumerating subject
names. A reported segment therefore cannot retroactively change an earlier
segment's ownership. Reporting scope survives coordination, commas and colons:
a subsequent unquoted continuation is unresolved rather than assumed driver-owned.
A full stop, question/exclamation mark, semicolon or explicit contrast can bound
that reporting scope. A complete quotation also bounds its report.

Only driver-owned segments feed `assertedWellnessClauses`, which existing intent
and semantic grounding consumers already share. The final intent guard consults
the same ownership representation. The lexical scanner's contract, complete
wellness affirmation grammar, raw correction boundaries, deterministic negative
rules, and existing urgent vocabulary are unchanged by this follow-up.
`wellnessLanguage` remains a candidate generator; the final intent boundary owns
clearance. VoiceCheck receives the resulting deterministic urgent NOT_OK and
plays fixed urgent guidance without optional inference. Consent is still an
independent process. No model authority, timing or native ownership changed.

### Explicit ambiguity policy and exact comparisons

Unquoted `she said I cannot breathe and I have chest pain` contains reported
then unresolved segments and clarifies. The reverse-order unquoted statement
`she says stay calm and I can't breathe` also clarifies: this bounded system does
not infer that reporting has ended from an apparent change to first person alone.
By contrast, `she says "stay calm" and I can't breathe` or
`she says stay calm but I can't breathe` provides an explicit boundary and keeps
the current complaint urgent. An earlier independent complaint remains urgent
when a later report has unresolved continuations.

The following comparisons exercised finalized recognition evidence through full
VoiceCheck. In unclear cases, a second unclear fixture answer produced
`no_response` and ordinary unresolved safety guidance. No fixture authorized a
contact call.

| Input | Before | After | Immediate urgent guidance after |
| --- | --- | --- | --- |
| I can't breathe and she says stay calm | no_response, nonurgent | urgent NOT_OK | Yes |
| my chest hurts and my wife told me to relax | no_response, nonurgent | urgent NOT_OK | Yes |
| no puedo respirar y ella dice tranquila | no_response, nonurgent | urgent NOT_OK | Yes |
| me duele el pecho y ella dijo que todo está bien | no_response, nonurgent | urgent NOT_OK | Yes |
| I do not need help but I can't breathe and she says stay calm | no_response, nonurgent | urgent NOT_OK | Yes |
| no necesito ayuda pero no puedo respirar y ella dice tranquila | no_response, nonurgent | urgent NOT_OK | Yes |
| 'I CAN'T BREATHE' | urgent NOT_OK | no_response, nonurgent | No |
| ‘I CAN'T BREATHE’ | urgent NOT_OK | no_response, nonurgent | No |
| "I CAN'T BREATHE" | no_response, nonurgent | unchanged | No |
| she said "I can't breathe" | no_response, nonurgent | unchanged | No |
| she said I cannot breathe and I have chest pain | urgent NOT_OK | no_response, nonurgent | No |
| I can't breathe. She said I am fine and I have chest pain | urgent NOT_OK | unchanged | Yes |
| she says stay calm and I can't breathe | urgent NOT_OK | no_response, nonurgent | No; unresolved ownership |
| she says 'stay calm' and I can't breathe | urgent NOT_OK | unchanged | Yes |

### Validation and preserved boundaries

Exactly four files changed in this task: `lib/voice/symptomLexicon.ts`,
`lib/voice/intent.ts`, new `tests/statementOwnership.test.ts`, and this report.
No earlier tests were removed or weakened. The 64 new permanent cases cover
classifier and full VoiceCheck outcomes, both languages/orders, help refusal,
quoted/unquoted scope, uppercase contractions, unfinished quotes, arbitrary
reported subjects, fixed guidance, no false reassurance, and no call authority.
Existing affirmation/negative/correction/negation fixtures remain in the suite.

Validation in `/private/tmp/drivesense-ownership-m0ie077v`:

- Focused tests: 312 passed, zero failures.
- Full automated suite: 1,072 passed, zero failures, cancellations or skips.
- TypeScript: passed.
- Prior independent 76-probe matrix: 76 met expected outcomes, zero mismatches.
- Git whitespace check: passed; no files staged, committed or pushed.
- SDK/native dependency/configuration, Gemma lifecycle, VoiceCheck timing and
  consent implementation are unchanged. No native rebuild is needed for these
  TypeScript-only language changes. Existing native build evidence remains
  compatibility evidence, not physical speech-quality verification.
- Branch stays `samantha/claude-remediation` at
  `152055c7dc87de359cb6cbabee75de535b308fc8`; protected refs, local handoff and
  its exclusion remain unchanged.

### Known limits and readiness

This is bounded ownership segmentation, not a general natural-language parser.
Its explicit sentence/contrast boundaries are a documented policy. Unquoted
reporting can remain ambiguous even with apparent subject changes. Nested or
mismatched quotation styles, unfamiliar reporting verbs/subjects, subordinate
clauses without supported boundaries, indirect speech, sarcasm, and unlisted
symptom paraphrases are not comprehensively modeled. ASR can omit punctuation
or change ownership-bearing wording; identical recognized text can have multiple
meanings. Passing these fixtures does not establish universal language safety.

Physical-iPhone recognition (both selected languages), punctuation retention,
audio/microphone interruptions, on-device inference timing and native phone
confirmation remain unverified. Ready for independent acceptance testing with
all work uncommitted and unpushed; no signing or distribution occurred.

# CI testing audit — 2026-11-12

Reviewed checkout `316a877dad4a0f5cc3c121a22b62511417a99d9d`, all 14 existing workflow files, test configuration and fixture gates, and representative assertions across unit, integration, browser, Docker and native suites. Runtime evidence comes from the latest merged PR, [#345](https://github.com/cl0ud6uru/CollectiveUI/pull/345), at `54844e8a414b286b4d6592b1652dddfde84ba022`. This is one observed run, not a long-term flakiness or billing analysis.

## Findings and changes

| Finding | Evidence and action |
| --- | --- |
| Three full unit runs per PR/main revision | Host CI, Docker validation and Docker release all ran the same unit project. Made the redundant Docker validation workflow manual. Retained host feedback and the isolated, non-root, network-disabled release proof. |
| Duplicate worker builds and smoke tests | Both Docker workflows built/audited the worker and ran worker/widget smoke tests. Automatic execution now belongs to the exact-release-image job. Its unique missing check, real Docker Codex environment inspection, moved there too. |
| Demo captures treated like mandatory tests | The iOS screenshot job builds and captures demo screenshots/video, without visual comparisons. It now requires explicit `workflow_dispatch` input `capture_screenshots: true`. Actual native builds and UI regression assertions remain automatic. |
| Obsolete runs consume runners | Added per-workflow/ref cancellation to eight PostgreSQL/MCP/Office workflows. Release PR runs also cancel superseded runs; trusted publication remains serialized and non-cancellable. |
| Office tests missed dependency changes | Made PR/push path filters identical and included dependency manifests, database changes, sandbox code, build helpers and configuration. This intentionally runs relevant coverage more often. |
| Real integration coverage silently skipped | The default checks job has no database. Added a separate core PostgreSQL proof for provider round trips, routing, web runs and executor runs using local synthetic model services, with a report guard rejecting missing/skipped cases. |
| Dormant integration test exposed a real bug | Deleting a provider clears a bot's `appId`. Bot duplication interpreted that as Codex even without a Codex policy. The small server fix distinguishes missing provider from actual Codex and preserves both rejection behaviors. |
| Unnecessary fixed sleep | Replaced the browser stream revocation test's 3.13-second wait with a fake clock. It still proves authorization loss aborts the source and rejects queued frames. |
| Workflow expression lint errors | Quoted the PostgreSQL service port map key in the historical Hermes browser harness so its expressions typecheck in actionlint. |
| Misleading integration instructions | Replaced the broad single-database integration example with explicit suite selection and explained incompatible fixture database names and skips. |

During integration with newer main commits, #349 added iPad light/dark readiness assertions to the screenshot capture job. These validate capture preconditions rather than compare visual baselines. Keeping capture opt-in also makes that specific iPad readiness smoke manual; the full native regression suite remains automatic. Its eight fast exporter-integrity tests were moved into the automatic regression job so those guards are retained on every matching change. The original timing sample above predates that screenshot change.

Legacy required status names `Docker unit tests` and `Production worker image` are retained as small jobs that depend on `Test exact release images`. They fail unless that proof succeeds, including when it is skipped or cancelled. They do not rebuild or rerun tests. Branch-protection administration could not be read (GitHub returned HTTP 403); a ruleset requiring the old workflow **file**, rather than its check names, still needs separate review before merging. No remote repository settings were changed.

## Measured waste

| Historical job | Observed duration | Change |
| --- | ---: | --- |
| Docker unit tests | 5m 15s | Removed automatic duplicate build/suite; retained its unique ~4.5s Codex fixture in release validation. |
| Production worker image | 1m 35s | Removed automatic duplicate build/audit/smoke. |
| Simulator screenshots | 15m 46s | Manual artifact generation only. |

That is about **22m 36s of gross runner time per matching revision** in this sample, before the small compatibility gates, moved fixture and new core integration proof. Linux and macOS runner minutes have different costs; this is not a billing estimate or a promise of equivalent wall-clock savings. The original release job took about 16m 30s and remains on the critical path. Superseded-run cancellation saves additional unmeasured time.

The historical host test command took 487s and reported 351 passing files and 96 skipped files. The duplicate Docker unit run took 265s; release's unit run took 408s. Differences between runners mean these timings cannot be treated as a controlled benchmark.

## Tests worth keeping

- The `fsops-lifetime` suite took 45s. It actually verifies wall-time and CPU limits terminate child processes; mocking that timeout would remove the isolation proof.
- Real PostgreSQL locking tests, including pool sizes 1 and 4, exercise different deadlock/concurrency behavior. They are not duplicates merely because assertions overlap.
- Pinned native Hermes and official-image tests use different execution boundaries from mocked unit tests. Keep those boundaries explicit.
- Source scans protecting authorization/import/security boundaries are useful structural checks. Most filesystem-reading tests also exercise real migrations, persisted state or assets; deleting them wholesale would lose coverage.
- The general host test command still includes unconditional offline cases located inside integration/sandbox projects. Merely changing it to `--project unit` would silently drop those cases.

## Remaining opportunities and coverage limits

1. **Broader integration inventory:** 79 integration files existed; 19 were explicitly selected by workflows before this change. The new core proof adds four. This is a static file-selection count, not an assertion-level coverage percentage. Numerous authentication, migration and app/browser scenarios still require separate fixture stacks. The generic integration command cannot run all suites against one database because some enforce incompatible database names.
2. **General E2E is still manual:** five E2E files ran through dedicated configurations. The broad LDAP/app/worker suite requires a disposable stack; its setup loads `.env.local` and resets data, including user credentials. The Docker Hermes browser acceptance workflow targets a pinned historical application revision and must not be represented as current-app E2E coverage.
3. **Two unit environments remain:** fast host feedback and the isolated release gate still overlap. A future reusable dependency graph could share a single proof while retaining a fail-closed publication gate; this audit does not weaken release gating to save that second run.
4. **PGlite setup:** 69 unit-test `new PGlite()` sites and 50 migration-directory enumeration sites suggest setup overhead. Investigate immutable migrated snapshots for ordinary behavior tests, keyed by migration content. Keep independent migration/upgrade/backfill tests and never share mutable databases between suites.
5. **Brittle source tests:** `unified-chatgpt-ui.test.ts` asserts exact JSX/text and `void refresh(true)` while browser fixtures already exercise many corresponding flows. Replace those checks with the remaining unique mount/session behavior when touching that component. The small runtime saving does not justify deleting unique coverage blindly.
6. **Flakiness and costs:** one successful CI sample cannot establish long-term failure frequency, actual billed minutes, or account-level token usage. No coverage-percentage or “every test is necessary” claim is made.

## Token usage

No paid model calls were found in the configured automatic CI paths. Provider, native and browser fixtures use local synthetic services and fake credentials. Docker Hub secrets are publication credentials, not inference keys. Manual live-Hermes commands accept configurable gateways; they can spend tokens if an operator points them at a real-model profile instead of the documented mock. No real inference was requested during this audit.

## Validation

- Full unit collection: 4,335 cases in 357 files. The restricted executor initially blocked loopback sockets and child processes in 41 files, also preventing dependent cases from running. Rerunning exactly those files outside that restriction, with credentials excluded, passed all 619 active cases (2 gated skips). Replacing those files' original results with the retry results gives **4,246 passed, 89 skipped and zero failed** original cases. The expanded bot-copy suite separately passed all 14 cases, adding two regressions, and the timer-change suite passed all 20 cases.
- New integration proof: all 48 cases passed against a fresh disposable PostgreSQL 16 database, zero skips. The report guard passed 9 positive/negative tests. Local integration execution took about 9.24s excluding provisioning/migration; the fixture container was removed afterward.
- All 50 deployment/release helper tests passed. Compatibility status checks were verified to reject failed, cancelled, skipped and empty upstream results.
- All workflow files pass checksum-pinned actionlint 1.7.12 with the repository's `xcode-27` runner-label allowance. Changed embedded shell blocks also pass Bash syntax checks.
- TypeScript checking, touched-code ESLint and `git diff --check` passed. Local JavaScript validation used Node 24; CI continues using Node 22.

These results record local validation before the pull request. GitHub-hosted Docker/native runs must also verify the changed workflows; local lint and selected tests do not substitute for those environments. The bot-copy change affects a shared server action; no equivalent duplicate action was found in the iOS/macOS clients and no client UI changed.

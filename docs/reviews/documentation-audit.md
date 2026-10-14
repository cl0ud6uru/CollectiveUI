# Code and documentation audit — 2026-10-12

Reviewed source baseline: `7c56f8c`. This audit compared the repository documentation with the implementation, configuration, migration journal, test fixtures and CI definitions. The inventory included 130 tracked Markdown/text files: root guides, architecture/feature/operation/security/testing docs, the iOS README, hidden Hermes plans, screenshot notes, asset provenance and creation prompts. Historical records remain historical; dependency manifests and source notices retain their pins and provenance. This is not certification of live providers or a production deployment.

## Corrections made

| Area | Correction and implementation evidence |
| --- | --- |
| Bot engines | Documented the Codex app-server text pilot alongside Native and Hermes, including per-caller runtime assignment and its direct-text-only restrictions. See [bot editor](../../src/components/bots/bot-builder.tsx), [Codex policy](../../src/lib/codex/config.ts) and [runtime contract](../codex-harness.md). |
| Delegation and navigation | Corrected blanket claims that delegates cannot request approval or continue a task; native asynchronous delegates can relay workspace approvals, and native follow-ups retain child context. Corrected coordinator ordering to match pinned order and unpinned recency. See [delegated approvals](../../src/lib/delegation/approvals.ts) and [navigation](../../src/lib/bots/navigation.ts). |
| Hermes | Separated older plans and fixture milestones from current managed/personal controls, Team member connections, native learning, official-plan authentication and resource publication. Retained explicit live-validation limits. |
| Tool approvals | Corrected the unconditional workspace-approval claim: commands default to Ask, but explicit per-bot Auto overrides are implemented; organization-enforced approval still wins. See [configuration](../../src/lib/bots/tool-config.ts) and [approval assembly](../../src/lib/agent/toolset.ts). |
| Workspace | Removed the claim that files are accessible only through bots; the current browser supports file previews, upload/download and streamed commands. Kept disk-quota, network and terminal limitations. See [workspace guide](../architecture/workspace-browser.md). |
| Mobile and voice | Updated mobile routes/features, shared 2D/3D voice behavior, reaction library, implemented diagnostics, signing and Live Activities. The worker also requires `MOBILE_APP_ENABLED=true`; otherwise delivery can retire registrations. See [delivery implementation](../../src/lib/live-activities/delivery.ts) and [setup](../operations/live-activities.md). |
| Deployment and development | Corrected migration head to 0053, direct versus group execution, task concurrency, encryption key rotation, CI coverage, local-auth preview protocol, direct group membership and URL-safe Compose password guidance. See [operator guide](../operations.md) and [development guide](../development.md). |
| Historical evidence and assets | Removed stale present-tense test totals and future-work claims, labeled historical QA/verification records, checked asset notices/hashes, and repaired the coordinator section link. |

## Verification performed

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed. |
| `npm run lint` | Passed with no errors and two existing unused-variable warnings: `src/app/(chat)/actions.ts` and `tests/browser/workspace-browser.mjs`. |
| `npm test -- --project unit --maxWorkers=4` on macOS / Node 26.7.0 | **Not green:** 198 suites passed, 13 failed, 4 skipped; 2,323 tests passed, 194 failed, 16 skipped, plus 5 reported errors. See platform analysis below. |
| Focused voice/pet unit tests | 156 tests across 16 suites passed; these overlap the full unit run and are not additional unique coverage. |
| CollectiveKit Swift package | 87 tests passed with Xcode 27.0. |
| iOS checks | Seven source-contract checks and `node ios/scripts/build-voice-engine.mjs --check` passed. |
| Isolated browser checks | Workspace browser, sidebar roster and voice-mode scripts passed desktop/mobile interaction assertions with no page errors. |
| Assets and documentation | Documented pet/portrait and supervisor-fixture hashes matched; 309 local Markdown file/image/section links across 131 tracked/new text documents resolve, and `git diff --check` passed. |

The first sandboxed JavaScript run could not open fixture listeners and was interrupted. The result above is the subsequent run with local listener/process access allowed.

### Linux-only unit failures

The failed suites exercise production Linux restrictions on a macOS host. Resource helpers and local Hermes configuration reject non-Linux platforms. Official-plan custody uses a Linux-only protected store and `/proc/self/fd`; process cleanup enumerates `/proc`. Resource-driver tests also use temporary paths that conflict with canonical-path enforcement on macOS (`/var` resolves to `/private/var`). Early refusals cause follow-on timeouts and cleanup/assertion errors.

This triage did not identify a separate functional regression, but it does **not** establish those tests pass on Linux. Run the documented [Linux Docker test target](../development.md#running-the-tests) for a complete result. No production guard was weakened to make host-incompatible tests pass.

## Screenshot refresh

Twelve desktop/mobile PNGs were added or refreshed: seven workspace views, three sidebar captures and two voice views. Every image was visually inspected. The captures use current components, generic fixture identity and synthetic backend data; they do not claim working provider, microphone or Docker connections. The original full-stack README captures were retained and clearly dated. See [provenance and repeatable commands](../images/README.md).

## Remaining validation limits

Docker was unavailable on this host, so the complete Compose stack, full database/LDAP E2E suite and Linux unit image were not rerun. Native simulator screenshots were not refreshed. Live provider inference, real directory sign-in, APNs delivery, native runtime isolation and production recovery still need the intended environment. Historical successful checks in other documents remain evidence of their original runs, not newly reproduced results from this audit.

Application runtime code was unchanged. The only executable-file edits replaced organization-specific names in two screenshot fixtures with generic demo branding and identities, and updated their matching assertions.

## PR preparation against updated main — 2026-10-13

The initial review and test counts above apply to source baseline `7c56f8c`. Before publishing the PR, the documentation branch was rebased onto `e71527c`, preserving the newer personal Codex harness guide and iOS CI guidance. Current guides were reconciled with the personal Codex runtime, workspace template instances/starter images, separately disabled private browser runtime, and migration head `0056_web_sessions`. The screenshot fixtures still depict the legacy workspace browser; they do not show private template instances or a live browser runtime. New main's runtime changes belong to their original commits, not this documentation PR. Validation after reconciliation: type checking passed; lint passed with three existing warnings; all three isolated screenshot browser checks passed; four focused workspace suites passed all 47 tests; all 341 local file/image/section links across 141 text documents resolve; `git diff --check` passed. The original full-suite and Swift results above were not rerun for the newer upstream runtime code.

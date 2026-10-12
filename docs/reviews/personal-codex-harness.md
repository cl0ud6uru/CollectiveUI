# Personal Codex harness validation

Validated in the CollectiveUI cloud checkout on 2026-10-12. No production deployment, account login, live credential configuration, paid inference, or host/network security changes were performed.

## Scope and dependency

`feature/personal-codex-harness` starts from current main plus workspace-contract foundation `d99468e13657df8217655cc67916c8bffb7f181d`. It consumes the canonical workspace contract and adds migration 0055 after the foundation's 0054. It does not revive the previous caller-owned text branch, alter native macOS work, or include PR159 CI cleanup. The draft PR targets the foundation branch and should be retargeted to main after that dependency lands.

## Checks

| Check | Result |
| --- | --- |
| `npm test -- --project unit --maxWorkers=2` | 214 files passed, 4 skipped; 2,575 tests passed, 16 skipped |
| Final four harness suites after the identity-sync and cancellation race fixes | 77 tests passed |
| `npm run typecheck` | Passed |
| ESLint for changed TypeScript files | Passed, including subsequent targeted lint for review fixes |
| `npm run build` | Passed; this is the Next application build |
| `tests/browser/personal-codex.mjs` | Passed with synthetic endpoints, including connection, policy revocation, uncertain login, signed-out cleanup, explicit approval decisions, and 320/390/768/1280 layouts |
| `tests/browser/codex-harness.mjs` | Passed with synthetic actions and the actual bot editor |
| `git diff --check` | Passed |

Browser fixtures used `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium`. The focused command was:

```sh
npm test -- --project unit tests/unit/personal-codex-accounts.test.ts tests/unit/personal-codex-broker.test.ts tests/unit/personal-codex-docker.test.ts tests/unit/codex-harness.test.ts --maxWorkers=2
```

## Independent review

Sol implementation/authorization review identified defects that were fixed and covered by tests: Unix transport routing, retained-runtime recovery without reprovisioning, stale pre-ack approval callbacks, concurrent approval card identity, pending-card cleanup, transaction-local permission reads, logout after policy revocation, delayed account verification at terminal completion, current identity email at confirmation, and cancellation racing successful native sign-in. The reviewer verified the final cancellation regression and reported no remaining finding in that focused check. Official pinned protocol inspection and bounded fixture tests supplemented the review.

## Native verification limit

The normal production Docker build encountered npm DNS failure inside Docker. A separate offline fixture build used the exact public Linux x64 Codex package and production permission policy/wrapper, without credentials or wider network/security permissions. The fixture omits production git/python packages and is not a deployment image.

The real 0.163.0-alpha.2 binary initialized successfully and reported the expected managed policy. Disposable home/workspace volumes survived container replacement. Native command execution failed because this host/container cannot create the unprivileged namespace required by bubblewrap under the proposed constraints. The probe exited 1 with `verified: false`; see [machine-readable evidence](personal-codex-native-evidence.json).

Consequently, protected-file/symlink denial, tool-network denial, production proxy enforcement, real ChatGPT authentication/entitlement, paid native tools, and same-thread continuation after paid tools are unverified. Activation remains blocked, and the broker refuses sign-in when its sandbox execution probe fails. No privileged mode, additional capabilities, unconfined seccomp, or host namespaces were used to bypass the failure.

Exact installation approvals, proxy reachability requirements and each caller's login steps are in [the harness contract](../codex-harness.md#validation-and-activation-approvals). Positive permission expansion, template-instance adoption, desktop, attachments, background/group runs, and additional native tools remain deferred.

## CI follow-up

Exact initial head `0a3cb78d8bc0e295c62f9772f9074c7ca636e254` reached terminal results: [Docker validation](https://github.com/cl0ud6uru/CollectiveUI/actions/runs/38199206815) passed both jobs; [CI](https://github.com/cl0ud6uru/CollectiveUI/actions/runs/38199206849) passed four jobs and failed the settings browser fixture. The typecheck/lint/unit job's `npm test` reported 2,584 passed and 524 skipped across all configured projects.

The browser fixture had assumed zero settings requests and a disappearing Connected accounts tab. The new personal connection deliberately performs exactly one read-only status GET and keeps that tab available. The scoped fixture fix explicitly asserts that GET, permits no native mutation, and preserves all existing exact Team request/revision, stale response, and authorization assertions. It passes locally. CI now also requires the actual personal Codex connection/approval browser fixture.

The [VM readiness checklist](../personal-codex-vm-readiness.md) documents automatic ordinary command/patch execution versus native approval callbacks, the candidate-host gate and individual activation approvals. The native probe's network denial requires a reachable loopback positive control; timeout or absent RPC results cannot prove enforcement. The repeated cloud probe still exits 1 with the same namespace blocker, and no host/security setting was changed.

## Plain Node worker import correction

W4 PR183 integration head `b7728484885fd72ae1c303a032a2c292b77dae85` exposed a genuine Codex recovery defect: `node --import tsx` importing `src/lib/codex/recovery.ts` threw `This module cannot be imported from a Client Component module. It should only be used from a Server Component.` The standalone worker is a Node server, but the `server-only` package selects its throwing default export unless React server conditions are set. Existing mocked unit tests and successful queued text replies did not detect the sweeper's caught import error.

Codex recovery/dispatch and personal account/IPC modules now use Node-only dependencies rather than that React marker. A fresh plain-Node subprocess test imports the actual seven modules without mocks, React conditions, inherited secrets or database queries. Browser bundle tests require the explicit Node-only import to fail. The production worker-image smoke check now imports those same modules and invokes recovery against its empty disposable database, before testing its queued reply.

The original failure was reproduced in a detached checkout of the exact W4 head, then all seven imports passed there after applying only the scoped Codex source fix. W4's source branch and its 0056 logout migration were not modified or copied onto this branch. The personal broker also uses ordinary Node startup without React conditions.

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

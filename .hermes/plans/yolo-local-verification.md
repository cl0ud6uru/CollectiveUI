# Local + remote normal-chat session YOLO

Branch: `fix/yolo-local-and-remote-20261009`; base `330c8e1`.

## Delivered

Normal Local Hermes bot chats now expose `/yolo`, `/yolo status`, `/yolo on` and `/yolo off`. Existing remote Runs implementation remains intact. Controls derive the exact inference identity (`portal-<conversation>-<bot>`) server-side and use the existing authenticated target/binding checks, conversation ownership, owner/admin authorization, direct-chat restriction, user-run lock, idle/uncertain-stop gates and connection fingerprint pin.

Local enforcement is **controller-owned**, not native `config.set` and not a UI preference. The private Unix adapter exposes capability-gated GET/PUT `/p/<binding>/v1/sessions/<portal-session>/approval-mode`. Strict PUT accepts only a boolean `enabled`; every response identifies exact session, binding and scope. The existing client validates GET, PUT and a fresh GET. Docker/team/native workspace controls remain separate and are not enabled by this patch.

The sole local controller persists bounded per-session enabled entries in its existing protected, fsynced `bindings.json`. Old metadata defaults to an empty map. The approval RPC handler actually consumes that policy: for this owned run/session only, after cancellation and ambiguous-tool checks, an eligible `approval` offering `once` and carrying a native request identity receives `{choice: "once"}`. No profile/global configuration, environment, persistent native trust, tool permissions, sandbox or network settings are changed. Deny-only requests cannot be automatically or manually approved; protected prompts remain interactive. Metadata write failure poisons the controller and stops its owned synthetic engine instead of exposing uncertain in-memory policy as verified. Stopped controllers do not verify cached state.

Mutation and native admission share synchronous controller exclusion. Any unfinished native run, pending prompt, queued successor, startup/shutdown or settings hold rejects mutation, including an otherwise idempotent PUT. Status reads may occur during a run. The controller's portal identity remains stable across durable native resume/continuation; policy does not attach to transient runtime IDs. Fresh portal sessions default OFF.

The UI identifies the local controller as verifier. OFF explicitly means native approval policy applies; inherited native bypass settings are not changed or claimed disabled. Remote verifier wording stays unchanged.

## RPC investigation

Inspected existing LocalController NativeRpc routing and installed Hermes `tui_gateway/methods_config_set.py`, `tui_gateway/server.py` approval request/reply handling, and `tools/approval.py` guards. Native `config.set(yolo)` has a missing-session process environment fallback; the global scope writes profile approval configuration. Neither route is used here. Native hard denies run before the recoverable approval transport; this patch only replies once to that existing transport and additionally respects offered choices. The local source pin stays unchanged. No claim is made that an actual pinned Hermes provider/core was executed by the synthetic fixture.

## RED/GREEN evidence

All validation used `flock /home/hermes/.hermes/cache/scratch/collectiveui-native-validation.lock`; narrow Vitest runs used `NODE_ENV=test` and `--maxWorkers=1`. Dependencies were reused through a worktree-only symlink; shared node_modules was not installed into or modified.

1. `npm test -- --project unit tests/unit/local-hermes.test.ts -t 'persists session YOLO' --maxWorkers=1`: RED, 1 failed / 25 skipped because the client rejected Local transport. After controller/IPC/client implementation: GREEN, 1 passed / 25 skipped. The test uses actual private socket HTTP, NDJSON subprocess, durable storage and controller restart, with a deliberately synthetic native gateway.
2. `npm test -- --project unit tests/unit/hermes-yolo-command.test.ts --maxWorkers=1`: RED, 4 failed / 19 passed because Local commands were rejected. Final service tests pass and retain Docker rejection.
3. `npm test -- --project unit tests/unit/local-hermes.test.ts -t 'deny-only' --maxWorkers=1`: RED, manual once incorrectly accepted a deny-only request. Guard added before removing/answering the pending request; final suite passes.
4. `npm test -- --project unit tests/unit/hermes-yolo-status.test.ts --maxWorkers=1`: RED, 1 failed / 2 passed because Local status misleadingly named Hermes as verifier. Controller-specific status and catalog metadata added; final suite passes.

Final command:

```sh
flock /home/hermes/.hermes/cache/scratch/collectiveui-native-validation.lock sh -c 'NODE_ENV=test npm test -- --project unit tests/unit/local-hermes.test.ts tests/unit/hermes-session-approval.test.ts tests/unit/hermes-yolo-command.test.ts tests/unit/hermes-yolo-status.test.ts tests/unit/hermes-commands.test.ts tests/unit/hermes-command-route.test.ts tests/unit/hermes-provider.test.ts tests/unit/hermes-settings.test.ts tests/unit/remote-hermes-yolo.test.ts tests/unit/remote-hermes-yolo-route.test.ts --maxWorkers=1 && npm run typecheck && npm run lint -- src/local-hermes/controller.ts src/local-hermes/server.ts src/lib/llm/providers/hermes/client.ts src/lib/chat/hermes-command-service.ts src/lib/chat/hermes-commands.ts src/components/chat/session-yolo-status.tsx tests/unit/local-hermes.test.ts tests/unit/hermes-yolo-command.test.ts tests/unit/hermes-yolo-status.test.ts'
```

Exit 0: **10 files, 188 tests passed**, Next typegen + tsc passed, focused ESLint passed without warnings/errors. `git diff --check` also passed.

Evidence includes ON executing a native one-time approval without parking an AI SDK tool-approval request, OFF returning to interactive approval, a second session defaulting OFF, controller/engine restart retaining ON, mutation while another session waits returning 409, cancellation winning against a delayed RPC, ambiguous approvals never auto-approved, protected prompts remaining interactive, invalid/extra-field bodies and forged binding rejection, settings hold exclusion, stopped-runtime status refusal, and durable-write failure fail-closed. Existing Local pilot ownership/private/admin tests, native process cleanup, pending/queued settlement, remote client identity/readback/security tests, command route tests and separate native-workspace YOLO tests all pass.

An intermediate run failed solely because the new protected-prompt test supplied an invalid empty answer. Corrected the test to use its existing synthetic protected-value contract; no production workaround was added.

## Boundaries / remaining evidence

No production SQL/API, live native profile mutation, gateway/service restart, push, merge or deployment. Fixture processes and files are disposable under the configured scratch directory. No browser interaction, real PostgreSQL admission contention, production build, full test suite, actual provider inference or live pinned native approval-core run was performed. Parent owns independent review and external verification after user approval. This is real controller/IPC/stdio/SDK enforcement against a synthetic native gateway, not a claim of production runtime conformance.

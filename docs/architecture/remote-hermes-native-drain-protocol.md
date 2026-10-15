# Explicit native cancel-and-drain adapter, v1

Unpatched Hermes v0.21.5 at source
`f97608f178d1ffeca59860195ab7da295f7c8e5f` has no operation-correlated terminal
receipt. `prompt.submit` can acknowledge before deferred work dispatches;
`session.interrupt` requests cancellation without joining that work; native close
uses a bounded grace and can acknowledge while a worker remains alive. Neither
an idle snapshot nor those acknowledgements release an uncertain reservation.

This repository supplies a separate, opt-in native source adapter and strict
client contract. These methods do **not** exist in unpatched Hermes:

- `collective.recovery.capabilities`: advertises only
  `collective.cancel-drain.v1`, durable evidence and `inline_prompt_runtime` scope.
- `collective.recovery.cancel_and_drain`: accepts a caller-generated recovery UUID,
  exact runtime/stored conversation/profile binding and a unique set of prior
  prompt/queue reservation IDs. It returns a retained `pending` or `drained` receipt.
- `collective.recovery.status`: retrieves that receipt for the same native
  authentication principal, including after a lost reply.

The receipt is a cancellation barrier for the exact runtime generation; it does
not claim individual prompt acceptance or execution. It fences **all** preceding
prompt work on that generation, so the requested prior reservation IDs are bound
to the proof as a set. Commands, provider-side detached resources, deployment,
credential revocation and other runtime generations are outside this contract.
The adapter refuses compute-host isolation and sessions with slash workers.

## What makes a receipt terminal

The adapter writes the content-bound identity receipt to a private SQLite file
before it mutates native state. A unique pending-runtime constraint requires
concurrent/retried cancellation to reuse the original recovery UUID, so a second
request cannot strand a pending fence after the first drains. It serializes native RPC handlers, sets the exact
runtime's native `_closing` fence under the native registry lock, then invokes
native interruption. Native final turn-publication and queue gates reject that
closing generation. Pending close/reaper attempts cannot remove it underneath
the proof.

The adapter retains thread handles for deferred prompt roots, native turn
workers, agent builds, stopped notification pollers and explicitly patched
auto-continue/auxiliary workers. Internal turn dispatch crosses the same barrier
before native row persistence, so a late callback cannot start old work.
A terminal receipt requires **every** captured worker to have ended, no native
isolated turn or slash worker, and a successful native check for no owned live
delegations. Only then does it detach the same fenced runtime, run native teardown
and durably commit `drained`. The conversation's native history is retained and
can be resumed with a new runtime. Timeout, idle state, interrupt acknowledgement,
close acknowledgement and a missing runtime never substitute for this proof.

A crash/restart leaves persisted pending receipts with `process_changed`. It
cannot recreate evidence about old workers and refuses automatic release/new
admission for the affected profile. A profile fence is deliberately conservative:
compression may have rotated the stored conversation identity before the crash. Teardown/journal failures remain
pending. V1 deliberately has no expiry, force reset or restart inference.

Serializing native RPC handlers is a conservative performance tradeoff in this
opt-in adapter. A slow synchronous native handler delays cancellation rather than
letting cancellation claim it has drained. Detached tool resources can continue
after their originating prompt has ended; this is not a resource-kill API or a
rollback of already completed side effects.

## Installation boundary

`python scripts/install-hermes-recovery.py --hermes-source /path/to/source`
performs read-only exact-pin/clean-source validation. It checks the three exact
integration points, parses patched Python and reports an adapter digest. An
explicit `--apply` writes only the source module and those integration points,
with rollback on write failure. It does not install packages, start/restart any
service, change policy or grant authentication. Review and any actual rollout are
separate work; this change performs neither.

Contracts are declared in the optional native module itself. Upstreaming the
extension would also require regenerating upstream client/OpenRPC artifacts and
upstream acceptance. The repository's ordinary dashboard path does not call this
adapter, enable a recovery UI or clear a database reservation. The strict
TypeScript client refuses absent/version-mismatched capabilities and any receipt
with a different runtime, stored conversation, recovery UUID or reservation set.
That client is the explicit integration boundary for a later owner-scoped,
revision-checked database recovery transaction and user confirmation flow.

## Verification

`tests/fixtures/hermes-native-recovery-contract.py` first verifies that the actual
unpatched pin returns method-not-found for this capability. It archives only
tracked source into a disposable home, applies the reviewed source transformations,
and imports the actual patched native backend. Authentication is not exercised;
agent construction is synthetic, and no tools or provider inference run.
Native admission, queue, worker dispatch, interrupt and history remain real.
Python socket and subprocess guards refuse networking and non-git processes; they are fixture guards, not an OS sandbox.

```sh
HERMES_SOURCE=/path/to/clean/exact/pin \
/path/to/isolated/python -B tests/fixtures/hermes-native-recovery-contract.py
npx vitest run --project unit tests/unit/remote-hermes-recovery-protocol.test.ts
```

Use `tests/fixtures/hermes-native-requirements.txt` plus `psutil==7.2.2`.
CI requires the native fixture against the exact checked-out source. Regression
cases cover an interrupt-ignoring live worker despite an idle flag, queued prompt
cancellation, retained reply/retry, deferred build, ownership/content rebinding,
restart uncertainty, unsupported/missing/wrong runtime identities, failed receipt
writes and auxiliary worker tracking. Strict client tests reject incomplete,
foreign, inconsistent and unadvertised evidence.

This advances the native evidence gap in #90. Owner-confirmed portal recovery,
transactional revision checks, live deployment and isolated-child conformance
remain unimplemented or unverified; no current admission safety gate is relaxed.

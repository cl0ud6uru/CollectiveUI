# Personal native Remote Hermes admission recovery

Scope: personal native workspaces, not the Runs adapter. This contract keeps
server-owned native identities, ownership checks, policy locks and write-ahead
receipts. It does not change approval policy, socket authentication or deployment.

## Implemented evidence rules

- Write a content-bound receipt and reserve admission before any attachment or
  prompt RPC. Never delete that receipt during recovery. Reusing the request ID
  with the same content is a no-op; different content is rejected.
- A rejection or disconnect during image/PDF/file attachment proves that this
  invocation has not called `prompt.submit`. Release only its still-`admitting`
  reservation, conditional on its admission request ID. Clear its admission
  timestamp and retain the receipt. Best-effort image cleanup does not determine
  whether the prompt was dispatched.
- Set the dispatch flag *before* calling `prompt.submit`. After that boundary,
  only JSON-RPC method-not-found (`-32601`) proves non-dispatch. A timeout,
  disconnect, unrecognized result or other RPC error leaves admission uncertain.
  This matches the existing command and queue method-not-found treatment.
- A native running snapshot can confirm uncertain prompt admission. A subsequent
  idle snapshot can settle that confirmed turn. An idle snapshot alone cannot
  settle an `admitting` or `uncertain` operation.
- A native queued snapshot can confirm a reserved queue. After confirmation, a
  later snapshot with no queued item settles queue consumption/removal. An
  unobserved queue remains reserved even across idle snapshots, completion
  events, cache loss and browser reload.
- Both Stop and `/stop` request native interruption and then refresh state,
  including when the interrupt reply is lost. Only the ordinary fenced native
  evidence rules settle reservations. An interrupt reply is **not** a barrier
  against an older deferred dispatch. Snapshot failure marks the cached view
  uncertain and does not turn a successful interrupt into confirmed completion.
- Snapshot revision/event checks and request-ID settlement checks remain intact.
  A late acknowledgement for a consumed queue cannot replace a newer reservation.

## Remaining evidence gap — do not implement an idle/timeout reset

A crashed admission that was never confirmed, or a queue that was submitted but
never observed, can still remain reserved indefinitely. This patch intentionally
has no force-release button. The currently consumed protocol does not supply a
per-request terminal receipt or a cancel-and-drain dispatch barrier. Nothing here
proves that an old native handler cannot publish its prompt/queue after Stop or
an idle snapshot.

Closing this gap safely requires one of:

1. **Native evidence:** a persisted, operation-correlated receipt/status endpoint,
   or an acknowledged cancellation barrier that guarantees all earlier dispatches
   for the exact runtime generation have drained or been canceled. Wire the
   server-owned binding and request ID through admission; verify native semantics
   against pinned upstream source and delayed-dispatch transport tests.
2. **Explicit operator recovery:** quiesce *all* portal dispatchers/replicas and
   native clients for the binding, drain or terminate the old native runtime so
   its handlers cannot resume, inspect completed work and discard queued work
   intentionally. Only then may a reviewed, owner/binding/request-ID/revision-bound
   transaction clear reservations while retaining every receipt. Recovery must
   invalidate old runtime-generation acknowledgements/events and disclose that
   already-executed effects are not undone. A browser assertion that Stop worked
   is not this confirmation. No such operator write is implemented or authorized
   by this patch.

Until one of those contracts exists, keep the uncertain reservation, inspect
native history, and use a different conversation for new work. Do not retry the
old work under a new receipt just to bypass uncertainty.

## Regression evidence

`tests/unit/remote-hermes-reservations.test.ts` exercises the actual sessions and
hub source, with isolated RPC/database boundaries and row-lock/SQL-predicate
modeling. Coverage includes all three attachment paths, staged cleanup failure,
method-not-found, lost prompt acknowledgement and RPC 4018, reload, native running
and queue evidence, both stop shapes, lost interrupt reply, unknown queues,
concurrent reservations, stale snapshots and late acknowledgements.

The attachment, method-not-found and stop regression tests were run red before
the corresponding source changes. Restoring pre-fix `sessions.ts` afterwards
produced 11 failed tests; restoring the patch made the focused suite pass. This
is not a claim of live native-server or real PostgreSQL execution.

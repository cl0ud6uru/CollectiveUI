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
  including when the interrupt reply is lost. Reconciliation waits until the
  interrupt RPC settles, joins any older in-flight refresh (even if it fails),
  and starts a new snapshot. It never resets the single-flight slot or overlaps
  resume writes, so an older cache write cannot overwrite the fresh result.
  Only the ordinary fenced native evidence rules settle reservations. An
  interrupt reply is **not** a barrier against an older deferred dispatch.
  Snapshot failure marks the cached view uncertain and does not turn a
  successful interrupt into confirmed completion.
- Snapshot revision/event checks and request-ID settlement checks remain intact.
  A late acknowledgement for a consumed queue cannot replace a newer reservation.

## Native evidence and explicit owner-confirmed recovery

Ordinary idle snapshots, interrupts and timeouts still cannot settle unobserved
work. The separate [owner-confirmed portal path](remote-hermes-portal-recovery.md)
now consumes the [versioned cancel-and-drain adapter](remote-hermes-native-drain-protocol.md)
and [native owner fence](remote-hermes-hub-ownership.md). It writes a durable
confirmation intent before cancellation, requires exact boot/runtime/profile and
reservation evidence, promotes recovery ownership only after native workers
actually drain, then applies a revision/generation-bound transaction while
retaining every original turn receipt. Neither prompt nor protected answer is
automatically replayed.

This closes the supported native-evidence path that the initial recovery patch
lacked. It requires explicit installation of the reviewed adapters at their
supported pin; unpatched gateways do not provide those contracts. Missing,
pending, process-changed, unsupported or mismatched evidence remains blocked.
There is no general timeout reset or operator force-release transaction, and
completed external effects are not undone. Never issue the same uncertain work
under a new receipt merely to bypass the retained reservation. See the [acceptance
mapping](../validation/native-audit-acceptance.md) for the distinction between
repository conformance and deployment.

## Regression evidence

`tests/unit/remote-hermes-reservations.test.ts` exercises the actual sessions and
hub source, with isolated RPC/database boundaries and row-lock/SQL-predicate
modeling. Coverage includes all three attachment paths, staged cleanup failure,
method-not-found, lost prompt acknowledgement and RPC 4018, reload, native running
and queue evidence, both stop shapes, lost interrupt reply, unknown queues,
concurrent reservations, stale snapshots and late acknowledgements. Deferred
interrupt/concurrent-resume regressions cover Stop and `/stop`, lost interrupt
replies, older snapshot failures and fresh post-interrupt snapshot failures. The
concurrent-resume tests failed on the pre-fix branch because only two resumes
were dispatched instead of the required third, post-interrupt snapshot.

The attachment, method-not-found and stop regression tests were run red before
the corresponding source changes. Restoring pre-fix `sessions.ts` afterwards
produced 11 failed tests; restoring the patch made the focused suite pass. This
is not a claim of live native-server or real PostgreSQL execution.

## Optional native evidence adapter

The explicit, versioned [native cancel-and-drain adapter](remote-hermes-native-drain-protocol.md)
is a separate opt-in source patch against the reviewed pin. Its pending/terminal
receipt contract and strict client advance the missing native evidence layer. It
is consumed only by the explicit owner-confirmed recovery path, not by ordinary
snapshot reconciliation. The native adapter supplies evidence; the portal's
separate transaction validates and clears exact local reservations. No adapter
deployment or production recovery is performed by these repository changes.

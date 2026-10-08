# Personal remote Hermes dispatch boundary

## Ordering contract

A remote RPC linearizes at the synchronous `ws.send` invocation, not at its
remote acknowledgement. Cached reads linearize at selection/publication of the
cached value. Both operations hold PostgreSQL locks across their linearization
point:

1. `settings['remoteHermes'] FOR SHARE`;
2. the exact owned `remote_hermes_connections` identity `FOR SHARE`;
3. any caller's native-session lock, if needed.

Credential replacement already uses policy `FOR SHARE`, then the old connection
`FOR UPDATE` and deletion/cascade. A settings upsert conflicts with the policy
share lock. Consequently either dispatch/cache selection precedes the replacement
or revocation commit, or it observes the new state and rejects. A second unlocked
identity read would not provide this ordering.

`NativeHub.dispatchBoundary` invokes the synchronous action *inside* the
transaction. Its `{ value }` envelope must not be replaced with an awaited RPC
promise: that would hold locks while waiting for Hermes. `dispatchConnected`
returns `{ reply }`, allowing administration and confirmed session YOLO callers
to commit their existing transaction before awaiting acknowledgement. Such
callers acquire `hub.lockBoundary(tx)` **before** their session lock and pass `tx`
to `dispatchConnected`; they must not open a nested pool transaction or reconnect
while holding a session lock. Disconnected/changed sockets fail before send.

Operations sent before retirement may still complete remotely after the
replacement commits. They are not replayed. Later dispatches and cache reads fail
against the retired identity, even when another process still has its old socket.
Revoked private destinations retain only the existing owned active-turn recovery
allowlist on the already connected socket; reconnect and new work remain denied.
Disabled idle cache reads retain conversation visibility but use the same locked
identity boundary. Replacement still deletes only local bindings/receipts through
the existing FK cascade, not Hermes's native conversations.

## Deterministic regression fixture

`tests/unit/remote-hermes-dispatch-locks.test.ts` uses real PostgreSQL transactions,
the real replacement store/settings upsert, and a loopback WebSocket fixture. It
pauses a policy read before send/cache selection, starts a competing writer,
checks `pg_stat_activity` for an actual lock wait, then releases authorization.
Local retirement callbacks are deliberately disabled to model separate
application processes. RPC acknowledgement is withheld to prove that replacement
can commit after send without waiting for Hermes. Another test dispatches from a
caller-owned transaction with a session `FOR UPDATE` lock.

The tests opt in **only** with `REMOTE_HERMES_LOCK_TEST_URL`, reject non-loopback
hosts or a database name other than `collective_remote_lifecycle_test`, and never
fall back to `DATABASE_URL`. They recreate their fixture tables; the URL must
point to a disposable test database. Without it, these PostgreSQL tests skip.

Example disposable fixture (substitute another available PostgreSQL image if
needed):

```sh
docker run --detach --rm --name collective88-dispatch-test \
  --publish 127.0.0.1::5432 \
  --env POSTGRES_HOST_AUTH_METHOD=trust \
  --env POSTGRES_DB=collective_remote_lifecycle_test pgvector/pgvector:pg17
docker port collective88-dispatch-test 5432
# Use the reported loopback port, not a production URL.
REMOTE_HERMES_LOCK_TEST_URL=postgres://postgres@127.0.0.1:PORT/collective_remote_lifecycle_test \
  npx vitest run tests/unit/remote-hermes-dispatch-locks.test.ts --maxWorkers=1
docker stop collective88-dispatch-test
```

The policy-await replacement (dispatch/cache) and policy-revocation regressions
were executed against the previous unlocked hub/socket implementation and failed
because the competing writer committed before the linearization point. The locked
implementation passes these tests. This fixture tests actual PostgreSQL lock
contention, not a live Hermes account or a production deployment.

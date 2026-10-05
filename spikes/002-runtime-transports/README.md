# 002: runtime transports — disposable compatibility proof

## Verdict: PARTIAL

The private Codex app-server **real binary handshake** works. Protocol mapping,
approval denial, error handling and recovery boundaries work against offline
stdio child-process and real loopback WebSocket fixtures. **Hosted model
execution, SIWC subscription authorization, and upstream Responses WebSocket
access were NOT tested.** These fixtures do not establish beta/plan permission,
provider entitlement, or feature parity with the Codex application.

No production source, root package files, or spike 001 are used by this package.
Node 22 ESM, built-in `node:test`, exact `ws@8.22.0` and its own lockfile only.

## Run the proof

```sh
cd /home/hermes/collectiveui-codex-spike/spikes/002-runtime-transports
npm ci --ignore-scripts --no-audit --no-fund
npm test
node probe-app-server.mjs --help
node probe-responses-ws.mjs --help
node probe-app-server.mjs --fixture
node probe-responses-ws.mjs --fixture
# Downloaded official binary, not installed globally:
node probe-app-server.mjs --binary /home/hermes/.hermes/cache/scratch/codex-0.160.0/codex-x86_64-unknown-linux-musl
```

Observed fixture outputs:

```json
{"mode":"fixture","text":"EXACT","status":"completed","turnId":"turn1"}
{"mode":"fixture","text":"EXACT","responseId":"fixture-response","status":"completed"}
```

Observed official handshake output (host-specific userAgent):

```json
{"mode":"binary-handshake-only","initialized":true,"userAgent":"collectiveui/0.160.0 (Ubuntu 26.4.0; x86_64) unknown (collectiveui; spike)","inference":false}
```

Binary mode sends only `initialize`, waits for its result, then sends
`initialized`; shutdown is stdin EOF with a bounded kill fallback. It does not
start a thread/turn, sign in, open authentication URLs, run tools or call a model.
It creates then deletes an isolated HOME/CODEX_HOME/cwd below TMPDIR and launches
with a replacement environment containing only PATH/HOME/CODEX_HOME/TMPDIR.
No inherited tokens, global Codex config, or Hermes credential discovery.

## Verified release provenance

GitHub's official `openai/codex` latest-release endpoint returned
`rust-v0.160.0` during this experiment. The pinned release source Cargo manifest
was fetched successfully. The official Linux musl archive was downloaded into
scratch, not the repository, with SHA-256 matching the release API asset digest:

- [Release](https://github.com/openai/codex/releases/tag/rust-v0.160.0)
- [Archive](https://github.com/openai/codex/releases/download/rust-v0.160.0/codex-x86_64-unknown-linux-musl.tar.gz)
- [Source manifest](https://raw.githubusercontent.com/openai/codex/rust-v0.160.0/codex-rs/Cargo.toml)
- SHA-256: `306865417d4ee7a927785852910a527f41e1e159add390ac5ae3accb67d44a13`
- `--version`: `codex-cli 0.160.0`

The digest comparison is integrity verification against official GitHub
metadata, **not independent Sigstore signature verification**. Scratch artifacts
are disposable and may be pruned; obtain this same pinned asset again if absent.

## Protocol and safety boundaries

| Path | What the executable tests prove | What they do not prove |
|---|---|---|
| App-server stdio | JSONL requests omit `jsonrpc`; initialize ordering/clientInfo; thread/start and explicit thread/resume; turn/start; `item/agentMessage/delta`; thread/turn filtering; completed-only exact-marker assertion | Hosted inference, tool execution, authentication/provider selection |
| Approval pump | Original request ID echoed; explicit accept/decline; default deny; foreign thread/turn denied before callback; unknown requests receive -32601 and fail active turn | Full permission/MCP elicitation/tool API coverage or a user approval UI |
| App-server interruption | Explicit `turn/interrupt` threadId/turnId; interrupted completion rejected; concurrent turn submissions rejected | Real binary model cancellation or reconnect/resume semantics |
| Responses WS | Real localhost WS frames; `response.create`; per-conversation stream_id; chunk deltas; terminal completed status + exact marker; persistent socket; incremental new input + previous_response_id isolated by stream | Upstream handshake/authentication, hosted streaming, parallel multiplexing, tool call output |
| Failures/recovery | Partial-output failed/incomplete/disconnect/timeout/malformed WS frames reject; no auto-retry; tainted WS stream cannot be resubmitted; explicit fresh stream recovers without old input/ID | Recovery of server-side tool side effects, durable reconciliation, transparent replay |

Each socket belongs to one credential/account supplied at construction. Never
share a socket or continuation IDs between accounts. This deliberately small
spike supports **sequential turns only**, rejecting overlapping submissions.
Stream isolation is tested using multiple sequential conversations on one socket,
not parallel multiplexing. Unknown server requests fail closed; only command/file
approvals are supported, and they default to decline. Approval callbacks are
programmatic fixture hooks, not authorization UI. No executable tool handler.

Failure is never reported as success because partial output happened to look
correct. WS taints the failed stream and closes the socket; a fresh conversation
is an explicit caller decision, not an automatic retry. App-server has no retry
or automatic resume: reconcile server state externally, restart, initialize and
explicitly resume only when safe. A submitted turn or tool side effect may have
occurred before disconnection; this package does not replay it.

## Future live WS opt-in (NOT executed)

The CLI only reads an explicit absolute JSON file containing `access_token`.
A separately authorized SIWC experiment must supply a **new** credential. There
is no default credential path, environment token fallback, sign-in, refresh,
internal `chatgptAuthTokens` call, or secret logging. Never pass a token on the
command line. Fixture mode rejects a credential file.

```sh
# This invokes a model and requires separate authorization; not a sanity test:
node probe-responses-ws.mjs --live --credential-file /absolute/new-siwc.json --model YOUR_AUTHORIZED_MODEL
```

Live mode connects only to `wss://api.openai.com/v1/responses` using the bearer
header, sends `response.create` with `stream_id`, and omits HTTP-only
`stream`/`background`. No custom live endpoint option that might exfiltrate a
credential. CLI errors suppress raw credentials and upstream error payloads.

For a future subscription-authenticated app-server, first-party documentation
specifies a Responses provider at `https://api.openai.com/v1` with
`wire_api="responses"`, `requires_openai_auth=false`, `env_key="ACCESS_TOKEN"`
and `supports_websockets=false`; the application handles token refresh and
restart/resume. This provider path is **not implemented or exercised** here.
App-server handshake mode intentionally does not accept credentials.

## TDD evidence and constraints

Vertical slices were run red then green: missing WS transport; partial-output
failure/disconnect/timeout/malformed handling; persistent socket and stream
continuation; missing stdio client; missing turn mapper; fail-closed approvals
and process loss; stale async approval denial; missing executable CLIs; missing interrupt helper; foreign
approval scope; uncertain-stream replay guard; WS/app overlapping-turn guards.
Each green ran the full suite before the next slice. Startup-sensitive fixture
RPC timeout was raised from 100ms to 500ms after observing Node child startup
latency. Final suite after reviewed-defect corrections: **36 passed, 0 failed, 0 cancelled**.

Review corrections were also vertical red→green slices:
- Idle approvals with absent IDs: observed unsafe `accept`, then `decline` with no callback.
- Approval before `turn/start` resolves: observed unsafe `accept` for missing turnId,
  then denied missing/null/empty/non-string IDs before callback.
- Deferred approval across later turns reusing the same IDs: observed stale `accept`,
  then `decline` by captured generation identity (the per-turn rejection closure).
- Resistant real child ignores EOF and SIGTERM: observed `close deadline exceeded`,
  then verified SIGKILL exit, close resolution and readline cleanup.
- Concurrent/repeated close: observed unequal shutdown promises, then one shared promise
  during shutdown and after exit, with no leftover exit waiter.

Shutdown uses explicit EOF, SIGTERM and SIGKILL deadlines (1000ms each by default;
configurable `eofMs`, `termMs`, `killMs`). Each stage clears its timer and exit listener;
`finally` closes readline, rejects pending work and destroys stdio. If exit is not observed
by the post-SIGKILL deadline, shutdown rejects rather than waiting indefinitely.
A test-order race in the stale-approval fixture was corrected with an RPC barrier;
its corrected regression was rechecked red with generation checking removed, then green.

Tests are local protocol simulations derived from documentation, not captured
upstream traffic. The real binary exercised only handshake/EOF. Source manifest
availability is not a source audit. There is no production integration, durable
state, complete schema validation, refresh loop, hosted tool/steering proof,
benchmark or plan-entitlement claim. Recommend a separate authorized SIWC live
smoke test before any production design decision.

References:
- https://developers.openai.com/codex/app-server
- https://developers.openai.com/api/docs/guides/websocket-mode

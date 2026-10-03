# Plan: AI Portal backend / agent harness

**Status:** P0 (groundwork), P1 (provider registry with company keys), P2 (Sign in with ChatGPT) P4 (MCP tie-in), P5 (sandbox plane + workspace tools) and P6 (durable runs for every chat turn) done. Bring-your-own API keys are deferred: API keys stay admin-only for now (user decision), so the old P2 below (BYO keys) is on hold and the old P3 (Sign in with ChatGPT) shipped as P2. Next: P7 (gateway). Side track: Hermes Agent profiles as portal bots (H1 built, on durable runs since P6), see [hermes.md](./hermes.md).

**P1 as built (differences from the text below):**
- `resolveModel()` kept its P0 signature and gained attribution fields; usage is recorded per provider call by a middleware (`src/lib/llm/middleware.ts`), not at each call site.
- App credentials are bound to their row (AAD `ai_apps.api_key_enc|<id>`) already in P1; the worker re-encrypts older values at start.
- A stored credential is only reused when provider, base-URL origin, Bedrock auth/region and Vertex project are unchanged (`src/lib/llm/app-form.ts`), for saving and for Test connection.
- No feature flag: nothing changes for existing OpenAI-compatible apps (byte-identical requests, golden-tested), but the usage ledger, the instruction sections and the new dashboard maths are live immediately. Dashboard totals rise because delegates, titles, memory extraction and embeddings are now counted.
- The Vertex base-URL override is deferred (it would receive a Google access token); Bedrock endpoints must be on amazonaws.com.
- Known gap: a model step aborted mid-stream has no usage to record (SDK limitation).

**P2 as built: Sign in with ChatGPT (the plan's "P3" section, shipped without BYO keys):**
- Admin → Settings → "Sign in with ChatGPT": off by default; turning it on the first time needs an acknowledgement (who and when is recorded). Admins choose who may connect (everyone, or groups plus a list of UPNs; admins always may, to list models), which ChatGPT workspaces are allowed (empty = any workspace plan), whether personal plans (Free/Plus/Pro) are allowed, and whether routines may use their owner's plan. "Disconnect everyone" deletes and revokes every connection. Turning it off stops all use at once; connections are kept until disconnected. G1's non-empty workspace list was relaxed: personal plans are a separate, explicit switch because the requester uses ChatGPT Plus.
- Admin → Apps: provider "ChatGPT plan (each person's own)" (`credential_mode = user`, no key, endpoint or sampling settings; optional reasoning effort). Creating one needs the feature on; "List my plan's models" uses the admin's own connection (`/codex/models`).
- Settings → Connected accounts: device-code connect (code + link, polled one upstream request per call with the interval enforced server-side), status, plan usage bars from the backend's `x-codex-*` headers, Reconnect, Disconnect (revokes upstream). The chat picker shows "Your ChatGPT plan · unofficial" and a connect hint; people who aren't allowed don't see ChatGPT apps (`listAccessibleApps`/`getAccessibleApp`).
- Migration `0004_chatgpt_connections`: `user_credentials` (provider `chatgpt` only; tokens in `secret_enc` as row-bound encrypted JSON; account facts; `needs_reauth` status; plan usage) with `UNIQUE(user_id, provider)` and a partial `UNIQUE(provider, account_id, external_subject)` so one ChatGPT account maps to one portal user; `chatgpt_device_logins` (encrypted device auth id, `next_poll_at`, 15-minute expiry). No `credential_flows`/`messages.credential_id`: the credential id is on each `usage_events` row, billing source `chatgpt_plan`.
- Code: `src/lib/llm/chatgpt/` (`policy.ts` claims and admin rules, `oauth.ts` one-request sign-in calls, `store.ts` encrypted store + `getChatGPTAuth()` refresh under `SELECT … FOR UPDATE` with in-process single-flight, `device.ts` connect flow, `body.ts`/`fetch.ts`/`middleware.ts` Codex transport, `models.ts`), `providers/chatgpt.ts`, and the `resolveChatGPT` branch of `resolveModel()`: interactive purposes only (chat, group, delegate), the acting person's own connection, feature/access/account rules re-checked every turn, a fresh fetch per turn (turn-state header scoped to the turn).
- `wrapGenerate` refuses instead of aggregating the stream: ChatGPT apps are never used for titles, memory, drafts or embeddings, so no non-streaming path reaches them.
- Reasoning hygiene lives in `src/lib/agent/replay.ts` (model-bound copy only): OpenAI metadata produced by another app/model is dropped before a ChatGPT turn, and ChatGPT-produced metadata before any other endpoint. Assistant messages now record `appId` and `providerKind` in their metadata.
- Errors people can act on (connect, reconnect, plan limit with reset time, plan without Codex, sign-in service down) are typed `ChatGPTError`s, never retried by the SDK, and shown verbatim in the chat (other provider errors stay generic).
- Endpoint overrides `CHATGPT_AUTH_BASE_URL`/`CHATGPT_BACKEND_URL` exist for tests and the dev mock only and are ignored in production (a warning is logged). dev/mock-llm serves the sign-in flow (`chatgpt-auth.mjs`, rotating single-use refresh tokens) and checks Codex backend tokens.
- Hardening after an adversarial review: sealed reasoning is only replayed to the same app, model **and ChatGPT account** (`replayKey` on each reply; continued shared chats drop OpenAI metadata); a refresh without an id token keeps FedRAMP/residency; a transient refresh failure keeps using a still-valid token (30 s cooldown); a refresh reply that only rotates the refresh token still stores it; connecting re-checks the person isn't disabled; a pending sign-in is reused on start (no new OpenAI request) and only exchanged if deleting its row succeeded (cancel, "Disconnect everyone" and disabling win races); plan errors reported inside the stream and errors after an SDK retry still reach the person; delegates and group chats report a bot's failure instead of an empty or aborted reply, and people who may not use plans don't see plan bots in lists or group members.
- Differences from the plan text below: a connection in `needs_reauth` keeps its encrypted secret (so Disconnect can still revoke it upstream) instead of wiping it; refresh is driven by the access token's expiry (no 8-day proactive refresh).
- Not built yet: Codex personal access tokens, email-match check, inbox notice on `needs_reauth` (the status shows in Settings and the chat error explains it), `/wham/usage` polling (usage comes from response headers), per-model reasoning-effort clamping (admins pick the effort), the kill-switch job (the admin "Disconnect everyone" action covers it). Disabling a user revokes their connection.

**P4 as built: MCP tie-in (differences from the P4 text below):**
- Admin → MCP servers: Add or **Import** (paste a Claude Desktop / Claude Code / Cursor / Windsurf / VS Code / Gemini CLI config; JSONC accepted; stdio rejected with a reason; `npx mcp-remote <url>` unwrapped; `${VAR}` headers never filled, the portal doesn't read credentials from its environment) → drafts. **Test** lists tools as the portal (`sub: portal:system`) and stores the snapshot; **Enable** needs one. Per server: trust, identity header on/off with a portal-generated secret shown once ("New secret" rotates), result limit, timeout, per-tool on/off and "Ask first", pending-change review with **Accept changes** (the reviewed hash must still be current).
- Migration `0005_mcp`: `mcp_servers` gets `status` (backfilled from `enabled`, which is dropped), `trust`, `identity_header`, `identity_secret_enc` (row-bound AAD), `tools_snapshot`, `tools_hash`, `tools_drift` (the pending list with added/changed/removed), `server_info`, `tool_policy` (`{tool: {enabled?, requireApproval?}}`), `result_budget_kb`, `timeout_ms`, `last_tested_at`, `last_error`, with check constraints; `bot_tools.config` (`{tools?, approvals?}`) and a check on `approval` (`auto|ask|smart`). One snapshot hash instead of fingerprint + meta hash: per-tool hashes cover description, title, schemas and annotations and are computed when diffing. `server_info` replaces `initialize_result`. `sandbox_allowed` and the `tool_calls` columns come with P6/P7, where they are used.
- Code: `src/lib/mcp/` (`identity.ts`, `client.ts` transport fetch hook, `url.ts` URL check, `import.ts`, `snapshot.ts`, `hygiene.ts`, `servers.ts` refresh/accept/offered tools), `src/lib/agent/tools/mcp.ts` (tools from the snapshot), `approvals.ts` (MCP facts), worker `mcp.refresh` (pg-boss schedule, plus one run at start).
- **Lazy clients without `initialInitializeResult`:** tools are built from the snapshot and the client connects (full `initialize`) on the first tool call, then is reused for the turn. Skipping `initialize` would break stateful Streamable HTTP servers that issue their session id there, and one handshake per turn that uses the server is cheap. No session persistence across turns. Servers enabled before P4 (no snapshot yet) connect eagerly as before until the next refresh captures their first snapshot, which is accepted automatically (it is what they already exposed).
- **Drift:** our own canonical hash, not `detectToolDrift`. Changed and removed tools are hidden and new tools aren't offered until accepted; a change that goes away clears itself; drafts simply take the new list. Refresh writes happen under the row lock and are dropped if the URL changed meanwhile. Detection is audited (`mcp.drift`).
- **URL check instead of an internal-host allowlist:** only admins add servers and company MCP apps are internal, so private addresses are allowed; link-local, metadata, multicast and unspecified addresses, credentials in the URL and cleartext `http` to public addresses are refused (on save, import, Test and every connect). The transport's fetch only reaches the server's origin and never follows redirects.
- **Identity:** claims as planned minus `run` (P6); `groups` are portal group names (looked up only when a server uses identity). Changing a server's URL or transport returns it to draft, clears its tools and issues a new secret, so the old secret never reaches a new host.
- **Approvals:** precedence as planned; "Always allow" stays visible but is ignored for enforced and "Ask first" tools (as for enforced tools before). `smart` on built-in tools behaves like `auto` (sensitive ones still ask). New MCP groups default to `smart` in the bot builder.
- **Hygiene:** Unicode tags, variation selectors 17–256, bidi embeddings/overrides/isolates and zero-width spaces are stripped from descriptions (capped at 2,000 characters), input schemas and results; results are capped at the server's limit (characters) with a note; `structuredContent` is dropped when `content` exists. Tool names are made safe for model APIs and unique per turn.
- Tests: `tests/unit/{approvals,mcp-identity,mcp-import,mcp-hygiene,mcp-snapshot,toolset-lifecycle}.test.ts`, `tests/integration/mcp.test.ts` (against `dev/mcp-echo`: snapshot, zero connections before a call, identity with audience, budget, drift/accept, failures), `tests/e2e/mcp.spec.ts` (import → identity → Test → Enable → `whoami` runs as alice without asking on a trusted server → `delete_record` asks).

**P5 as built: sandbox plane + workspace tools (differences from the P5 text below):**
- **No network in P5 (user decision).** Sandboxes run with `NetworkMode: none`. Per-user /28 networks, Smokescreen egress, `ExtraHosts`, the host firewall rule and the egress allowlist move to **P7**, which needs per-user networks for the gateway anyway. **G4 for P5:** the isolation suite passes with `none` networking (it does, under runsc and runc, on Docker 29.3 with gVisor release-20260921.0). The web port can be bound to one address (`WEB_BIND`).
- **sandboxd** (`src/sandboxd/`, plain Node type stripping, **no npm dependencies**: no `ws`, no dockerode). It imports only `node:*` and its own files (ESLint override + policy guard) and never reads portal settings. HTTP + NDJSON instead of WebSocket: `start`/`out`/`err` (base64)/`hb` every 15 s/`gap`/`exit {code, reason, ms, dropped}`/`error` frames; client disconnect kills the command. Docker Engine API over the socket pinned to `/v1.44`, exec via connection hijack plus an 8-byte-header demuxer; create `Warnings` fail closed. HMAC-SHA256 over `v1\n{METHOD}\n{path?query}\n{ts}\n{nonce}\n{sha256(body)}`, ±60 s, verified before the body is parsed; only a correctly signed request uses up a nonce.
- **Isolation.** `SANDBOXD_RUNTIME=runsc` (strict, compose default) / `auto` (gVisor only if a probe container really runs under it: `uname -r` differs from the host kernel) / `runc`. Requests carry `isolation: gvisor|any`; sandboxd answers 412 instead of downgrading. The portal defaults to requiring gVisor; allowing runc needs a typed acknowledgement (who/when recorded). Start-up refuses hosts that can't enforce memory, pids or CPU limits (warns for swap) and ignores runsc configured with `--overlay2=all:*`.
- **Container spec** (`spec.ts`, pure, hashed into a label; drift recreates the container and keeps the volume): image by ID, `sleep infinity`, `Init`, user 1000, `CapDrop ALL`, `no-new-privileges`, read-only rootfs, tmpfs `/tmp`, explicit `ShmSize`, memory with `MemorySwap = Memory`, NanoCpus, `PidsLimit`, `nofile`/`fsize` ulimits, `OomScoreAdj 500`, `LogConfig none`, `RestartPolicy no`, explicit `Runtime`, env allowlist only, **one volume** `portal-home-<ref>` → `/home/agent` (created first, labelled with the instance; Codex/Claude volumes come with P8/P9). Every exec body comes from `execSpec()` (never `Privileged`, always `User 1000:1000`). Capacity limits are sandboxd's own env (`SANDBOXD_*`), not portal settings.
- **Templates** instead of free argv: `workspace-exec` (the only shell: `run-agent … -- bash --noprofile --norc -c`), `kill-run`, and `fsops read|write|list|grep|du`. Caller env goes only to the child via `run-agent --env` and is validated (no `LD_*`, `BASH_ENV`, `PATH`, `HOME`, `BASH_FUNC_*`, …). `fsops` output starts with a `PORTALFS1 <json>` header, so Docker noise is never mistaken for data; paths are confined to the workspace with `realpath` (defence in depth: the container is the boundary). `run-agent` writes a start marker before spawning (start failures become `error` frames, not exit 126), runs in its own process group, and kills it on stdin EOF (TERM, then KILL after 3 s); timeouts exit 124, signals 128+n. Output is capped in sandboxd (256 KB head and tail per stream, `output_limit` at 16 MB kills the command); a kill that doesn't end the run within 8 s kills the container.
- **Image** (`docker/sandbox/`): full `node:22-bookworm` pinned by digest, **no apt step** (the build host's network policy blocks Debian mirrors; the full image already has git, python3, procps and a C toolchain). grep is Python (`fsops grep`, Python regex) instead of ripgrep. `ENTRYPOINT []`; users `agent:1000` and `claude:1001` (`/home/claude` 0700). No Codex or Claude Code yet.
- **Portal:** `src/lib/sandbox/` (`client.ts` on `node:http` with its own agent, typed `SandboxError` with safe messages; `session.ts` `PortalWorkspace` implementing all nine `Experimental_SandboxSession` members plus argv-only `list`/`grep`, changes serialised per handle; `store.ts`; `policy.ts`; `lifecycle.ts`; `view.ts`), no `SandboxProvider` interface (sandboxd's HTTP API is the seam). One handle per turn on `AgentCtx`, shared with delegates, closed only by the toolset that created it (a delegate-only workspace belongs to that delegate call). Migration `0006_sandbox`: `sandboxes (user_id PK, ref UNIQUE random 20 chars, last_used_at, delete_after, created_at)`; status, runtime and size come from sandboxd live. Setting `sandbox` (enabled, access, groups, UPNs, allowRunc + acknowledgement, command timeout, output KB, retention days).
- **Tools and approvals:** `workspace` defaults to `auto`: read/list/grep run without asking; `workspace_write`/`workspace_edit` are sensitive (ask; "Always allow" works); `workspace_bash` is sensitive **and non-grantable** (`grantable: false` in `resolveApproval`, `grantToolForBot` refuses it, no Always allow on the card). `isHardDenied()` (a foot-gun guard, not a security control) denies in `toolApproval` so no Run card appears. Output is cleaned (hidden Unicode, `redactSecrets`) and capped inside `execute` before it is streamed or stored; failures are results, not throws. `workspace_bash` streams a throttled tail preview (preliminary outputs), always yields a final result, has a Stop button (kills by an exec id derived from the tool call id, in the person's own sandbox only) and a per-tool SDK timeout at every `streamText` site. Persisted preliminary parts count as interrupted. Delegates and group chats deny anything that needs approval, so commands never run there; granted writes do (the acting person's own choice, in their own offline workspace).
- **Approval double-submit fixed (all tools):** a continuation now records approval decisions under `SELECT … FOR UPDATE` (`updatePartsLocked`), so two tabs or a double click can't both run an approved tool (before, both requests saw "approval-requested" and both executed it).
- **UI:** command/edit/write approval cards and a live command result (`workspace-parts.tsx`); Settings → Workspace (status, isolation, size, Stop, Reset with typed confirmation); Admin → Workspaces (health banner, settings, people with Stop/Destroy, orphans). The bot builder only offers Workspace while it is on and allowed.
- **Lifecycle:** disabling a person records `delete_after` first, then stops the sandbox best-effort (audited on failure); re-enabling clears it. Worker queue `sandbox.cleanup` (hourly, `SANDBOX_CLEANUP_CRON`) destroys expired workspaces and orphans older than 1 h (sandboxes are listed before the table is read). Idle containers stop after 20 min; files persist.
- **Deployment:** `docker-compose.sandbox.yml` (an add-on file, not a profile: compose interpolates `${VAR:?}` in inactive profiles too) adds `sandboxd` (the only docker.sock holder, `group_add` the docker gid, no `env_file`, read-only, `cap_drop ALL`, `no-new-privileges`, internal `control` network) and joins web/worker to it. Dockerfile stage `sandboxd` copies only `src/sandboxd`.
- **Security review (manual; the multi-agent lenses hit the usage limit):** HMAC/replay (signature before nonce, duplicate headers rejected, the signed path is the routed path), docker.sock surface (fixed specs, validated refs and templates, instance labels checked before removing containers **and volumes**, a fix made in this pass), option injection (helpers take the next argv as the value and positional arguments after `--`; no rg or git in the auto tools), `fsops` symlink/TOCTOU (only racing commands of the same uid inside the same container, which already have that access), approval double-submit (fixed above). Known limits: workspace volumes have no size or inode quota (keep Docker's data root on its own filesystem; documented), always-allowed writes can plant files a later approved command runs (e.g. git hooks), confined to that person's offline workspace; sandboxd responses aren't signed (the control network is internal to web, worker and sandboxd).
- Tests: unit `sandboxd-protocol`, `sandbox-spec`, `sandbox-policy`, `workspace-tools`, `workspace-toolset`, `policy-guards` (sandboxd imports and secrets, one docker.sock service without `env_file`, the sandboxd image, no credential columns, bash never grantable, no runtime `@/lib/sandbox` imports in client components, sandboxd loads on plain Node); integration `sandbox-store` (concurrent refs, disable/enable, sweep, approval claim under concurrency); `npm run test:sandbox` against real Docker (lifecycle, limits, kill/abort/timeout, output limits, drift, reaper, LRU, 429, lifeline, cross-instance volumes, and the isolation suite: uid, capabilities, seccomp under runc, only `lo`, no DNS or host reachability, writable paths, no cross-sandbox access, `/home/claude` unreadable, pids/memory/fsize limits); e2e `workspace.spec.ts` (skipped without sandboxd).
- Not built (later phases): network egress and the allowlist (P7), Codex/Claude volumes and binaries (P8/P9), per-workspace disk quotas and resource alerts (P11), a workspace file browser.

**P6 as built: durable runs for every chat turn (differences from the P6 text below):**
- **Scope (user decision).** Not only runtime apps: **every direct-chat turn** (the portal loop, incl. Hermes bots) and every routine turn is a durable run executed by the **worker**. D4 is rewritten accordingly. Group chats stay in-request (they have no approvals and keep `req.signal`). Deferred to P8, with the first native runtime: `agent_requests`, `ai_apps.runtime`/`runtime_config`, the RuntimeDriver SPI and fake driver, `messages.run_id`, the `{stable, volatile}` instruction split. `@ai-sdk/harness` is not adopted (experimental, pins `ai` exactly); its pause-at-approval model matches ours, so an adapter stays easy.
- **Schema** (`0008_runs`; 0007 is Hermes): `agent_runs`, one row per assistant message (pre-allocated `message_id`), status `queued|running|waiting|succeeded|failed|cancelled|interrupted`, `segment` (an approval pause ends a segment; the answer requeues the next), `last_seq`/`boundary_seq`, `holder` + `heartbeat_at` (the lease every worker write is fenced on), `cancel_requested_at`, `resume_state` (Hermes), `legacy`; a partial unique index allows one queued/running run per conversation. `run_events(run_id, seq, segment, kind chunk|segment-end, chunk, transient)`: the UI message stream, one gap-free seq per run. `usage_events.run_id` is now filled.
- **State machine** (`src/lib/runs/state.ts`): every transition is one conditional statement (create, claim, heartbeat, fenced save, pause, finalize, requeue, cancel request); callers never write the status. Appends reserve their seq range by bumping `last_seq` in the same transaction and `pg_notify('portal_runs', {r, k})` (ids only) on commit (`log.ts`).
- **Web** (`store.ts`, routes): a new message inserts the user message and the run in one transaction (per-user advisory lock, `RUNS_PER_USER` cap on non-background runs → 429, busy conversation → 409), enqueues `agent.run`, and returns an SSE tail (`tail.ts`, `sse.ts`: pull-based over `run_events`, woken by a per-process `LISTEN` client in `listener.ts` with a 2 s poll floor, a 15 s keepalive comment). A continuation claims the decisions **and** requeues the run in one transaction (a 409 rolls the decisions back) and appends them as `tool-approval-response` chunks so a replay rebuilds `approval-responded`. `GET /api/chat/[id]/stream` (useChat `resume`) replays the whole message from seq 1 (one `start`; earlier segments' `finish`/`abort` and markers dropped), `POST /api/chat/[id]/stop` cancels queued runs at once and signals running ones; waiting runs are left (their card stays answerable). The chat route never passes `req.signal` to a run.
- **Worker** (`execute.ts`, `host.ts`, `sweeper.ts`): queue `agent.run` (one job per segment, `retryLimit 0`, `heartbeatSeconds 30`, `notify` + `useListenNotify` for instant pickup; measured 13–85 ms), `AGENT_RUN_CONCURRENCY`. The executor claims, re-runs `loadPrincipal` + `resolveTurnTarget` every segment, calls the unchanged `runTurn` with a run handle and its own `persist` (saves under the lease), pumps the stream into a coalescing writer (`events.ts`: ~100 ms / 2 KB, urgent chunks at once), then pauses or finalizes. Aborts come from the run: Stop (`cancel`), the segment timeout, worker shutdown, or a lost lease; after an abort the stream gets 3 s before it is cut. Every pause/finish first closes what the run left open (`closeOpenParts`: answered-but-unrun approvals → "Stopped before it ran.", in-flight tools → "Interrupted.", open text ended) in both the log and the saved message, so no spinner is left and a replay can't make the client auto-send a bogus continuation; a failed or interrupted reply keeps a `data-run-error` note saying why. A continuation whose setup fails fails closed (answered approvals are never re-armed). The sweeper (every 30 s on every worker, `SKIP LOCKED`) interrupts runs whose heartbeat is over 60 s old, rebuilding and saving the message from the log, re-enqueues lost queued runs (all of them on a worker's first sweep), brings routine runs in line with their agent run when a hook was lost or the conversation deleted, and deletes events of runs finished over 24 h ago. SIGTERM aborts local runs as interrupted and releases held Hermes streams; a job fetched during shutdown is enqueued again and failed; the Dockerfile `exec`s node and compose adds `init` and `stop_grace_period`.
- **Hardening from the adversarial review** (three lenses, each finding re-checked by a skeptic): a routine's first segment runs on its own queue `agent.run.bg` (`ROUTINE_RUN_CONCURRENCY`, default 2), so routines can't starve chat; the tail's queue timeout fails a run only when the database says it waited 60 s and no run anywhere is running with a fresh heartbeat (busy workers make it wait, not fail), and it also applies to routine continuations; Stop sends the id of the message the reply answers, so a Stop pressed before the run exists (its request still being handled, or a brand-new chat) waits briefly for it and stops it; the client latches `resume` on mount (a server re-render can't start a second stream) and takes back a message the server refused before saving (`unsaved: true` on 400/404/409/429), re-opening an answer's approval cards; every JSON written to Postgres (events, messages, the tool-call log) has U+0000 and lone surrogates replaced (`src/lib/jsonb.ts`), `fetch_url` refuses binary content, a batch Postgres refuses as data is dropped without losing the lease, and database errors are retried for ~30 s before a run is given up; approved tools cut off mid-run read "Stopped while it was running: it may have run." (only a queued run's say "Stopped before it ran."); copies of shared chats close their pending approvals, a run created for a message without one is only allowed for messages older than the first run (legacy), and Hermes only continues the Hermes run bound to its own portal run (held stream, saved state with its pause segment, or the legacy prompt fallback); a Stop during a continuation's setup posts no answer and stops the Hermes run; Hermes runs are stopped when a portal run ends without pausing, is stopped while queued, is interrupted by the sweeper (the run id is recorded as soon as it starts), or its conversation is deleted; an outcome known only from the run's status closes approved calls as "ran, output unavailable".
- **Behaviour changes:** Stop now really stops portal-loop turns (before, the model kept generating unseen), closing the tab no longer loses the rest of a reply, and a model error now fails the turn (routines used to report success with empty output). Routine turns run through the same executor: `routine.run` only creates the conversation and the run; the Inbox approval flow is unchanged, and the continuation's `afterRoutineTurn` now runs in the worker, exactly once.
- **Hermes:** the parked-stream registry moved into the worker (TTL, `RUN_MAX_HELD` cap); at a pause the model saves `{runId, lastEventId, MapperState}` as the run's resume state, so a continuation on a restarted (or another) worker re-attaches with `Last-Event-ID` and exact tool pairing. `interactive` is explicit (executor-run chat turns, incl. routines, which now pause into the Inbox); a new message supersedes the conversation's waiting Hermes runs (approval denied, Hermes run stopped). The single-web-instance limit is gone.
- Tests: unit `run-coalesce`, `run-replay`, `run-closing`, `run-decide`, `run-tail`, `run-sse`, `run-events`, `executor`, `run-host`, `routine-hooks`, `run-lifecycle`, `hermes-provider`, `toolset-lifecycle`, `policy-guards` (only the executor calls `runTurn`; the chat route doesn't use `req.signal` for direct chats); integration `runs-web`, `runs-exec`, `run-listener`, `hermes-live`; e2e `runs.spec.ts` (reload mid-reply, closed tab, Stop, Stop-and-send, approval across a reload) and `hermes.spec.ts` (approval answered after a reload). Manual: worker `kill -9` mid-reply → interrupted with the partial saved after ~66 s; SIGTERM → interrupted in ~3 s.

Covers model providers, bring-your-own keys, ChatGPT sign-in, the MCP tie-in, and Codex / Claude Code sandboxes.

## Context

AI Portal (this repo) is the company's web UI. Today there is one agent loop (`runTurn` in `src/lib/agent/run.ts`), and every model goes through a single OpenAI-compatible provider (`src/lib/llm.ts`). MCP servers are wired as tools using static headers.

The user wants a backend/harness where:
1. Their many existing **MCP-server apps** (Streamable HTTP, static bearer keys) just tie in to bots and agents.
2. Employees can use their **own subscriptions**: ChatGPT (Hermes-style sign-in) and Claude, via hosted Claude Code.
3. There are real **coding agents** (Codex, Claude Code) with a persistent per-user workspace.

References studied: OpenMausBot, Hermes Agent, pi, Codex app-server, Claude Code. We borrow patterns, not code; all three reference projects are single-user and local-first.

**Outcome.** A layered backend that keeps everything the portal does today:
- a provider registry with per-user credentials;
- a portal-held "Sign in with ChatGPT" connection;
- a hardened MCP client;
- Docker sandboxes;
- durable worker-run agent sessions;
- a gateway (model proxy + internal tool bridge), so Codex and Claude Code runtimes get portal tools, MCP apps, approvals and audit without secrets entering the sandbox.

### Binding decisions (user)
- **Web interface, not an MCP server product.** MCP stays client-side. The internal tool bridge is sandbox-network-only plumbing and is never public.
- **In scope:**
  - BYO API keys (OpenAI, Anthropic) plus company provider keys.
  - **Sign in with ChatGPT, Hermes-style direct:** device code with the Codex client_id, the portal stores the tokens, and it calls `chatgpt.com/backend-api/codex` inside the portal's own loop.
  - A hosted per-user **Codex** sandbox.
  - A hosted per-user **Claude Code** sandbox.
- **Sandbox use:** agents serve **both** chat/bots and coding.
- **Sandbox host:** Docker on the portal host, behind a provider interface so Kubernetes can come later.
- **Company plans:** ChatGPT Business/Enterprise, Claude Team/Enterprise, and company API keys.

### Verified constraints
- **Anthropic** ([legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance)):
  - Not allowed: offering Claude.ai login, routing through Free/Pro/Max credentials, or collecting, storing or intermediating Claude.ai tokens.
  - Allowed: the end user signs in to the **unmodified** Claude Code binary, including when a platform hosts it, under the Commercial Terms.
  - Consequence: Hermes' Claude path (claude.ai OAuth plus impersonation) is **never built**. Claude subscriptions only work through the user signing in inside the hosted binary.
- **OpenAI:**
  - The Hermes/pi ChatGPT route is an undocumented community pattern: admin-gated, off by default, labelled "unofficial".
  - Business/Enterprise workspace admins must enable device-code login.
  - Scope it to company workspace plans; block personal Plus/Pro by default, since they fall under consumer data terms.

## Target architecture

```
Browser ─ Next.js web ── /api/chat ── portal runtime: runTurn (streamText) ─ resolveModel ─ providers
   │                          │                                                 ├ openai-compatible | openai | azure
   │  SSE (resume/tail)       │ runtime apps → agent_runs → pg-boss agent.run   ├ anthropic | bedrock | vertex-anthropic
   │                          ▼                                                 └ chatgpt (user OAuth, unofficial)
   │                    worker: executeRun → RuntimeDriver (codex | claude-code) ──exec──▶ sandboxd ─docker.sock─▶ per-user container
   │                          │ run_events / agent_requests (Postgres + LISTEN/NOTIFY)                     │  (own internal network)
   └──────────────────────────┘                                                                            ├─▶ gateway:4100 (model proxy, /mcp tool bridge)
                                                                                                           └─▶ egress (Smokescreen allowlist)
MCP registry ── buildToolset ── portal loop (in-process) and gateway /mcp (bridge) ── identity JWT ──▶ user's MCP apps
```

- **D1. Model layer.**
  - `src/lib/llm/` registry: `resolveModel(app, principal, {purpose, conversationId})` returns `{model, billing, capabilities}`.
  - Credentials are always passed explicitly; SDK env-var fallbacks are forbidden.
  - The purposes `title|memory|draft|embedding` are **org-only**. `utilityApp()` never falls back to a user-credential app (today it does, at run.ts:158 and memory.ts:80).
- **D2. Credentials.**
  - `user_credentials` holds one row per user × provider.
  - Refresh happens only inside a transaction with `SELECT … FOR UPDATE`, plus in-process single-flight.
  - `user_or_org` falls back to org **only if the user has no credential**. A broken credential shows "Reconnect" and never silently switches billing.
- **D3. Runtimes are AI apps.**
  - `ai_apps.kind='runtime'`, `runtime='codex'|'claude-code'`, `runtime_config`.
  - This reuses `app_access` group gating, the target picker, `conversation.appId` and bot app selection.
  - Bots stay runtime-agnostic: their instructions and tools reach the runtime through the bridge.
- **D4. Durable runs for every direct-chat turn** (revised in P6; originally runtime apps only). Portal-loop, Hermes and routine turns run in the worker (`agent_runs`, `run_events`; `agent_requests` comes with P8's runtimes) and the browser tails or resumes them over SSE. Group chats stay in-request.
- **D5. Approval UI unchanged.**
  - A runtime approval is emitted as a normal tool part in `approval-requested`, then the SSE segment closes.
  - The existing card calls `addToolApprovalResponse`, which triggers the continuation POST.
  - The route resolves the `agent_requests` row. It is DB-authoritative; only `{approved, reason}` comes from the client.
- **D6. Gateway is its own process** (a worker-image entrypoint).
  - It is the only portal service on sandbox networks and hosts the model proxy and the tool bridge.
  - Per-run `ptl_…` tokens are stored hashed, bound to run and sandbox IP, and revoked at run end.
  - The web container never joins a sandbox network.
- **D7. Sandbox plane.**
  - `sandboxd` is the only holder of docker.sock. It builds fixed specs from enumerated profiles and templates and never accepts raw Docker JSON.
  - One container and one internal /28 network per user. Egress goes through Smokescreen.
  - gVisor (`runsc`) is used when a startup probe finds it.
  - uid 1000 `agent` runs workspace tools and Codex. uid 1001 `claude` runs Claude Code with a 0700 config volume.
- **D8. No `@ai-sdk/harness`.**
  - It is experimental.
  - harness-codex uses `codex exec`, which has no approvals.
  - harness-claude-code's subscription mode relays host OAuth tokens, which is prohibited.
  - Workspace tools still implement `Experimental_SandboxSession`, so an adapter stays possible later.

### Invariants (enforced by tests)
- **I1.** Every entry point ends in `loadPrincipal`:
  - web: `requirePrincipal` / `requireAdmin` in `src/lib/session.ts`;
  - gateway: `principalFromServiceToken()`, then `loadPrincipal`, then `getAccessibleApp` / `getAccessibleBot`, on every request;
  - worker: `loadPrincipal(run.userId)` at start and before resolving approvals.
- **I2.** Credentials, sandboxes and tool execution belong to the **acting** principal: the chatting user, or the routine owner.
- **I3.** Tool names, inputs, commands and diffs never come from the client (the `approval-merge.ts` semantics).
- **I4.** No table, column, log, env var or code path holds or relays Claude.ai credentials, and there is no Claude OAuth client code anywhere.
- **I5.** There is no silent user-to-org fallback. **I6.** Secrets use AES-GCM with a key id and AAD `'<table>.<column>|<rowId>'`, and portal tokens are stored hashed. **I7.** Background work (titles, memory, drafts, embeddings) uses org credentials only; routines run on the owner's own ChatGPT plan only when an admin turns on "Let routines use their owner's plan".

## Phases

Tracks after P0 can run in parallel: **A** P1→P2 (models; BYO keys on hold), **B** P4 (MCP), **C** P5→P9 (sandbox and runtimes). Each phase is independently mergeable, stays behind a flag or default-off setting, and ends with green `npm run typecheck`, `npm run lint` and `npm test`, plus e2e where noted.

Execution: run `npm ci` first if dependencies are not installed. Prepare each phase on a dedicated branch and run the checks before committing. Before framework-level changes, read the bundled docs in `node_modules/next/dist/docs` and `node_modules/ai/docs` (per CLAUDE.md).

### P0: Groundwork and defect fixes (no user-visible change)
- **Model seam.** `resolveModel()` in `src/lib/llm.ts` wraps today's `provider(app).chatModel()`. Switch all 7 call sites to it:
  - `run.ts:129`, `group.ts:163`, `toolset.ts:185`;
  - `memory.ts:90`, `llm.ts:67`, `bots/actions.ts:156` and `:269`.
- **Shared persistence.** New `src/lib/agent/persist.ts` `persistAssistantTurn()`: move the `run.ts` onEnd body into it, and export `logToolCalls`, `toolStatus` and `hasPendingApproval` for reuse by the worker runs.
- **MCP fixes.**
  - `run.ts`: try/catch from `buildToolset` to the stream, with `toolset.close()` on throw (fixes the client leak).
  - `toolset.ts`: call `listAccessibleMcpServers` once per build; connect in parallel with `Promise.allSettled`; warn "<server> isn't available to you" instead of skipping silently.
- **Admin fixes.** `admin/actions.ts`: pure `parseHeadersInput()` that checks `'__clear__'` before `JSON.parse` (fixes the unreachable clear branch). Apply the same to the app API key. Move `audit()` to `src/lib/audit.ts`.
- **Crypto.** `src/lib/crypto.ts` gets a keyring:
  - `ENCRYPTION_KEYS="kid:b64,…"` + `ENCRYPTION_PRIMARY_KID`; the legacy `ENCRYPTION_KEY` becomes kid `k0`;
  - format `v2.<kid>.<b64>` with AAD;
  - `encryptSecret`, `decryptSecret`, `sha256Hex`, `randomToken`;
  - refuse the dev fallback key in production;
  - worker job `crypto.rewrap` re-encrypts existing secrets, and routine webhook secrets become encrypted in place.
- **Redaction.** `src/lib/redact.ts` `redactSecrets()` covers `sk-`, `sk-ant-*`, `at-`, `ptl_`, `ghp_`, `AKIA`, JWTs and `Bearer`.
- **Versions and guards.**
  - Pin exact `ai@7.0.113`, `@ai-sdk/react@4.0.116`, `@ai-sdk/mcp@2.0.57` and `@ai-sdk/openai-compatible@3.0.55` (react hard-pins ai).
  - Remove vendor env vars from `.env.example` and warn at start if any are set.
  - ESLint rule: provider factories may only be imported under `src/lib/llm/providers/*`.
- **Mocks.**
  - `dev/mock-llm/server.mjs` adds `POST /v1/responses`, `/v1/messages` (Anthropic SSE) and `/backend-api/codex/responses`. The last one asserts the ChatGPT invariants listed under Key technical facts. All reuse the `[tool:NAME {json}]` convention, plus a `[slow]` directive.
  - `dev/mcp-echo`: annotations, a destructive `delete_record` tool, a `whoami` tool, and optional HS256 identity verification. Add it to `docker-compose.dev.yml`.
- **Tests.**
  - `mcp-headers`, `crypto-keyring` (legacy decrypt, wrong AAD, unknown kid, rewrap idempotent), `redact`, `toolset-lifecycle`.
  - **authz-coverage**: every `api/**/route.ts` and `'use server'` file calls `require*` or is in `PUBLIC_ROUTES`, which must equal the `proxy.ts` list.
  - **policy-guards**: no Claude token columns; forbidden literals (`claude.ai/oauth/authorize`, `oauth-2025-04-20`, `You are Claude Code`, `chatgptAuthTokens`, …); package denylist (`ai-sdk-provider-claude-code`, `@ai-sdk/harness-claude-code`).
  - vitest `integration` project, skipped without `DATABASE_URL`.
- **Docs.** This plan and its technical reference live in `docs/architecture/` — keep them updated as phases land.
- **Exit:** no `chatModel(` callers outside llm; the existing unit and e2e suites are green.

### P1: Provider registry with company keys
- **Dependencies** (exact pins on provider 4.0.18): `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/azure`, `@ai-sdk/amazon-bedrock`, `@ai-sdk/google-vertex`.
- **Migration `0003_providers`.**
  - `ai_apps` adds:
    - `kind` (default `'model'`);
    - `provider` (default `'openai-compatible'`; CHECK in openai-compatible|openai|azure|anthropic|bedrock|vertex-anthropic|chatgpt);
    - `provider_config jsonb`;
    - `credential_mode` (org|user|user_or_org);
    - CHECK `chatgpt ⇒ user`.
  - `base_url` becomes nullable.
  - New `usage_events` table (user, conversation, message, run, bot, app, provider_kind, model, purpose, billing_source, credential_id, tokens incl. cached, cost_micros).
  - `messages` adds `billing_source`, `provider_kind` and `app_id`.
- **Registry.** `src/lib/llm/{index,registry,resolve,billing,usage,errors}.ts` + `providers/*.ts`.
  - `PROVIDERS[kind]` = `{configSchema (zod), secretShape, create({app, secret, fetch}), listModels, testConnection, supportsEmbeddings, supportsUserKeys, speaksResponses}`.
  - `openai-compatible` stays byte-identical.
  - `openai`/`azure` use `.responses()`.
  - `anthropic` uses `createAnthropic({apiKey, baseURL?})` (Foundry via baseURL), with `cacheControl` on the stable system block.
  - `bedrock` via `createAmazonBedrock` / `@ai-sdk/amazon-bedrock/anthropic`.
  - `vertex-anthropic` via `createGoogleVertexAnthropic`.
- **Admin.** `AppInput` in `admin/actions.ts` becomes a zod discriminated union with per-kind `testAppConnection`. `apps-admin.tsx` gets a provider select and per-kind fields. Utility and embedding pickers list org apps only.
- **Usage.** `recordUsage()` covers chat, title, memory, draft and delegate. `src/lib/usage.ts` and `usage.csv` read `usage_events`, unioned with legacy rows.
- **Tests.**
  - `providers.test.ts`: each kind builds offline, and the auth header is checked with a mocked fetch.
  - Integration against mock-llm: tool call, approval, continuation over `/v1/responses` and `/v1/messages`.
  - e2e: create an Anthropic app and chat.

### On hold: BYO API keys, credential store, billing attribution (was P2; API keys stay admin-only for now)
- **Migration `0004_credentials`: `user_credentials`.**
  - Columns: `provider` (openai|anthropic|azure-openai|chatgpt), `kind` (api_key|oauth|pat), `status` (active|needs_reauth|revoked), `secret_enc`, `external_subject`, `account_id`, `account_email`, `plan_type`, `meta` (last4, fingerprint, rateLimits; never secrets), `expires_at`, `last_refresh_at`, `last_used_at`, `last_error`.
  - Constraints: `UNIQUE(user_id, provider)`; CHECK that Anthropic rows are api_key only.
  - Also `messages.credential_id`.
- **Store.** `src/lib/credentials/{store,validate,errors}.ts`:
  - `withCredentialLock()` is the only write path;
  - `saveApiKey` validates against the **fixed** vendor host (no SSRF) and **rejects `sk-ant-oat*`/`sk-ant-ort*`**;
  - summary DTOs only;
  - typed errors `CredentialMissing | CredentialNeedsReauth | ProviderDisabled | NotEntitled`.
- **Resolution.** Pure `chooseCredential(mode, userCred, orgSecret, purpose)`.
  - `api/chat/route.ts` preflight returns 409 before streaming.
  - Mid-turn typed errors become `data-notice` with a "Connect" action.
  - Entra `getGraphToken` refresh moves under `FOR UPDATE`.
- **UI.**
  - Settings gets a "Connected accounts" tab (`settings-view.tsx`) with server actions `saveProviderKey`, `testProviderKey` and `deleteProviderKey`: rate-limited, audited, write-only keys.
  - Picker badge: `company | your_key | your_chatgpt | your_claude` plus `needsConnect` (`chat/targets.ts`, `target-picker.tsx`).
  - Setting `providers.byok`.
- **Tests.**
  - Credential truth table (mode × state × purpose; acting principal).
  - Integration: lock concurrency makes one upstream call.
  - e2e `connections.spec.ts`: the key never appears in HTML, RSC or console payloads.

### P2 (was P3): Sign in with ChatGPT (direct, unofficial, admin-gated) — built, see "P2 as built" at the top
- **Gate G1.** All of these before enabling:
  - an admin types an audited acknowledgement;
  - `allowedWorkspaceIds` is non-empty;
  - the OpenAI workspace admin has enabled device-code login (`usercode` returns 404 when disabled; show that message).
- **Migration (as built: `0004_chatgpt_connections`, see "P2 as built").** Planned here as `credential_flows` (encrypted device state, `next_poll_at`, partial unique pending per user), and `UNIQUE(provider, external_subject)` so one ChatGPT account maps to one portal user.
- **Setting `providers.chatgpt`** = `{enabled:false, acknowledgement, allowedWorkspaceIds, allowedPlans (workspace plans), allowPersonalPlans:false, requireEmailMatch:true, allowBackground:false, allowPat:false, originator:'ai_portal', userAgent, clientVersion}`.
- **`src/lib/llm/chatgpt/oauth.ts`.**
  - Device flow as specified under Key technical facts. Poll through `POST /api/connections/chatgpt/poll`, one upstream call per request, with the rate enforced server-side. Never retry the code exchange.
  - Check id_token claims at connect **and on every refresh** (account allowlist, plan, email).
  - `getChatGPTAuth()` refreshes proactively (under 5 minutes to expiry, or more than 8 days since last refresh), under the lock. Permanent failures set `needs_reauth`, wipe the secret and create an Inbox item.
  - `disconnect` revokes upstream.
  - Optional Codex PAT (`at-…`) as an alternative credential kind.
  - Never import `~/.codex/auth.json`.
- **`providers/chatgpt.ts`.** `createOpenAI({name:'chatgpt', baseURL:'https://chatgpt.com/backend-api/codex', apiKey:'placeholder', fetch: chatgptFetch}).responses(model)`, wrapped by `wrapLanguageModel({middleware})`, with a new instance per turn.
  - **Middleware** (`transformParams`):
    - move system messages into `providerOptions.openai.instructions`;
    - set `store:false`, `include:['reasoning.encrypted_content']`, `forceReasoning`, `promptCacheKey=conversationId`, `parallelToolCalls`;
    - clamp `reasoningEffort` to the model's levels (never `minimal`);
    - delete `maxOutputTokens`, `temperature`, top-p/k, penalties, stop and seed;
    - `strict:false` on tools; strip `itemId`.
    - `wrapGenerate` aggregates `doStream`, because the backend is stream-only.
  - **Fetch** (`chatgpt/transport.ts`, shared with the P7 proxy):
    - headers: Bearer, `ChatGPT-Account-ID`, the portal's own honest originator and User-Agent, `session-id`/`x-client-request-id`, residency and FedRAMP headers, and `x-codex-turn-state` replayed within the turn;
    - body: allowlisted keys, typed content parts, no ids or `item_reference`;
    - 401 → refresh and retry once;
    - 429 `usage_limit_reached` → typed, non-retried error with `resets_at`.
- **Integration points.**
  - Reasoning hygiene in `prepare.ts`: drop `providerMetadata.openai` reasoning produced by a different app or model, because blobs are sealed to issuer and model.
  - A chatgpt app is never the utility or embedding app. Routines are refused unless `allowBackground`.
  - Admin model list via `/codex/models`.
  - Kill-switch job `credentials.revoke-provider`, and `user.offboard` revocation.
  - UI: a "ChatGPT (unofficial)" card with the code and link, a usage bar (`/backend-api/wham/usage`, at most once per 5 minutes), and the picker label "Your ChatGPT plan · unofficial".
- **Tests.**
  - Unit: middleware, fetch shaping and headers, 401 retry, 429 not retried, claims and allowlist, refresh classification and single-flight, wrapGenerate with `Output.object`, reasoning filter.
  - Integration against a new `dev/mock-openai-auth` plus the mock backend.
  - e2e `chatgpt.spec.ts`: a bot tool call, approval and memory write on the plan; tokens absent from the browser.

### P4: MCP tie-in for the user's existing apps (Track B, after P0) — built, see "P4 as built" at the top
- **Migration `0005_mcp`.**
  - `mcp_servers` adds `status` (draft|enabled|disabled|needs_review), `trust` (untrusted|trusted), `identity_header`, `identity_secret_enc`, `tools_snapshot`, `initialize_result`, `tools_fingerprint`, `tools_meta_hash`, `tools_drift`, `tool_policy` (`{tool:{state, approval}}`), `sandbox_allowed`, `result_budget_kb`, `timeout_ms`, `last_tested_at`, `last_error`.
  - `bot_tools.config` (`{tools?, approvals?}`).
  - `tool_calls` adds `run_id`, `source` (portal|bridge|native), `request_id`.
  - `ApprovalMode` gains `'smart'`.
- **P4a: identity, import, test-before-enable.**
  - **Identity.** `src/lib/mcp/identity.ts` mints an HS256 JWT per request via the transport `fetch` hook, alongside the existing static bearer, so existing apps keep working.
    - Claims: iss, aud=server url, sub, upn, email, name, portal groups, bot, conv, run; 60 s expiry; jti.
    - Verifier snippets go in `docs/mcp-identity.md`.
  - **Import.** `src/lib/mcp/import.ts` accepts Claude Desktop, Cursor and Claude Code `mcpServers` JSON.
    - HTTP only; stdio is rejected with a reason.
    - Internal hosts come from an allowlist; SSRF guard via `web.ts isPrivateAddress`.
    - Imported servers are saved as `draft`.
  - **Test-before-enable.** Test paginates `listTools` and stores the snapshot and hashes; Enable requires a snapshot.
- **P4b: lazy clients, drift, approvals, hygiene.**
  - **Lazy clients.** `createMCPClient({…, initialInitializeResult})` + `toolsFromDefinitions(snapshot)`, so a turn that calls no MCP tool makes zero connections. Session ids persist per conversation and server.
  - **Drift.** Hourly `mcp.refresh` job runs `detectToolDrift` plus our own hash of annotations and outputSchema (fingerprintTools skips those). A changed tool puts the server in `needs_review`; the tool stays hidden until an admin accepts it.
  - **Approvals.** `approvals.ts` stays pure and gains `annotations`, `trust`, `adminToolPolicy` and `botToolOverride`. Precedence:
    1. admin disabled → denied;
    2. enforced → ask, grants ignored, "Always allow" hidden;
    3. bot override;
    4. group mode. `smart` = auto only when the server is trusted and the tool has `readOnlyHint`; otherwise ask.
  - **Hygiene.** Strip Unicode TAG and bidi characters from descriptions and results; enforce the result budget.
  - **Bot builder.** Per-tool allowlist and approvals, built from the snapshot.
- **Tests.**
  - Precedence table.
  - identity, import and drift (a description or annotation change hides the tool).
  - lazy (zero connections).
  - e2e: import mcp-echo → test → enable; `whoami` returns `alice`; `delete_record` prompts under smart.

### P5: Sandbox plane + workspace tools for portal bots (first coding capability, any model) — built, see "P5 as built" at the top
- **Gate G4.** The isolation suite passes on the target host. The host firewall drops `10.200.0.0/16` → host, and the web port is bound to a specific IP.
- **Compose (profile `sandbox`).**
  - `sandboxd` is the only service with docker.sock; network `control` only; no DB and no keys.
  - `egress` runs `stripe/smokescreen`.
  - `gateway` is a skeleton for now.
- **`src/sandboxd/`** (node:http + ws, dockerode).
  - Every request carries an HMAC over (method, path, ts, body hash) with `SANDBOXD_SECRET`, plus a nonce cache.
  - API: ensure, exec (WebSocket stdio frames), kill-run, confined file get/put, stop, destroy, list.
  - Callers pass only an enumerated profile and argv **templates** (`workspace-exec`, `codex-app-server`, `claude-stream`, `claude-login`, `claude-auth-status`, `kill-run`).
  - A reaper stops idle containers (20 min) and enforces a `maxRunning` LRU.
- **Networking.** Each user gets an internal network `portal-sbx-<h>` with a /28 from `10.200.0.0/16`.
  - Egress sits at `.2` and the gateway at `.3`; both are attached only while the sandbox runs. The sandbox is at `.10`.
  - `ExtraHosts` are required because Docker's embedded DNS doesn't work under gVisor.
- **Container spec** (a pure `spec.ts`):
  - pinned image digest; `sleep infinity`; `Init`; `User 1000`;
  - `CapDrop ALL`, `no-new-privileges`, `ReadonlyRootfs`, tmpfs `/tmp` and `/run/portal`;
  - memory, CPU and pids limits;
  - volumes `portal-ws-<h>`→`/home/agent/workspace`, `portal-codex-<h>`→`/home/agent/.codex`, `portal-claude-<h>`→`/home/claude` (0700, uid 1001);
  - `Runtime runsc` when the probe finds it;
  - proxy env + `NODE_USE_ENV_PROXY=1` + `DISABLE_AUTOUPDATER=1`, and **no secrets**.
- **Image `docker/sandbox/Dockerfile`.**
  - Base: debian-slim with node ≥22.21, git, ripgrep, python3, jq, tini.
  - Users `agent:1000` and `claude:1001`; the workspace is setgid.
  - Pinned `@openai/codex` and `@anthropic-ai/claude-code`, installed unmodified, with checksums verified.
  - `/opt/portal/run-agent` (setsid, pidfile, kills the process group on stdin EOF) and `kill-run`.
- **Egress.** Smokescreen denies private IPs. The allowlist comes from `settings.sandbox.egressAllowlist` and is **empty by default**.
- **Portal side.**
  - Migration `0006_sandbox`: `sandboxes` table (status, network, IP, image digest, isolation, `claude_login_state`, email hash). **No credential columns.**
  - `src/lib/sandbox/{provider,sandboxd-client,session}.ts`: `SandboxProvider` interface, and `createSandboxSession(principal)` implementing `Experimental_SandboxSession`.
  - The exec relay handles demux, end/error wiring, JSONL framing and an 8 MB cap, and cancels through `kill-run`.
  - `src/lib/agent/tools/workspace.ts` adds `workspace_bash`, `workspace_write` and `workspace_edit` (all sensitive), plus `workspace_read`, `workspace_list` and `workspace_grep`. They take the sandbox via `experimental_sandbox`, cap output, apply redaction and use a shared `isHardDenied()` blocklist.
  - `BUILTIN_TOOLS` gains `workspace` (default ask). Setting `runtimes.sandbox` (enabled, groups, limits, gvisor).
  - UI: command and diff approval card in `tool-part.tsx`; Settings "Workspace" tab (status, stop, reset); `admin/sandboxes` page (list, stop, destroy; no file access).
  - `user.offboard` stops the sandbox and schedules volume deletion.
- **Tests.**
  - `sandbox-spec`: every hardening field present; no binds, socket or ports.
  - `sandboxd-auth`: HMAC, replay, templates.
  - `npm run test:sandbox` (Docker host) isolation suite. From inside a sandbox: db, web, sandboxd, **another user's sandbox**, the host and metadata IPs are unreachable; DNS fails; an allowlisted host passes via egress; uid 1000 cannot read `/home/claude`.
  - e2e: user B on A's bot runs in B's sandbox.

### P6: Durable runs, runtime SPI, runtime apps (merged dark with a fake driver) — built for every chat turn, see "P6 as built" at the top; SPI and runtime apps moved to P8
- **Migration `0007_runs`** (built as `0008_runs`, without the runtime columns and `agent_requests`).**
  - `ai_apps.runtime` and `runtime_config`.
  - `agent_runs`: acting `user_id`, status (queued|running|waiting|succeeded|failed|cancelled|interrupted), `message_id`, `last_seq`, `boundary_seq`, `resume_state`, `billing_source`, `usage`, heartbeat, `cancel_requested_at`. Partial unique active run per conversation.
  - `run_events(run_id, seq, segment, chunk)`.
  - `agent_requests`: id = UI approvalId, `kind`, `tool_name`, `native_ref`, `payload` + `payload_hash`, `status`, `scope`, `expires_at`, `decided_by`.
  - `messages.run_id`.
- **SPI** (`src/lib/runtimes/types.ts`).
  - `RuntimeDriver.runTurn(input, io)`, where `input` = principal, app, bot, `instructions:{stable, volatile}`, `resumeState`, gateway url and token, signal; and `io` = `write(UIMessageChunk)`, `requestApproval`, `notice`.
  - `RuntimeCapabilities` drive the UI. The `fake` driver is dev/test only.
- **Instructions.** `buildInstructionParts() → {stable, volatile}`: memories, date and the headless note are volatile. This keeps native sessions and prompt caching stable.
- **`src/lib/runs/`.**
  - `appendEvents` coalesces deltas (~100 ms / 2 KB) and runs `pg_notify` with ids only in the same transaction.
  - `listener.ts`: a dedicated `pg.Client` with heartbeat, reconnect with a new client plus catch-up, and a 2 s poll floor.
  - `tail.ts`: `replayMessage` (the whole message from seq 1 with one `start`) and `tailSegment(afterSeq)`, with a 15 s heartbeat.
  - `approvals.ts` `requestApproval`, in order: hard-deny → `resolveApproval` (grants, enforcement) → headless deny → insert a row with a 30-minute TTL → emit `tool-approval-request` after `tool-input-available` → persist the snapshot → close the segment → set `waiting` → await NOTIFY or expiry → `assertPayloadMatches`. Close the segment only when the other tool parts are terminal.
  - `execute.ts`: `loadPrincipal` + ACL + credential, then driver, then `appendEvents` + `readUIMessageStream` snapshot, then `persistAssistantTurn` at boundaries and at the end, then `logToolCalls(source:'native')`, `recordUsage`, memory extraction and `afterRoutineTurn`, with a cancel watcher.
- **Worker.**
  - Queue `agent.run`: `expireInSeconds` 4 h, `heartbeatSeconds` 30, `retryLimit` 0.
  - `localConcurrency` from `AGENT_RUN_CONCURRENCY`; per-user cap `RUNS_PER_USER`=2, checked at POST (409).
  - Stale-heartbeat sweeper marks runs `interrupted`. `run_events` GC after 24 h.
- **Routes.**
  - `api/chat/route.ts` for runtime apps:
    - new message → insert, pre-allocate `assistantMessageId`, create run, enqueue, return `tailSegment(run, 0)`;
    - continuation → an `UPDATE agent_requests … WHERE id AND user AND conversation AND pending AND not expired RETURNING`, then `applyApprovalDecisions` on the snapshot, "Always allow" via the existing grant, NOTIFY, and `tailSegment(boundary)`. Expired → 409;
    - regenerate/edit → 400 while `branching='none'`.
  - `GET api/chat/[id]/stream` (the useChat `resume` endpoint): owner check; `replayMessage` while active, otherwise 204.
  - `POST api/chat/[id]/stop`.
  - `chat.tsx`: `resume` when an active run exists; `prepareReconnectToStreamRequest`; the stop button calls stop; edit/regenerate hidden by capability.
- **Exclusions and docs.** Runtime-app bots are excluded from group members and delegate lists. Document the reverse-proxy settings: buffering off, `proxy_read_timeout` ≥ 75 s. `maxDuration` does nothing when self-hosted.
- **Tests.** tail (no duplicate start, no orphan text-delta), `agent-requests` (IDOR no-op, idempotent, expiry, altered input ignored), `execute-run` (fake). e2e with the fake driver: approve/deny through the unchanged card, reload mid-run, stop, worker-kill sweep.

### P7: Gateway: service tokens, model proxy, tool bridge
- **Also from P5 (deferred there):** per-user internal networks (`portal-sbx-<h>`, a /28 from `10.200.0.0/16`, egress at `.2`, gateway at `.3`, sandbox at `.10`, `ExtraHosts` for gVisor), Smokescreen egress with `settings.sandbox.egressAllowlist` (empty by default), the host firewall rule and the network half of the isolation suite (another sandbox, db, web and sandboxd unreachable through the new network; an allowlisted host passes via egress). Until then sandboxes stay on `NetworkMode: none`.
- **Migration `0009_gateway` (was 0008): `service_tokens`** (hash, prefix, scopes, user, run, sandbox, app, bot, conversation, `bound_ip`, expiry, revoked).
  - `src/lib/tokens.ts` issues and verifies tokens: scope, expiry, run status, and `remoteAddress === bound_ip`.
  - `src/lib/auth/service-principal.ts` `principalFromServiceToken`.
- **Gateway process.** `src/gateway/index.ts` on :4100, bound to sandbox interfaces only. Body limits, rate limits, redacted logs. Compose service.
- **Model proxy.**
  - `POST /v1/responses` (Codex) routes by the model app's kind:
    - openai/azure/compatible with the org or BYO key;
    - chatgpt with the user's token + **`ChatGPT-Account-ID`** (Codex never sends it for custom providers), through the shared `chatgpt/transport.ts`.
    - Session and turn-state headers are relayed; the body is forwarded byte-for-byte; 401 → refresh and retry.
    - Usage from `response.completed` → `usage_events`.
  - `GET /v1/models`.
  - `POST /anthropic/v1/messages` (+ `count_tokens`) for Claude Code in BYO/company mode:
    - verify the run token, inject `x-api-key`, forward `anthropic-version`/`anthropic-beta` verbatim;
    - unbuffered SSE with pings;
    - **403 + alert `policy.claude_token_seen`** if a non-portal credential (e.g. `sk-ant-oat`) or an OAuth beta flag arrives.
- **Tool bridge.**
  - Move `@modelcontextprotocol/sdk` to dependencies. Stateless `StreamableHTTPServerTransport` at `POST /mcp`.
  - Toolset: `buildToolset({…, surface:'bridge'})`, excluding workspace tools and registry servers without `sandbox_allowed`.
  - `tools/call` → `authorizeCall`:
    - auto → run;
    - approval needed → consume a matching pre-approved request (Claude) or block on `requestApproval` with 30 s progress notifications (Codex);
    - headless → deny.
  - Results get budget + redaction; `tool_calls` rows use `source:'bridge'`.
  - Downstream MCP calls carry the **chatting user's** identity JWT. Static secrets never leave the gateway.
- **Worker.** ensure sandbox → attach gateway/egress → `issueRunToken(bound_ip)`, passed only in the per-exec env.
- **Tests.** service-tokens (scope, expiry, revoked, IP, disabled user, lost bot access), the model-proxy matrix (upstream never sees the sandbox token; oat rejected), bridge (approve/deny/consume/headless), gateway coverage.

### P8: Codex runtime (thin slice)
- **Decision (2026-09, after studying OpenClaw's Codex harness): the Codex app-server is for the coding runtime only.**
  - Chat on ChatGPT plans stays on the portal's own loop (P2), which keeps bots, memory, approvals, group chats, MCP and the usage ledger. OpenClaw's default instead hands ChatGPT-plan turns to a per-agent `codex app-server` (Codex owns the history, OpenClaw's tools become experimental dynamic tools). That fits OpenClaw's single trust domain, not a multi-user portal.
  - **No ChatGPT token ever enters a sandbox.** OpenClaw feeds the live access token in with `account/login/start {type:"chatgptAuthTokens"}` (Codex labels it "[UNSTABLE] FOR OPENAI INTERNAL USE ONLY") and answers `account/chatgptAuthTokens/refresh`. Here Codex talks to the portal gateway with a run token; the gateway attaches the person's own token from the P2 store (`getChatGPTAuth`, refreshed under the row lock) plus the account/residency/FedRAMP headers, and validates every request by run, thread, turn and model (OpenClaw's loopback relay does the same checks). This is also the shape of OpenClaw's SIWC path.
  - **Adopted from OpenClaw:** exact binary pin plus a minimum version; isolated `CODEX_HOME` with `cli_auth_credentials_store="ephemeral"` and a scrubbed env (no `OPENAI_API_KEY`, `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`); `initialize` with `optOutNotificationMethods` for events the portal ignores; decline every server request without a handler; approvals mapped to allow-once / allow-for-session; usage limits from `codexErrorInfo` plus the rate-limit reset time; Codex owns the thread history and the portal keeps a transcript mirror.
  - **Portal tools reach Codex over the MCP bridge** (stable, shared with Claude Code in P9). Dynamic tools (`thread/start.dynamicTools` + `item/tool/call`, experimental) are deferred. The app-server runs inside the sandbox; OpenClaw's preview "app-server on the host, execution via `environment/add`" layout is not used.
  - Sources: OpenClaw `extensions/codex` at commit 169da002 (e.g. `src/app-server/version.ts`, `transport-stdio.ts`, `docs/plugins/codex-harness*.md`) and the Codex app-server protocol at commit 4193f1a; details in [backend-harness-reference.md](./backend-harness-reference.md#openclaws-codex-harness-for-comparison).
- **Gate G2.** G1 for ChatGPT billing, plus a spike showing the backend accepts proxied Codex requests with the portal originator.
- **Image config** (root-owned). `/etc/codex/config.toml`:
  - `model_provider="portal"`, `cli_auth_credentials_store="ephemeral"`, `forced_login_method="api"`, analytics off;
  - `[model_providers.portal]`: `base_url="http://portal-gw:4100/v1"`, `wire_api="responses"`, `env_key="PORTAL_RUN_TOKEN"`, `requires_openai_auth=false`;
  - `[mcp_servers.portal]`: `url=".../mcp"`, `bearer_token_env_var`, `default_tools_approval_mode="approve"` (the portal enforces), `tool_timeout_sec=1800`, `required=true`;
  - `shell_environment_policy.exclude=["PORTAL_*"]`.
  - `/etc/codex/requirements.toml` pins the provider, providers, MCP allowlist and login method. The agent has a shell, so pinning is required.
- **Driver** (`src/lib/runtimes/codex/`).
  - `rpc.ts`: JSONL without the `jsonrpc` field; retry on -32001.
  - `protocol/`: generated by `codex app-server generate-ts --experimental` from the pinned binary and committed.
  - Per turn:
    1. exec `run-agent -- codex app-server --strict-config` as uid 1000;
    2. `initialize` + the `initialized` notification;
    3. `thread/resume` or `thread/start {cwd:/home/agent/workspace, modelProvider:'portal', approvalPolicy:'untrusted'|'on-request', sandbox:'danger-full-access', developerInstructions: stable}`. The container is the boundary, because bwrap can't create namespaces in Docker;
    4. `turn/start {input:[text (volatile + user), localImage…]}`;
    5. stop → `turn/interrupt`, with `kill-run` as fallback.
  - A new thread is created when the toolset or instruction hash changes.
- **Approvals.**
  - `commandExecution` → `bash`; `fileChange` → `apply_patch`; `permissions` → turn scope. Decisions are `accept`/`decline`.
  - "Always allow" → `tool_grants`, and the portal auto-accepts later requests.
  - Elicitation, `requestUserInput`, `tool/call` and `chatgptAuthTokens/refresh` are declined and audited (fail closed).
- **Mapper** (pure).
  - agentMessage → text; reasoning summary → reasoning.
  - commandExecution → dynamic providerExecuted `bash` with preliminary output; fileChange → `apply_patch`; portal `mcpToolCall` → the original tool name.
  - `turn/plan/updated` → `data-plan`; `turn/diff/updated` → `data-diff`.
  - Usage from `thread/tokenUsage/updated`.
  - Errors mapped: usageLimitExceeded, unauthorized, contextWindowExceeded.
- **UI.** bash/apply_patch labels, plan checklist, diff panel, status chip, preflight notices, and a portal-side rate-limit display.
- **Ops.** Register `clientInfo.name='ai_portal'` with OpenAI for Enterprise Compliance Logs.
- **Tests.** Mapper against recorded fixtures; config (no secrets, pins); driver against `dev/fake-runtimes/codex-app-server.mjs`; sandbox test with real Codex against mock-llm through the gateway (no auth.json in `CODEX_HOME`); e2e with the fake.

### P9: Claude Code runtime (unmodified binary)
- **Gate G3.** An admin records attestations with `{by, at, reference}`, all audited:
  - Commercial Terms accepted → enables `authMode:'byo_key'` (the user's own Console key via the proxy).
  - `subscription` requires **written Anthropic confirmation** that covers portal-driven `-p stream-json`, the sign-in relay, and credentials persisting on portal volumes.
  - `company` key requires separate confirmation.
- **Naming.** "Coding agent (runs Claude Code)". No Anthropic names or logos in feature names.
- **Image.** `/etc/claude-code/managed-settings.json`:
  - pinned `requiredMinimumVersion` = `requiredMaximumVersion`;
  - `allowManagedHooksOnly`, `disableClaudeAiConnectors`, `disableBypassPermissionsMode`;
  - deny Read/Edit of `/home/claude/.claude/**`;
  - env `DISABLE_AUTOUPDATER`, `DISABLE_UPDATES`, `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`.
  - **Not shipped:** `forceLoginMethod`/`forceLoginOrgUUID` (they block API-key auth), and `managed-mcp.json` (it breaks `--mcp-config`).
- **Driver** (`src/lib/runtimes/claude/`). Exec as uid **1001** with `CLAUDE_CONFIG_DIR=/home/claude/.claude`:
  `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-prompt-tool stdio --permission-mode default --strict-mcp-config --mcp-config /run/portal/<run>/mcp.json --setting-sources user --append-system-prompt-file … --model … --max-turns … (--session-id|--resume) --allowedTools "mcp__portal__<auto tools>"`.
  - Env per mode:
    - `byo_key`/`company`: `ANTHROPIC_BASE_URL=http://portal-gw:4100/anthropic` + `ANTHROPIC_AUTH_TOKEN=$PORTAL_RUN_TOKEN`;
    - `subscription`: **hard-fail if any `ANTHROPIC_*` / `CLAUDE_CODE_USE_*` / `CLAUDE_CODE_OAUTH_TOKEN` is set**. A base URL would leak the subscription credential to our proxy.
  - Protocol:
    - write the `initialize` control_request, then the user line;
    - **keep stdin open until `result`** (closing it cancels pending prompts);
    - `control_request can_use_tool` → `requestApproval` → `control_response {behavior:'allow', updatedInput} | {behavior:'deny', message}`, idempotent per `request_id`;
    - tools that need approval are left out of `--allowedTools`, so they get approved via `can_use_tool` before the bridge call;
    - stop → the `interrupt` control request, else SIGINT.
- **Mapper.**
  - `system/init` → session id; fail the run if the portal MCP server isn't connected.
  - `stream_event` deltas → text, reasoning and tool-input.
  - Tool names: `Bash→bash`, `Read/Write/Edit`, `WebFetch→fetch_url`, `TodoWrite→data-plan`, `Task→subagent`, `mcp__portal__X→X`.
  - `result` → usage. `subscription` billing is recorded as `user_plan`, with company cost 0.
- **Subscription sign-in (after G3).** A TTY exec of **only** `claude auth login` as uid 1001, relayed as a dumb byte pipe: browser xterm.js ↔ SSE (output) + POST (input) route ↔ sandboxd WS. App Router has no WebSockets.
  - No logging or pattern-matching; 15-minute TTL; one flow per user.
  - `claude auth status` (JSON) → `sandboxes.claude_login_state`; an email hash seen on another user triggers a warning.
  - `logout`; re-auth card.
  - Egress to `api.anthropic.com`, `claude.ai` and `platform.claude.com` is added only when subscription mode is enabled.
- **Tests.**
  - args: subscription has zero `ANTHROPIC_*`; stdin stays open.
  - mapper fixtures; control protocol (idempotency, expiry deny, interrupt).
  - BYO test against mock `/v1/messages` through the gateway.
  - subscription compliance: the gateway receives zero model calls, and `/home/claude` is unreadable by uid 1000 and by sandboxd file APIs.

### P10: Breadth (each item independently mergeable)
- **Branching:** `runtime_checkpoints`. Codex uses `thread/fork {lastTurnId}` (`thread/rollback` no longer exists). Claude forks every turn with `--resume --fork-session`. Workspace files are shared across branches; optional git checkpoints.
- **Routines on runtimes:** Inbox-wait approvals or an explicit full-auto preset. ChatGPT or subscription billing in routines is off unless an admin allows it.
- **Runtime bots:** as delegates (ephemeral, approvals denied) and as group speakers (off by default).
- **Codex `turn/steer`.**
- **Egress and access:** per-profile or per-bot egress; a general web terminal (uid 1000).
- **Workspace content:** attachments into the workspace; skills as SKILL.md.
- **Budgets** per user and billing source.
- **Infrastructure:** the portal loop on durable runs; a KubernetesBackend; git credentials via a gateway credential helper; ES256 + JWKS identity.
- **Pending confirmations:** company-key Claude Code and a structured login relay, once Anthropic confirms.

### P11: Operational hardening
- Least-privilege Postgres roles, and an append-only audit log.
- Retention jobs (run_events, expired chatgpt_device_logins, service_tokens, egress logs).
- Alerts: needs_reauth spikes, token IP mismatch, egress denial bursts, `policy.claude_token_seen`, MCP drift, sandboxes on runc.
- Volume soft quotas; a key-rotation drill.
- An image rebuild pipeline: pins, checksums, SBOM, re-recorded fixtures, regenerated Codex types.
- A pen test: sandbox escape, token replay, IDOR, SSRF, log leakage.

## Schema summary

| Migration | Phase | Contents |
|---|---|---|
| 0003_providers | P1 | ai_apps kind/provider/provider_config/credential_mode, base_url nullable; usage_events; messages billing_source/provider_kind/app_id |
| 0004_chatgpt_connections | P2 (built) | user_credentials (chatgpt only; unique (user, provider) and (provider, account, subject)); chatgpt_device_logins |
| later | BYO keys (on hold) | user_credentials gains api_key rows (Anthropic = api_key only) |
| 0005_mcp | P4 (built) | mcp_servers status (replaces enabled)/trust/identity/snapshot/hash/drift/server_info/policy/limits/last test; bot_tools.config + approval check |
| later | P6/P7 | mcp_servers.sandbox_allowed; tool_calls run_id/source/request_id |
| 0006_sandbox | P5 | sandboxes (no credential columns) |
| 0007_hermes | Hermes H1 | ai_apps provider/base_url checks include hermes |
| 0008_runs | P6 (built) | agent_runs; run_events |
| later | P8 | ai_apps runtime/runtime_config; agent_requests; messages.run_id |
| 0009_gateway | P7 | service_tokens |
| 0010_checkpoints | P10 | runtime_checkpoints |

All come from `src/db/schema.ts`, then `npm run db:generate`, then `npm run db:migrate`.

## Existing code to reuse
- `runTurn`, `hasPendingApproval` and `logToolCalls` (`src/lib/agent/run.ts`).
- `buildToolset` and delegate entries (`toolset.ts`).
- Pure `resolveApproval` (`approvals.ts`).
- `applyApprovalDecisions` / `decisionsFromClientParts` (`approval-merge.ts`).
- `insertMessage`, `updateMessageParts` and `setCurrentLeaf` (`src/lib/chat/store.ts`).
- `afterRoutineTurn` and the Inbox (`routine-runner.ts`).
- `scheduleMemoryExtraction` and pg-boss (`src/lib/jobs.ts`).
- `loadPrincipal`, `getAccessibleApp` / `getAccessibleBot` / `listAccessibleMcpServers` (`authz.ts`, `lib/auth/groups.ts`).
- `requirePrincipal` (`session.ts`).
- `isPrivateAddress` (the SSRF guard in `tools/web.ts`).
- `getGraphToken` refresh pattern (`lib/auth/entra.ts`).
- The `m365_send_mail` draft card pattern (`tool-part.tsx`).
- `toolApprovalSecret` (`crypto.ts`).
- The `dev/mock-llm` `[tool:…]` convention and the `dev/mcp-echo` server.

## Key technical facts (verified against primary sources; full list in [backend-harness-reference.md](./backend-harness-reference.md))

- **ChatGPT auth.**
  - Client `app_EMoamEEZ73f0CkXaXp7hrann`, issuer `https://auth.openai.com`.
  - `POST /api/accounts/deviceauth/usercode {client_id}` → `{device_auth_id, user_code, interval (string)}`.
  - Poll `POST /api/accounts/deviceauth/token {device_auth_id, user_code}`: 403/404 means pending; 2xx returns `{authorization_code, code_verifier}`.
  - Exchange: `POST /oauth/token` (form) with `grant_type=authorization_code, code, redirect_uri=https://auth.openai.com/deviceauth/callback, client_id, code_verifier`.
  - User page `https://auth.openai.com/codex/device`; 15-minute expiry.
  - Refresh: `grant_type=refresh_token`. Tokens are single-use and rotating, and reuse revokes the whole family.
  - Revoke: `POST /oauth/revoke`.
  - Claims under `https://api.openai.com/auth`: `chatgpt_account_id`, `chatgpt_plan_type`, `chatgpt_user_id`, `chatgpt_account_is_fedramp`, `chatgpt_data_residency`.
  - PAT check: `GET /api/accounts/v1/user-auth-credential/whoami`.
  - Sources: codex-rs login, pi openai-codex.ts, Hermes auth_codex.py.
- **ChatGPT inference.**
  - `POST https://chatgpt.com/backend-api/codex/responses`: SSE only; `store:false`; non-empty `instructions`; no `max_output_tokens`; typed content parts; strip ids.
  - Encrypted reasoning is sealed to its issuer and model.
  - Models: `GET /backend-api/codex/models?client_version=`. Usage: `GET /backend-api/wham/usage`.
  - 429 `usage_limit_reached {resets_at}` / `usage_not_included`.
  - `@ai-sdk/openai` `createOpenAI({baseURL,fetch}).responses()` posts to `${baseURL}/responses`. Native options: `instructions`, `store`, `include`, `forceReasoning`, `promptCacheKey`, `reasoningEffort`. The SDK always sends `max_output_tokens`, so the middleware strips it.
- **AI SDK v7.**
  - `useChat({resume})` → `GET ${api}/${id}/stream`; 204 means nothing to resume. The client rebuilds the message from `start`.
  - `addToolApprovalResponse` only sends when not streaming, which is why segments close.
  - Chunks: `tool-input-available{dynamic, providerExecuted}`, `tool-approval-request{approvalId, toolCallId}`, `tool-output-available{preliminary}`, `tool-output-denied`, `data-*`.
  - `fingerprintTools` ignores annotations and outputSchema.
  - `toolsFromDefinitions` is synchronous. `Experimental_SandboxSession` reaches tools as `experimental_sandbox`.
  - Errors thrown from a custom fetch are not retried.
- **Codex app-server (0.156.x).**
  - JSONL without the `jsonrpc` field; `initialize` then `initialized`.
  - Thread methods: `thread/start|resume|fork`; `thread/rollback` is removed.
  - Approvals: `item/commandExecution|fileChange|permissions/requestApproval`, plus MCP approvals via `mcpServer/elicitation/request`.
  - Usage only in `thread/tokenUsage/updated`.
  - A custom provider sends only a Bearer token and no ChatGPT-Account-ID; `wire_api="responses"`.
  - `approval_policy="never"` denies MCP calls that need approval.
  - No SSE MCP transport.
  - The Linux sandbox needs bwrap plus user namespaces, which Docker doesn't provide, hence `danger-full-access` inside the container.
- **Claude Code.**
  - `--input-format stream-json` requires `-p`, `--output-format stream-json` and `--verbose`.
  - Control protocol: `control_request can_use_tool` / `control_response`. Closing stdin cancels pending prompts.
  - An MCP `--permission-prompt-tool` hits the 60 s HTTP timeout and can't approve interaction-required tools, so use `stdio`.
  - Auth precedence: `ANTHROPIC_AUTH_TOKEN` > `ANTHROPIC_API_KEY` > … > /login. A login combined with a custom base URL sends the OAuth credential to that URL.
  - `CLAUDE_CONFIG_DIR` holds `.credentials.json` and `.claude.json`. `claude auth login` reads the pasted code from stdin. `claude auth status` outputs JSON.
  - Managed settings path: `/etc/claude-code/managed-settings.json`.
- **Docker, gVisor, pg.**
  - dockerode `exec.start({hijack, stdin})` + `demuxStream` forwards no end/error; there is no exec-kill API.
  - Internal networks allow peer and host-gateway traffic, hence per-user networks and the firewall rule.
  - gVisor breaks embedded DNS (use ExtraHosts). Install runsc via apt.
  - NOTIFY payloads must be under 8000 bytes and are delivered on commit.
  - pg-boss 12: `expireInSeconds` ≤ 24 h, `heartbeatSeconds`, `retryLimit` 0.
  - Next.js `maxDuration` does nothing when self-hosted, so turn proxy buffering off.

## Verification
- **Per phase:** `npm run typecheck && npm run lint && npm test`. The new unit suites named above cover the pure cores: credential choice, approval precedence, ChatGPT middleware and fetch, mappers, tail, spec.
- **Integration** (`DATABASE_URL`): the credential lock, provider round-trips against the extended mock-llm, and ChatGPT auth against `dev/mock-openai-auth`.
- **E2E** (dev stack per README, plus mock-llm and mcp-echo): `connections.spec`, `chatgpt.spec`, MCP import/identity/smart approvals, sandbox workspace approvals, and runtime flows via fake binaries (approve, deny, reload-resume, stop, crash sweep).
- **Docker host** (`npm run test:sandbox`): the isolation suite; real Codex and real Claude Code (BYO mode) against mocks through the gateway; the subscription compliance test.
- **Manual QA once the gates are cleared:** a real ChatGPT Enterprise account (device code, chat with tools, refresh, revoke); a real Claude Team seat in subscription mode.

## Gates and inputs needed later (defaults chosen; none block P0–P2)
- **G1 ChatGPT:**
  - the OpenAI workspace admin enables device-code login;
  - the workspace-id allowlist;
  - personal plans blocked (default);
  - email must match UPN (default on);
  - optional Codex PATs.
- **G3 Anthropic:** written confirmation for subscription and company-key Claude Code. Until then, BYO-key Claude Code ships, and company-key Claude *models* in the portal loop are unaffected.
- **G4 host:** a Linux VM with runsc (apt or the release tarball, registered with `dockerd --add-runtime`; recommended); sizing of roughly 1–4 GB RAM per active sandbox and disk for workspace volumes. For P5 the gate is the isolation suite with `none` networking; the firewall rule and bound web port join the gate in P7, with egress.
- **Other admin settings (defaults chosen):** the egress allowlist (default empty; add npm/PyPI/GitHub or internal mirrors); which groups get sandboxes and runtimes; retention periods; MCP apps adopting the `X-Portal-Identity` HS256 verifier (optional; the static bearer keeps working).

## Top risks → mitigations
1. **The private ChatGPT backend changes, or OpenAI acts on accounts.** Default-off with an acknowledgement; workspace and plan allowlists; an honest originator; a kill switch with upstream revocation; the transport isolated in one module; company and BYO fallbacks.
2. **Claude compliance slips** (base-URL leak, login relay, tool outputs). Mode-exclusive env with hard-fail; proxy 403 plus an alert; uid split with a 0700 volume; deny rules; redaction; DB CHECK and CI guards; confirmation gates; BYO-key mode first.
3. **Container escape or docker.sock abuse.** sandboxd with fixed specs and no DB or keys; cap-drop, read-only rootfs, non-root; gVisor, with runc runs alerted; a rootless dockerd option; Kubernetes later.
4. **Prompt-injection exfiltration.** Per-user internal networks, a default-empty egress allowlist, secrets never in sandboxes, IP-bound short-lived tokens, ask-by-default commands.
5. **Protocol churn** (Codex app-server is experimental; the Claude control protocol is undocumented). Exact pins, generated types, recorded fixtures plus fake binaries, fail-closed handling of unknown requests.
6. **Durable-run correctness.** Full-message replay, boundary tails, LISTEN before SELECT with re-query on reconnect, a heartbeat sweeper, an approval TTL that denies, and the fake-driver e2e suite gating merges.

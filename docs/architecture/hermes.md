# Hermes Agent integration

Opt-in per-user automatic bot profiles are documented in [Automatic Hermes profiles](hermes-profile-provisioning.md).
Hermes profiles and session keys are state organization, **not tenant security boundaries**; managed mode requires
operator-provided whole-process/filesystem isolation per user. The manual integration described below is unchanged.

**Status:** plan agreed 2026-09-30; **H1 built** (see "H1 as built"). Research: NousResearch/hermes-agent at `d9a97ae` (2026-09-29) and
release tag `v2026.9.24`, verified by an adversarial second read of the source; Paperclip at `81a52eb`.

## What we're building

[Hermes Agent](https://github.com/NousResearch/hermes-agent) (Nous Research, MIT) is a self-hosted personal agent: its
own agent loop, tools (terminal, files, web, MCP servers), memory, skills and approvals. Since v0.20.3 (Aug 16 2026) its
desktop app shows **Bots**, and a Bot is just a Hermes **profile** with a title, avatar and description.

The portal connects to a Hermes server and shows its profiles as ordinary portal bots:

- **One connection, two deployments.** "Bring your own backend" and "remote connect" are the same thing: an admin gives
  the portal a Hermes server URL plus a profile name and that profile's API key. The server can run next to the portal
  (a compose service) or anywhere reachable (LAN, VPN, Tailscale).
- **Profiles are bots.** Each profile becomes a portal bot on the existing cards. Hermes owns the persona, memory,
  skills and tools; the portal owns who may use the bot, starters, extra instructions and routines.
- **No new UI.** Hermes tool steps render as the existing tool rows, Hermes approvals use the existing approval card
  (Allow once / Deny), Stop stops the Hermes run, and usage lands in the usage ledger. Admins get one new provider in
  Admin → Apps.
- **Claude is allowed.** Hermes can run on whatever model its profile is configured with, including Claude through an
  API key or through Nous's official
  [Claude Subscription DirectSDK plugin](https://github.com/NousResearch/hermes-plugin-claude-subscription-directsdk),
  which drives the unmodified official Claude Code CLI signed in on the Hermes host (`claude auth login`) and bills the
  subscription's Agent SDK allowance. The portal doesn't block or rewrite any of it. The portal itself still never
  stores or relays Claude credentials: it doesn't need to, because Hermes and the official CLI own that login.

## How a turn works (H1)

Hermes is an agent runtime, not a model: it runs its own tools on its own host and ignores tools passed by a caller
(`/v1/capabilities` reports `tool_execution: "server"`). The portal therefore drives Hermes through its **Runs API**, not
its OpenAI-compatible endpoints, which can't surface approvals or tool steps and derive the session from the first
message when no session header is sent (two users who both type "hi" can land in one session).

H1 plugs Hermes into the existing chat pipeline as a provider (`src/lib/llm/providers/hermes/`) that implements the AI
SDK language-model interface on top of the Runs API. AI SDK v7 already supports tools that the provider runs itself
(`providerExecuted`) and approvals the provider asks for (`tool-approval-request` → the next call receives
`tool-approval-response`); OpenAI's hosted MCP tools use the same path. So no P6 durable-run machinery was needed for
H1; since P6 these turns run on it anyway (see "H1 as built").

1. **Start.** `POST {base}/p/{profile}/v1/runs` with `{input, session_id, instructions}` and headers
   `Authorization: Bearer <API_SERVER_KEY>`, `Idempotency-Key: <portal message id>`,
   `X-Hermes-Session-Key: <HMAC(user, app)>`. Reply `202 {run_id}`.
   - `session_id = portal-<conversationId>` is always sent explicitly (the session-key header alone attaches to the
     latest session bound to that key). Hermes keeps the conversation in its own session store, so the portal sends
     only the new user message, never the whole history.
   - `instructions` carries the portal side of the bot (its instructions and boundaries, who is chatting, the date).
     Hermes layers them on top of its own prompt and SOUL.md; nothing is replaced.
2. **Stream.** `GET /v1/runs/{id}/events` (SSE, `id: <seq>`, JSON `data` with an `event` field, `: keepalive` every
   10 s) is held open for the whole run:

   | Hermes event | Portal stream part |
   |---|---|
   | `message.delta {delta}` | text delta |
   | `message.interim {text, already_streamed}` | text (skipped if already streamed) |
   | `reasoning.available {text}` | reasoning |
   | `tool.started {tool, preview}` | tool call `hermes__<tool>` (provider-executed, input `{preview}`) |
   | `tool.completed {tool, duration, error, preview}` | tool result / tool error, paired FIFO per tool name (events carry no call id) |
   | `subagent.start` / `subagent.complete` | `hermes__delegate_task` call / result (goal, summary, tokens) |
   | `approval.request {command, description, request_id, choices}` | tool call (if none open) + `tool-approval-request`, then the turn pauses |
   | `run.completed {output, usage, runtime}` | finish with usage (input, output, cache read/write tokens) |
   | `run.failed {error}` / `run.cancelled` / `run.interrupted` | error / abort |

3. **Approve.** The approval id encodes `hermes.<run_id>.<request_id>.<tool_call_id>`. The existing card decides;
   the continuation request (already server-trusted and claimed under a row lock) reaches the provider as a
   `tool-approval-response`, which posts `POST /v1/runs/{id}/approval {choice: "once" | "deny", request_id}` and
   re-attaches to the event stream after the last seq. The portal never sends `session` or `always` (Hermes would add
   the command to the profile's allowlist for every user) and never offers "Always allow" for `hermes__*` tools.
   Hermes denies an unanswered approval after `approvals.timeout` (default 300 s); the card says so. If the event
   buffer has expired by the time someone answers (Hermes drops it 300 s after the run was created when nobody is
   attached), the provider polls `GET /v1/runs/{id}` and shows the final output.
4. **Stop.** Stop cancels the portal run (P6), whose abort posts `POST /v1/runs/{id}/stop`.
5. **Delegates and group chats** can't ask a person, so the provider answers Hermes approvals with `deny` itself and
   the run carries on. Routines pause into the Inbox like portal tools (since P6); Hermes still denies once its own
   `approvals.timeout` passes, so answer quickly or raise that limit for routine profiles.

Errors people can act on come back verbatim: `429` (Hermes' `max_concurrent_runs`, default 10, shared by all profiles
on the server) as "Hermes is busy", `401` as a key problem, `404 Unknown or unconfigured profile` as a missing profile.

## H1 as built

- **Code:** `src/lib/llm/providers/hermes/` (`client.ts` Runs API client and URL check, `sse.ts`, `mapper.ts` pure event
  mapping, `runs.ts` parked runs, `model.ts` the language model), `resolveHermes` in `src/lib/llm/resolve.ts`, the
  `hermes` catalog entry, migration `0007_hermes`, the Hermes approval card and labels in `tool-part.tsx`, and the
  bot-builder note. Admin Test checks the URL, `/health`, the Runs API features in `/v1/capabilities` and `/v1/models`.
- **Hermes' stream can't be resumed in the current release.** Measured against v2026.9.24: `/v1/runs/{id}/events` has no
  ids or replay and Hermes drops the stream when its first subscriber disconnects (`main` after the release adds
  sequence ids and `Last-Event-ID`). So when a turn pauses for approval the provider **parks** the open stream (`runs.ts`)
  and the continuation picks it up. **Since P6** every turn runs in the worker, so the stream is parked in the worker
  (kept for the approval limit + 60 s, at most `RUN_HOLD_MAX_MS`; at most `RUN_MAX_HELD` streams per worker) and the
  answer can come from any browser or web instance; with one worker the continuation always lands on it. At the pause
  the provider also saves `{runId, lastEventId, MapperState}` as the portal run's resume state: a continuation on
  another or restarted worker posts the answer, re-attaches with `Last-Event-ID` and keeps exact tool pairing (newer
  Hermes), or polls `GET /v1/runs/{id}` and shows the run's final output (v2026.9.24).
- **The approval rides on the tool's own call.** `useChat` only sends the answer automatically when every tool part of
  the step is settled, so the approval can't be a separate part next to an unfinished tool. The mapper holds each
  `tool.started` for up to 400 ms (Hermes flags a command ~180 ms after starting it); if an `approval.request`
  follows, the call is shown with the command, Hermes' reason and the time limit, otherwise with its preview.
- **Sessions:** `portal-<conversation>-<bot>` (so a Hermes bot in a group chat or delegation keeps its own session);
  memory scope `X-Hermes-Session-Key = portal-<sha256(app, user)>`. Direct chat admission now requires a previous
  approval to be answered or explicitly cancelled with `/stop` before a new message can start. The executor's
  older supersession path remains for runs admitted outside that direct-chat command boundary.
- Hermes repeats its final answer as `reasoning.available`; the mapper drops that duplicate.
- Verified against a real Hermes gateway (v2026.9.24, a profile on dev/mock-llm): `tests/integration/hermes-live.test.ts`
  (text, tool steps, approve, deny, unattended deny, stop reaches Hermes) and `tests/e2e/hermes.spec.ts` (admin setup →
  bot → chat → approval card → deny → stop). Offline, `tests/unit/hermes-provider.test.ts` replays the recorded
  events (`tests/fixtures/hermes/`) through the mapper and a fake Hermes.

## Data model and admin

- `ai_apps.provider = 'hermes'` (migration `0007_hermes`), company credential mode: `base_url` = the Hermes server
  (`https://hermes.internal:8642`), `provider_config = {profile, approvalTimeoutSec, allowedModels}`, `api_key_enc` = that profile's
  `API_SERVER_KEY` (row-bound encryption, never sent to browsers), `model` = the id `/p/<profile>/v1/models` returns.
- **Test** checks `/health`, then the authenticated `/v1/capabilities` (the run, SSE, stop and approval features must be
  present) and `/v1/models`.
- **Create a bot for this profile** (a checkbox on the app form) adds a normal bot pointing at the app, named after the
  profile. In the bot builder, a Hermes bot shows "Tools, memory and persona live in Hermes"; the portal tool, skill and
  delegate settings don't apply and are hidden.
- Hermes apps are never used for background work (titles, memory extraction, drafts, embeddings).
- Usage rows record billing source `hermes` and the provider/model Hermes reports as having served the turn.

## Slash controls (first release)

In a direct Hermes chat, type `/` for controls. `/help`, `/status`, `/usage`, `/new` (`/reset`), `/stop`, `/model`,
`/skills` and `/tools` are handled through the portal's authenticated `/api/chat/commands` endpoint. The Runs API
does not dispatch slash commands. Unsupported commands stay out of inference with an explanation; `//` explicitly
sends literal slash text. `/hermes <command>` names the namespace. Portal skills are not offered with this backend.

Admin → Apps → **Allowed model routes** enables conversation-local requests using an intersection of the admin's
comma-separated aliases and Hermes `/v1/models`. Nothing changes the shared profile's model. `/model default`
clears the request. A request may differ from the effective runtime; `/status` shows the latest reported model, and
`/usage` totals available conversation ledger records, not profile-wide costs or context-window occupancy.

`/new` preserves this conversation and profile memory and opens a different session. Stop unfinished work first.
`/stop` also closes waiting approval cards and retries uncertain cancellation; remote confirmation is required
before another turn or new-session/model command. If Hermes loses the run or the connection is changed, the result
explains the need for operator recovery. The endpoint reauthorizes the user, conversation and effective app/bot on
each request. It never accepts a native run/session id, key, URL or profile from the browser.

Migration `0009_hermes_commands` stores conversation preferences and immutable run bindings in separate linked
tables. This keeps model changes serialized with admission and preserves upstream identity after the run's resume
state is cleared. Existing runs without bindings retain their prior continuation behavior. For details, validation
and the full-native-support roadmap, see [hermes-slash-commands.md](hermes-slash-commands.md).

`/skills` and `/tools` are metadata views only. Native skill invocation, CLI/gateway commands, compression and
profile mutation require additional upstream support or a separate harness. A broken discovery endpoint does not
disable the local controls or normal chat. No real Hermes commands are exercised by the mock command test suite.

## Identity and tenancy

Hermes has no end users: one API key opens a whole profile, including its terminal, and a profile's memory
(MEMORY.md/USER.md), skills and approval allowlist are shared by everyone who uses it.

- **H1: shared profiles.** Everyone the admin lets use the bot reaches the same profile, which acts as a service
  identity. Each portal conversation gets its own Hermes session; the portal never lists or shows other Hermes
  sessions. For bots many people use, the host checklist below applies (throwaway terminal containers, no personal
  credentials in the profile, consider removing the memory toolset).
- **H2: a profile per person** (Hermes' own multi-user pattern): the app maps each portal user to their own profile and
  key, resolved from the signed-in user only; someone without a mapping is told to ask an admin.

## Hermes host checklist

1. Pin a release (calendar tags, `v2026.9.24` at the time of writing); `/health` reports the version.
2. Run one gateway (`hermes gateway run`) with profile multiplexing, so every profile is served at `/p/<profile>/`.
   Check the boot log: multiplexing is skipped (every `/p/` returns 404) when a profile still runs its own gateway or a
   bot credential is duplicated. Don't use the per-profile-port recipe still shown in older docs; a named profile's own
   gateway now refuses to start.
3. Give each profile a random `API_SERVER_KEY` (16+ characters) in its `.env`; clones strip it, so set it after cloning.
   Rotate keys only when no runs are in flight (run ownership is keyed on the key).
4. Hermes speaks plain HTTP on `127.0.0.1:8642`: put it behind TLS or on a private network. The portal refuses plain
   `http` except to private, loopback or compose-internal addresses.
5. `approvals.mode: manual`, so every flagged command reaches the portal's card (the default `smart` lets an LLM decide),
   and an `approvals.timeout` long enough for people to answer.
6. For profiles several people use: `terminal.backend: docker` with `container_persistent: false` (a fresh container per
   session), no personal tokens in `.env`, and only service-level MCP servers.
7. Claude: install the Claude Subscription DirectSDK plugin and run `claude auth login` on the Hermes host (or set an
   Anthropic API key), then pick the model in `hermes model`. Heads-up: a subscription belongs to the person who logged
   in, so a subscription-backed profile shared with many portal users draws on that one person's plan.

## Verified API facts (for the implementer)

| Fact | Source (hermes-agent `d9a97ae`) |
|---|---|
| Routes: `POST /v1/runs`, `GET /v1/runs/{id}`, `GET /v1/runs/{id}/events`, `POST /v1/runs/{id}/approval`, `/steer`, `/stop`; all mirrored under `/p/<profile>/` with that profile's key | `gateway/platforms/api_server_runs.py` 234-240; `api_server.py` 1674-1741 |
| `/v1/runs` body: `input` (string, or list whose last item's `content` is used), `session_id`, `instructions`, `model`, `provider`; `Idempotency-Key` 1-255 visible ASCII | `api_server_runs.py` 620-757 |
| Session precedence: body `session_id` > `previous_response_id` > `X-Hermes-Session-Key` binding > new session per run | `api_server_runs.py` 690-705 |
| SSE: `id: <seq>`, `: open`, `: keepalive` every 10 s, resume with `Last-Event-ID`; 1000-event backlog; buffer swept 300 s after creation when no subscriber | `api_server_runs.py` 118-157, 1064-1154, 1284-1302 |
| Tool events carry `tool` + `preview` only (no call id); `tool.completed` preview ≤ 500 chars, secret-redacted | `api_server_runs.py` 94-114, 315-345 |
| `approval.request` = approval data (command redacted) + `choices` (`once`/`deny`, sometimes `session`/`always`); run status `waiting_for_approval` | `api_server.py` 107-127; `api_server_runs.py` 850-861 |
| Approval body `{choice, request_id, resolve_all}`; `409 approval_not_pending` when already settled | `api_server_runs.py` 1165-1216 |
| Stop replies `{status: "stopping"}`; the run settles as `cancelled` | `api_server_runs.py` 1253-1273 |
| `run.completed` carries `output`, `usage {input_tokens, output_tokens, total_tokens, cache_read_tokens, cache_write_tokens}`, `runtime {provider, model, route_source}`; failed/cancelled runs carry none | `api_server_runs.py` 88-92, 960-986 |
| `429 Too many concurrent runs` (`gateway.api_server.max_concurrent_runs`, default 10) | `api_server.py` 4089-4104 |
| The API server can't list profiles; `/p/<profile>/v1/models` returns the profile's model id; `/v1/capabilities.model` reports the listener's name, not the profile's | `api_server.py` 2502-2541 |
| Profile metadata (display name, bot title, description, avatar, SOUL.md) only via the admin dashboard (`hermes serve`, port 9119), which can also read and write `.env` | `hermes_cli/web_routers/profiles.py` 83-99; `tui_gateway/methods_profiles.py` |
| ACP (`hermes acp`) and `hermes mcp serve` are stdio-only | `acp_adapter/entry.py`; `mcp_serve.py` |

## Phases

- **H1 (now):** the provider above; Admin → Apps "Hermes Agent" with Test and "create a bot"; tool rows, approvals
  (once/deny, expiry), Stop, usage; shared profiles; background and group turns auto-deny approvals. Tested against a
  real Hermes gateway running on the mock LLM, plus a fake Hermes for CI.
- **H2:** a profile per person; an hourly sync that flags missing or changed profiles; after each turn, replace tool
  previews with the real arguments and results from `GET /api/sessions/{id}/messages`; optional read-only import of
  display names, avatars and SOUL.md from the Hermes dashboard (admin-only, over loopback or an SSH tunnel).
- **H3 (after P7):** portal tools offered to Hermes over MCP (the tool bridge), an optional model proxy so Hermes' model
  calls land in the portal ledger per call, and a portal-hosted Hermes container with egress rules. (Moving Hermes
  turns onto durable runs, planned here, shipped with P6.)
- **Later:** Hermes inside each person's own workspace sandbox through ACP and `@ai-sdk/harness-acp` (true per-person
  isolation; needs sandbox networking).

**Known H1 limits:** editing or regenerating a message doesn't rewind Hermes' copy of the conversation; attachments are
sent as text only; live tool rows show Hermes' previews, not full arguments; an approval must be answered within
Hermes' timeout.

## Ideas from Paperclip (backlog)

[Paperclip](https://github.com/paperclipai/paperclip) (MIT, a control plane for teams of agents) ships a `hermes_gateway`
adapter on the same Runs API, which de-risks this plan. It doesn't map profiles to agents, turns Hermes approvals off
and doesn't pass cancellation through; the portal does all three. Worth borrowing later, each small:

- **Budgets:** per user, bot, group or org, from the usage ledger; warn at 80 % in the Inbox, hard-stop a bot's routines.
- **Stricter "Always allow":** bound to the exact arguments, with an expiry or use count, revoked automatically when an
  MCP tool's definition changes (P4 already hashes them).
- **Routine policies:** "skip if already running" / "coalesce", and catching up missed runs with a cap.
- **Status dots on bot cards:** running, waiting for approval, paused, error.
- **P6 shapes:** its runtime-session interface (start turn, steer, interrupt, events, pending requests) and a fake
  harness with a conformance kit.

Not copied: the company/org-chart product model, "full auto" defaults that skip approvals, long-lived agent tokens.

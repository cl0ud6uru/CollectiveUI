# Plan: Hermes slash commands in CollectiveUI

**Status:** research recorded 2026-10-01; bounded first release implemented.
The research, matrix and roadmap below remain the design record; the next section distinguishes the shipped subset.

## First release as built

Full native command support remains a desired follow-up (S4), not a claim about this implementation. The source observations below
describe the research baseline; changed local behavior is documented here and in [hermes.md](hermes.md).

- **Direct app and bot chats:** `/help`, `/status`, `/usage`, `/new` (`/reset`), `/stop`, `/model`, `/skills`, `/tools`.
  `/hermes <command>` is explicit; bare supported names resolve to Hermes controls. `/portal ...`, native commands,
  unknown slash tokens and unexpected arguments produce explanations and retain the draft. `//` sends literal text.
  Paths such as `/tmp/file` and slash references inside prose stay ordinary text. Groups and routine results cannot
  invoke this control endpoint.
- **UI:** keyboard/click completion, model argument completion, metadata/discovery status, and local result cards.
  Command results never enter messages, model prompts, titles or memory extraction. Portal skill suggestions are
  suppressed for Hermes. Failed commands preserve text and uploads; attachments must be removed before a command.
- **Discovery:** fixed authenticated `/v1/capabilities`, `/v1/models`, `/v1/skills`, `/v1/toolsets` reads under the
  authorized profile. Independent failures, 5-second timeouts, 256-KiB response bounds, validated display fields,
  maximum 200 displayed entries, no shared cache and no following advertised URLs. The real skills scanner defect
  remains upstream; failure is explained, while local controls stay usable.
- **Model scope:** admins configure comma-separated `allowedModels` aliases in Admin → Apps. Selection is the
  intersection with current `/v1/models`, never arbitrary provider credentials, base URLs or profile configuration.
  Blank disables changes; `/model default` clears the conversation request without requiring discovery. Model
  changes and new-session commands require idle state. `model` is sent only on the next new Runs request, while an
  approval continuation retains its original snapshot. This is a request; upstream overrides/fallback may win.
  Usage accounting now stores Hermes's reported runtime model, or `unreported`, instead of the configured alias.
  `/status` excludes older ledger rows that cannot prove they recorded a runtime.
- **New/reset:** creates a new portal conversation (therefore a different derived Hermes session), retaining an
  eligible model preference. Old messages, files and profile memory remain. No destructive-reset confirmation is
  needed: no reset/delete endpoint is called. An unfinished reply/approval or unconfirmed stop blocks the operation.
- **Cancellation:** server-authorized `/stop` covers queued/running/waiting replies. Waiting approvals close under
  the run/message locks, and later answers are rejected. It uses the real stop endpoint, not an approval denial.
  An accepted stop is not proof of completion: remote status must be terminal. A failed/uncertain cancellation
  remains pending and blocks further admission, model changes and `/new`; `/stop` retries, `/status` reconciles.
  A profile, URL, app or credential change prevents sending stored upstream ids to a replacement connection.

### Persistence and bounded deviations from the proposal

Migration `0009_hermes_commands` adds two linked tables: `hermes_chat_settings` (conversation preference, target
binding, revision) and `hermes_run_contexts` (immutable admission snapshot, durable upstream run id, pending/confirmed
stop). Ownership and app/bot identity come from authoritative conversation/run rows, so they are not duplicated.
Admission, model updates, new sessions, approval continuation and cancellation share the user's PostgreSQL advisory
run lock. The executor waits for durable upstream-id recording; a failed write stops the newly created upstream run.

There is no generic command-invocation journal in this release. The three mutations have narrow retry semantics:
absolute model selection with optimistic revision checks, `/new` with a stable client-generated destination id, and
retryable cancellation of server-owned run rows. Local read-only results are transient. A generic operation journal
and durable result history remain prerequisites for broader native commands, rather than pretending these narrow
semantics can cover arbitrary shell/plugin operations.

The model picker uses configured route aliases, not `/api/model/options` or arbitrary provider/model pairs. Strict
model pinning, `/steer`, profile editing, native skill expansion, compression and TUI/ACP bridging remain deferred.
Per-user profile provisioning (H2) is still needed for private filesystem/memory isolation; session-scoped commands
do not isolate the contents of a shared Hermes profile. Pre-feature runs lack immutable bindings: their local
approvals can close, but remote cancellation may require operator verification. The small crash window between
upstream acceptance and recording the returned id still requires operator recovery if the worker dies there.

### Implementation verification

`tests/unit/hermes-commands.test.ts` covers parsing, namespace boundaries, connection bindings, bounded discovery,
failure isolation and model request fields. The existing Hermes replay suite also covers durable-id recording
failure and reported-runtime accounting. `tests/integration/hermes-commands.test.ts` uses disposable PostgreSQL and
an injected HTTP mock for authorization, independent users, revisions, admission races, approval continuation and
cancellation, retry/reconciliation, new-session idempotency and connection changes. The existing run suites remain
part of regression coverage.

`tests/e2e/hermes-commands.spec.ts` starts `tests/fixtures/hermes/command-server.mjs` in process and exercises the real
portal/worker against it: keyboard menus, uploads/drafts, discovery failure, literal/raw slash handling, model
requests versus actual runtime, ownership, reset, reload at approval and cancellation. The fixture executes no
tools, shell commands or model requests. It needs the standard isolated dev database/LDAP/mock-LLM/worker stack;
it does not need or use `HERMES_E2E_URL`. Do not replace it with the host-connected Hermes test to validate controls.

Validation on 2026-10-01: 489 unit tests passed across 48 files; the full disposable-DB integration suite passed
92 tests (7 opt-in tests skipped), followed by 50 passing run/command regression tests after the closing-segment
replay fix. The mock Hermes browser scenario and all 3 general chat browser regressions passed. TypeScript,
ESLint, production build and `git diff --check` passed. Desktop/mobile screenshots were inspected. No live Hermes
runtime or real profile was used. Migration was exercised on fresh isolated PostgreSQL 17 databases.

## Recommendation

Add a server-authorized command layer in front of the existing Hermes Runs provider. Keep the current durable-run,
tool-event, approval and usage integration. A command should produce a typed control result, or deliberately start
an agent turn; merely sending `/something` to Hermes does not execute its slash handler.

Ship a focused first release for **direct chats with a Hermes app or bot**:

- `/help`, `/status`, `/usage`, `/model` (inspect), `/new` (alias `/reset`), and `/stop`.
- Capability-gated `/model <selection>` using allowed per-request model/provider settings, plus `/model default`.
  Explain that this requests the model for subsequent turns; show the model Hermes actually used separately.
- Read-only `/skills` and `/tools` when their discovery endpoints work. The pinned upstream skills endpoint needs a
  fix, so a useful core release must remain possible with that entry marked unavailable.
- A searchable slash palette, argument hints, explicit unavailable-command explanations, and a literal-text escape.

Do **not** describe this as complete native Hermes slash support. Native `/<skill>`, context compression, quick
commands, plugin commands and the rest of the CLI require another integration contract. Make the next milestone
a narrow upstream HTTP command/skill interface on the Runs lifecycle. Use the existing TUI JSON-RPC backend as the
alternative if broad native parity becomes the product requirement. It would be a separate harness project, with
its own connection, session, event and approval lifecycle.

## Evidence and version boundary

The investigation used primary sources, with code pinned rather than relying on mutable documentation alone:

| Source | Examined revision | Purpose |
|---|---|---|
| CollectiveUI | [`626e52a4db82cfc52c9002c9115a9410b842cdc5`][C-base] | Current integration and extension points |
| NousResearch/hermes-agent main | [`8eb8f2da0aff55d4640e6eb624ff1fff8a17bfd5`][H-main] | Main resolved on 2026-10-01; commit timestamp `2026-10-01T23:33:52+05:30` |
| Hermes integration's existing release baseline | [`v2026.9.24`, commit `f97608f178d1ffeca59860195ab7da295f7c8e5f`][H-release] | Check compatibility and the skills-discovery finding; not a claim that this is the newest release |
| Official live documentation | [Slash reference][D-slash], [API server][D-api], [programmatic integration][D-programmatic] | Read 2026-10-01; deployment behavior must be checked against its actual revision |

### Verified in CollectiveUI

1. `startRun()` sends `input`, `session_id` and `instructions`; it currently sends no model/provider override or
   command discriminator. `lastUserInput()` forwards the latest user text. There is no Hermes slash dispatcher.
   The provider already supports status, SSE, once/deny approvals and stop. [Client][C-client], [model][C-model].
2. Session IDs are `portal-<conversationId>[-<botId>]`. The memory header is
   `portal-<sha256(appId:userId).slice(0,24)>`. This is a hash, not the HMAC mentioned in the earlier architecture
   walkthrough. It is stable across that person's conversations with the app. [Resolver][C-resolve].
3. The composer offers up to six portal-skill prefix matches only while the whole input is `/[\w-]*`.
   `runTurn()` adds a model instruction for a matching portal skill; it is not a deterministic command execution
   engine. Hermes gets an empty portal tool/skill set. However, target resolution still fetches portal skills for
   bots without checking the effective provider, so the UI can offer a skill that the Hermes toolset will ignore.
   [Composer][C-composer], [turn][C-turn], [toolset][C-toolset], [targets][C-targets].
4. Sending while busy currently means **stop, then send a new turn**. A `/status` or `/help` routed through that path
   would unnecessarily interrupt work. The command decision must happen before the ordinary `send()` path.
   [Chat component][C-chat].
5. Stop cancels queued/running portal runs but deliberately leaves `waiting` approvals answerable. A subsequent
   Hermes turn separately supersedes waiting runs. `/stop` and stop-before-new therefore need a deliberate,
   race-safe waiting-run cancellation path, not just the existing Stop button call. [Stop route][C-stop],
   [run store][C-store], [executor][C-execute].
6. Authenticated chat submission and each worker segment re-resolve access. Approval decisions are merged into
   server-owned state. Hermes resume state includes its run ID, event cursor and mapper state. Reuse these controls;
   command endpoints must not accept an arbitrary upstream run ID, session ID, profile, URL or key. [Chat route][C-route],
   [run types][C-run-types], [existing architecture][C-architecture].

### Verified in Hermes

**Distinct surfaces.** The central registry has 102 canonical definitions, with CLI/messaging flags and aliases.
The CLI and messaging gateway dispatch commands before agent inference. The messaging path also applies its
platform/user policies. Installed skill commands expand skill content before entering an ordinary model turn.
[Registry][H-registry], [messaging dispatch][H-inbound], [access policy][H-access], [skill expansion][H-skills].

**Runs are not that dispatcher.** `_handle_runs()` reads `input` into `user_message`; `_run_agent_sync()` calls
`agent.run_conversation(user_message=run.user_message, ...)`. Neither step runs the CLI/messaging slash resolver.
Thus `/model x`, `/reset` or `/my-skill task` in `input` is ordinary model text. A model might respond to it or run
tools, which is not proof that the requested command executed. [Runs parsing][H-runs-input], [agent entry][H-runs-agent].

**HTTP does offer concrete building blocks.** Routes include capabilities, models/options, skills/toolsets,
session resources, fork/model-lock operations, and run status/steer/approval/stop. They do not include a generic
slash-command catalog or execution endpoint. Per-request model/provider selection is supported on Runs.
[HTTP routes][H-routes], [run routes][H-run-routes], [model request test][H-model-test].

**TUI JSON-RPC is richer but separate.** It has `commands.catalog`, `complete.slash`, `command.resolve`,
`command.dispatch`, `slash.exec`, session operations and bidirectional user requests. Full dispatch combines local
client handlers, a CLI worker and directive handling; `command.dispatch` alone does not cover every built-in.
Its results can request `exec`, `alias`, `plugin`, `send`, `skill` or `prefill` behavior. Some paths execute shell
commands immediately. Dashboard WebSocket authentication is distinct from the Runs profile bearer key.
[TUI flow][H-tui-flow], [catalog/dispatch][H-tui-commands], [wire contracts][H-tui-contracts], [WS auth][H-ws-auth].

**ACP is a third contract.** It advertises nine headless commands: help, model, tools, context, reset, compress,
steer, queue, version. Unknown commands fall through to the model. It is not universal CLI parity and would require
an ACP lifecycle instead of bolting commands onto the current HTTP provider. [ACP commands][H-acp].

### Confirmed upstream discovery defect and other limits

At **both examined commits**, `/v1/skills` calls `_find_all_skills(skip_disabled=False, include_editorial=True)`,
but that function accepts only `skip_disabled`. An isolated execution of the actual handler AST with a scanner
stub preserving the real signature returned the handler's 500 error. Removing only that keyword in the in-memory
control produced 200. No Hermes runtime was imported or profile opened. The upstream endpoint test replaces the
scanner with a permissive mock, so it does not catch this mismatch. [Handler][H-skills-api], [scanner][H-scanner],
[upstream test][H-skills-test], [release handler][H-release-skills], [release scanner][H-release-scanner].

Treat this as a **source-verified defect**, not a claim that a live user's installation was tested. The upstream
repair should reconcile the intended metadata contract and add a real-signature/integration test; blindly dropping
the argument might omit intended editorial metadata. A true capability flag alone is insufficient for discovery.

The skills HTTP result is metadata, not an invocation API, full skill text, complete quick/plugin command catalog,
or proof of the active session's project-local skill set. The scanner filters disabled/platform/environment/app
eligibility and has project/local/external precedence. The TUI catalog explicitly binds session profile and cwd;
the HTTP list has no session argument. Native expansion also preprocesses content and supporting files. Do not
reimplement this from names/descriptions. [Scanner][H-scanner], [TUI catalog][H-tui-commands], [expansion][H-skills].
Skill preprocessing can optionally execute inline shell snippets when enabled; resolving a skill is therefore not
automatically a harmless metadata operation. [Preprocessor][H-preprocess].

Model selection has precedence and fallback rules. The requested pair is not necessarily the runtime pair.
`GET /v1/models` contains the virtual agent/profile identifier and configured route aliases; it is not the full
provider catalog. `/api/model/options` includes unconfigured choices, which must be filtered. The session-model-lock
endpoint exists, but the Runs launch path does not pass the confirmed-lock machinery used by session-chat. Do not
assume posting a lock guarantees subsequent Runs use it. [Model APIs][H-model-api], [runtime selection][H-runtime],
[session lock][H-lock], [Runs launch][H-runs-input].

## Command support matrix

“HTTP equivalent” means a typed operation that CollectiveUI can intentionally implement. It does **not** mean
Hermes interprets the listed text on `/v1/runs`. “First release” entries below are proposals. Unless noted, native
availability follows the CLI/messaging registry, not an API promise. Exact syntax/subcommands vary by version.

| Command or family | Native surface / behavior | Verified HTTP capability | Proposed support |
|---|---|---|---|
| `/help`, `/commands` | Help across native surfaces; `/commands` is messaging-only | Capabilities do not return slash definitions | First release: portal catalog of supported entries; `/commands` may be a local alias. Show origin and availability. |
| `/status` | Native session/runtime summary | Run status; session metadata | First release: authorized portal conversation/run state, last observed runtime, connection state; do not invent native context totals. |
| `/usage`, `/insights` | Native usage/billing views; `/usage reset` can have account effects | Run usage plus existing portal ledger | First release: `/usage` is this chat's recorded usage, labeled as such. No account reset or full native insights. |
| `/new [title]`, `/reset` | New native session; messaging can interrupt first | Explicit new `session_id`; session create exists | First release: create a new portal conversation on the same target, hence a fresh Hermes ID. Preserve old transcript; memory/profile remain. |
| `/stop` | CLI includes background-process cleanup; messaging interrupts | `POST /v1/runs/{id}/stop` controls one owned run | First release: stop this conversation's run, including approval wait. Never map to TUI `process.stop` or a profile-wide kill. |
| `/model` | Show model; native switch is session-scoped with global options | Models/options; run runtime | First release: show requested selection, last actual runtime, and allowed options. Virtual endpoint ID is labeled separately. |
| `/model <selection>`, `/model default` | Native runtime change; `--global` persists broader config | Runs `model` / `provider`; separate session-lock API | First release if enabled by admin: save a conversation preference and send on each new run. No `--global`; default omits overrides. Strict locks need further upstream work. |
| `/steer <text>` (`/s`) | Adds guidance during a live turn | Run `/steer` accepts input and can reject with 409 | Next small release: target the stored active run; acknowledge acceptance without claiming delivery. Keep out of stop-and-send. |
| `/approve`, `/deny` | Messaging command surface; choices may include persistent grants | Run `/approval` with request ID | Keep existing approval cards in first release. Later aliases may open the exact pending card; no command that grants session/always or guesses among requests. |
| `/skills [list]` | CLI hub; messaging review slice is config-gated | `GET /v1/skills`, broken in examined sources | First release discovery only when healthy; error state with retry/admin guidance. Reject install, enable, approval and mutation subcommands. |
| `/<installed-skill>`, `/skill <name>`, stacked skills, bundles | Native expansion before the model; built-in collisions have special handling | No deterministic HTTP expansion/invocation endpoint found | Defer native execution. Optional “ask Hermes to use this skill” can insert an explicit ordinary prompt, labeled as a request, never as successful native invocation. |
| `/tools`, `/toolsets` | CLI inventory/configuration | `GET /v1/toolsets` | First release read-only inventory; do not expose enable/disable just because listing exists. |
| `/title`, `/save`, `/history`, `/copy` | Session/export/display operations; some CLI-only | Session metadata/history; portal already owns chat history | Follow-up portal equivalents with clear scope. Do not export/list the shared profile's unrelated sessions. |
| `/sessions`, `/resume`, `/branch` (`/fork`) | Native session navigation/branching | Session list/read/fork | Later, only portal-owned mappings. A portal visual branch must also fork Hermes state; arbitrary session browsing is not authorized. |
| `/retry`, `/undo`, `/clear` | Repeat/rewind/reset/display semantics | No Runs history-rewind primitive | Defer. Existing edit/regenerate does not rewind Hermes history. Do not advertise these as equivalent until transcript parity is implemented. |
| `/compress` (`/compact`), `/context` (`/ctx`) | Compression and context accounting | No corresponding Runs command operation | Defer to command API or alternate harness. `/usage` is not a context-window report. |
| `/reasoning`, `/fast` | Runtime effort/tier or display controls | Runs `model_options` covers a subset | Later typed allowlisted options. Explicitly separate inference effort, display visibility and paid tier changes. |
| `/queue` (`/q`), `/busy` | Native busy-input/queue policies | No matching Runs queue manager | Later portal durable queue design; do not turn a supposed queue command into immediate inference. |
| `/goal`, `/subgoal`, `/loop`, `/heartbeat`, `/bg`, `/btw`, `/review`, `/moa` | Native automation/background/session orchestration | Individual turns alone do not implement these managers | Defer. Needs durable ownership, cancellation, usage and result-delivery design. |
| `/plan`, `/learn`, `/init`, `/refine` | Built-in prompt/workflow preparation; may write skills/files | Ordinary prompting can request similar work, not native dispatch | Unavailable as native commands in first release. Offer an explicit text rewrite only after the user chooses it. |
| `/memory`, `/skills approve`, `/curator`, `/reload-skills`, `/reload-mcp`, `/personality` | Shared profile state/review/reload controls | No general safe command API | Defer behind profile isolation and per-action policy; listing permission does not authorize mutation. |
| `/cron`, `/suggestions`, `/blueprint`, `/kanban` | Scheduling/collaboration systems | Jobs REST exists separately; not slash dispatch | Out of first-release scope. Portal routines remain a separate feature; no silent schedule creation. |
| `/yolo`, `/approvals`, `/config`, `/reload`, `/login`, `/update`, `/debug`, `/import`, `/export`, `/snapshot`, `/rollback` | Security, account, environment, filesystem or host-state operations | Some admin surfaces exist, not generic profile command access | Unavailable through chat. Explicit administration is a different permission surface. |
| `/topic`, `/sethome`, `/start`, `/pause`, `/restart`, `/platform`, `/handoff`, `/footer`, `/whoami` | Messaging/channel or host identity controls | No appropriate portal-user equivalent | Unavailable, except a future portal-specific identity/help view. Never impersonate a messaging user to reach handlers. |
| `/skin`, `/statusbar`, `/battery`, `/timestamps`, `/indicator`, `/redraw`, `/prompt`, `/paste`, `/image`, `/quit`, other presentation commands | Native terminal/client controls | Not Runs operations | Use normal portal UI; explain unsupported commands. |
| Quick commands and plugin commands | Can expand aliases, invoke code or shell execution | TUI/messaging handlers, not HTTP Runs text | Defer; a name returned by a catalog must never imply authority to execute it. |
| Unknown slash token | Behavior differs: gateway rejects; ACP can send as text | Runs treats it as input | Portal intercepts it and offers help or an explicit “Send as text” choice. No automatic fallback. |

Matrix evidence: [registry][H-registry], [HTTP routes][H-routes], [Runs handlers][H-runs-control],
[TUI commands][H-tui-commands], [ACP commands][H-acp], [skill expansion][H-skills].

## Proposed behavior and contracts

### Parsing, discovery and autocomplete

Introduce one pure parser and a typed command descriptor, shared by the composer preview and server validation.
Parse only a whole leading command token at the start of the submitted text, followed by whitespace or end of input.
Canonicalize command names case-insensitively; preserve argument casing, spacing and newlines. Command arguments
are data, never shell syntax. Do not interpret slash text in attachments, code blocks, quoted paragraphs, tool
results or model output. `/tmp/file` is a path, not the token `/tmp`. `//help` and “Send as text” explicitly opt into
literal `/help`, with a validated literal marker so the server does not immediately reparse it.

The catalog should contain `id`, `name`, `aliases`, `origin`, `description`, argument specification, `effectScope`,
`busyPolicy`, `executionKind`, availability/reason, and capability revision. Server policy computes these fields.
Use execution kinds `portal-control`, `hermes-http`, `agent-request`, and `unavailable`; future native dispatch must
be a separate kind. Return metadata only, with bounded descriptions and no credentials, local paths or raw config.

For Hermes targets, short `/model` and `/new` names select this catalog. Reserve explicit `/hermes <command>` and
`/portal <skill>` namespaces in the parser. Portal skills are unavailable on a Hermes target until the tool bridge
exists; remove their current misleading suggestions. Keep existing portal-skill behavior for other providers.
Native Hermes skills, when supported later, use `/hermes skill <exact-name>` as the unambiguous path; short aliases
are offered only when they do not collide with supported controls or upstream reserved names. Never let a newly
installed skill shadow `/stop`, `/model`, `/help`, or their aliases. Collisions remain visible with an explanation.

The palette opens on `/`, filters on name/description, groups controls and skills, and supports Up/Down, Tab,
Enter-to-select and Escape, with accessible listbox semantics. Selection inserts syntax and an argument hint;
execution requires submission. Input with arguments still shows usage/validation. Preserve drafts and uploads on
validation/error/confirmation. Control commands with attachments are rejected with a useful explanation; they must
not silently discard files. New-chat drafts can show help/catalog without creating an empty conversation.

Discovery is server-side through the selected profile prefix. Cache by effective app/connection revision, resolved
profile and authorized user/policy scope, not by command name alone. Use a short TTL (proposed 60 seconds), bounded
timeouts, and a refresh action. Invalidate on profile/config/access changes. Capabilities are a hint; a 404, 500,
invalid schema or stale revision disables only the affected optional entry. A 401/403 is an authentication problem,
not “no skills installed.” Do not fetch arbitrary URLs advertised by an upstream capability response; map known
capabilities to fixed client routes. A catalog GET never runs commands or probes by making model calls.

### Command submission and results

Propose `GET /api/chat/commands` for the authorized catalog and `POST /api/chat/commands` for typed invocation.
Accept a portal conversation ID or an authorized draft target, `commandId`, structured arguments, a client
idempotency key, catalog/context revision and an optional expected **portal** run ID. Confirmations bind the same
tuple and expire. Clients never supply an upstream run/session/profile or execution kind.

The server resolves the target and parses/validates again. It checks the same provider-aware slash boundary in
ordinary `/api/chat` submission, so manually typing commands or calling that route cannot bypass command policy.
Worker/routine input must not acquire control-command authority from text: outside direct interactive submission,
reject an apparent unsupported command or treat explicitly marked content as ordinary model input according to
that caller's contract. Model-generated text can never invoke a command endpoint.

Use a result union such as `display`, `navigate`, `confirmation-required`, `accepted`, `unavailable`, `conflict`,
and `error`, with invocation ID and bounded structured payload. Show control results in a dedicated result card,
not a fabricated assistant answer. Local help need not be persisted. Persist mutations and asynchronous outcomes
so reload/retry can recover their status. Control results must stay out of the transcript passed to the model,
branch-history alternation, summarization and automatic title generation. Agent requests, if explicitly chosen,
remain normal user/assistant turns with existing tool and approval rendering.

`accepted` is not `completed`: `/stop` can be stopping, and future `/steer` can be accepted before delivery.
Keep a recoverable unknown/failed state on transport timeout. Do not retry a non-idempotent operation such as
steering automatically. For model preferences and `/new`, duplicate client submissions return the recorded result.

### Session reset, cancellation and concurrency

- Implement `/new [title]` and `/reset` as the **same new-chat operation**, not a DELETE or an erase of the existing
  Hermes transcript. A new portal ID naturally creates a new explicit Hermes session ID on first inference. Start
  with profile defaults; do not inherit a conversation model override silently. Say that profile memory and skills
  remain. There is no need for an in-place reset epoch in the first release.
- If the old conversation is running or waiting for approval, present “Stop current work and start a new chat”
  with the targeted run visible. Idle new-chat needs no destructive confirmation because history is retained.
  A run that changes while the prompt is open must be revalidated, never replaced by “whatever is active now.”
- `/stop` itself is an explicit cancellation request and needs no extra confirmation. Resolve its run from owned
  server state. Cancel queued work, signal running work, and close waiting approvals under existing row/lease
  rules. Reuse/refactor the executor's waiting-run finalization, part closing, notifications and provider cleanup.
  Do not send `deny` and accidentally continue the run as a substitute for stopping it.
- Persist the remote stop request/outcome and reconcile it. Current cleanup is best effort and swallows failures;
  the new control UI must not report “Hermes stopped” solely because the portal row is cancelled. While termination
  is uncertain, show that state and keep retry available. Stop-and-new must not silently claim the prior work ended.
- Serialize model preference writes/new-chat decisions with run admission using a conversation row lock shared by
  both paths. Preserve the existing run-then-message lock order and establish one common acquisition order with
  conversation locks to avoid deadlocks. An idle check alone has a time-of-check/time-of-use race. Cross-tab changes
  require optimistic revision checks. Capture the target and options when a run is admitted; approval continuation
  resumes that same upstream run without reapplying a new selection or executing the original command again.

### Model changes and isolation

For the first release, `/model <selection>` updates a **portal conversation preference**. A selection is an opaque
ID mapped server-side to either an approved route alias or a configured `{provider, model}` pair. Send that mapping
as Runs request fields for subsequent turns. `/model default` removes those fields. Do not write Hermes config,
`ai_apps.model`, a shared profile's default, or a gateway `/model` override keyed by the stable memory header.

Admin policy defaults to read-only inspection; enabling model changes requires an explicit allowed selection list.
Filter unconfigured providers and never accept browser-supplied API keys, base URLs or arbitrary `model_options`.
Offer changes only while no run is queued, running or waiting; require the user to settle/stop that work first.
The acknowledgement is “Requested for future turns,” not proof that a model has already served a turn. Do not run a
billable test prompt when the selection changes.

The current runtime can prioritize existing gateway overrides and can fall back. Preserve `run.completed.runtime`
as the actual provider/model in the UI and ledger; show a mismatch visibly. This first-release contract is suitable
for requested model selection, **not strict model pinning**. If strict model choice is required, disable changing
models until upstream Runs accepts/validates a confirmed session lock and consistently reports its application.
Do not switch to session-chat solely for model locks and lose the established approval/run contract.

Session and run ownership stay portal-enforced. Each command must authenticate with `requirePrincipal`, check
conversation ownership, re-resolve the accessible bot/app and enabled provider, and enforce action policy. Use
server-side credentials and existing URL/redirect protections. Upstream run ownership is scoped by credentials;
everyone sharing the same profile key is not automatically a distinct Hermes end user. The pseudonymous memory
header is not an authorization token and does not isolate filesystem, profile memories, credentials or skills.
The existing H2 per-user-profile mapping remains necessary for private writable profiles. Do not present a shared
profile as private because commands are session-scoped. [Run ownership][H-run-auth], [architecture][C-architecture].

Bind persisted session/command state to owner, conversation, effective app/bot and a non-secret connection revision
(including profile and base URL). An app/profile change cannot reuse old run IDs against a different target. A
credential change invalidates discovery/confirmation and may make old-run control unavailable; report that instead
of retargeting. Re-authorize replay/status reads as well as writes. Keep group chats, delegates and routine-triggered
command execution out of the first release; existing normal Hermes runs in those contexts continue separately.

## Proposed implementation map

All names below are proposed additions/edits; none are implemented by this document.

| Files | Change |
|---|---|
| `src/lib/chat/commands/{types,parse,catalog,service}.ts` (new) | Pure grammar, descriptor/result schemas, provider-specific catalog, authorization and dispatch. Keep parsing free of DB/provider imports. |
| `src/app/api/chat/commands/route.ts` (new) | Catalog and typed invocation endpoints; schema validation, principal/target resolution and idempotency. |
| `src/app/api/chat/route.ts` | Guard the raw text route and share conversation/run admission locking. Preserve explicit literal-text handling and approval continuation. |
| `src/lib/chat/targets.ts`, `src/components/chat/types.ts`, new-chat/chat page loaders | Return server-resolved command context, effective Hermes marker and availability; suppress inapplicable portal skills. Do not expose provider secrets/config. |
| `src/components/chat/composer.tsx`, `chat.tsx`, `new-chat.tsx` | Palette and argument help; dispatch commands before busy stop-and-send; retain input until accepted and invalidate catalog on target change. |
| `src/components/chat/command-menu.tsx`, `command-result.tsx` (new) | Accessible selections, unavailable states, confirmation and structured result/status UI. |
| `src/lib/llm/providers/hermes/client.ts` | Typed capabilities/models/options/skills/toolsets calls; bounded validation; optional new-run model/provider fields; later `steerRun`. Reuse profile URL/auth logic. |
| `src/lib/llm/providers/hermes/model.ts`, `src/lib/llm/resolve.ts` | Carry server-owned per-run options; centralize legacy session-ID/memory-key derivation and target binding; preserve actual runtime metadata. |
| `src/lib/llm/catalog.ts`, admin app form | Command policy and allowed model selections in validated Hermes provider config; default off for changes. |
| `src/lib/runs/{store,execute,types,provider-stop}.ts`, existing stop route | Shared admission/cancellation primitives, waiting-run cancellation, immutable provider-target/options snapshot, observable remote cancellation outcome. |
| `src/db/schema.ts`, next generated migration | The small state additions below. Generate/migrate using existing scripts during implementation, not during this planning task. |
| `docs/architecture/hermes.md`, README/admin help | Explain commands actually available, version/capability fallback, reset/memory scope, model request semantics and the optional future native harness. Correct stale facts without rewriting history. |
| `tests/unit/*`, `tests/integration/*`, `tests/e2e/hermes-commands.spec.ts` | Focused coverage below; isolated mock transport for the new E2E suite. |

### Proposed persisted state

Prefer a small `hermes_conversation_state` table over unrelated generic framework work:

- One row per direct portal conversation: conversation FK/PK, owner FK, app ID, nullable bot ID, connection revision,
  profile identity, legacy-derived upstream session ID, nullable requested model selection, revision and timestamps.
- Lazy initialization adopts the existing `portal-...` session exactly; no migration that restarts existing chats.
  A new conversation gets its normal new ID. The stored owner/target fields are checked against authoritative rows,
  not accepted from client payloads. Credentials remain in the app's encrypted storage.
- Add a typed immutable provider-context snapshot to `agent_runs` (or an equally explicit linked row): state revision,
  target revision and requested selection at admission. Keep it separate from the mutable event/approval resume
  state. Existing runs with no snapshot retain legacy behavior; do not infer an override mid-continuation.
- A `chat_command_invocations` table records mutation ID, owner/conversation/target, normalized action, sanitized
  parameters/hash, idempotency key, expected revision/run, status, result/error, new-conversation ID if any, timestamps
  and cancellation-reconciliation data. Unique `(user_id, idempotency_key)`; reuse with a different request is 409.
  No secrets or expanded skill bodies. Retention follows existing chat/audit policy; bounded argument/result sizes.

The immutable snapshot and command journal are needed for reloads, retries and cross-tab/worker races, not for
every `/help` view. Avoid extending model-visible message parts for control-only output. If results later live in
the chat timeline, add an explicitly excluded control-event type and test every history/summary/export consumer.

## Phases and acceptance criteria

| Milestone | Deliverable | Acceptance gate |
|---|---|---|
| S0 — Contract fixtures | Pinned capability/discovery/run fixtures, parser and policy contracts; record upstream skills defect | Raw `/reset` never becomes an implicit model request; absent/broken capabilities have separate states; no live profile calls |
| S1 — Core controls | Accessible catalog/menu, help/status/usage/model inspection, new/reset, cancellation including waiting approvals | Correct direct target; zero inference for control-only actions; new session preserves old history; no orphaned answerable approval after confirmed cancel; remote uncertainty shown |
| S2 — First-release completion | Per-conversation model request preferences and admin allowlist; read-only tools/skills discovery; state journal and admission snapshots | Two users/two chats/two profiles cannot affect one another's preferences or results; overrides reach the next new Runs call; actual runtime shown; broken skills discovery does not block core controls |
| S3 — Small extensions | Steer, optional title/export; design-owned session fork if needed | No stop-and-send for steering; finish/stop races handled; exports and forks address only owned sessions; no broad native-support claim |
| S4 — Native parity decision | Upstream command interface or separately scoped TUI/ACP harness | Explicit capability/version contract, supported-method allowlist, profile/user/session isolation, user-request/approval/event/recovery conformance before enabling dynamic native commands |

First release means S0–S2. S2's skills item may ship unavailable until a compatible upstream build fixes discovery.
Per-conversation model requests can be disabled by policy without disabling the other controls. No upstream change
is needed for core local controls or request-scoped model selection; deterministic native skill/command execution
is an upstream/interface dependency.

### Tests to implement

1. **Parser/catalog units:** aliases and case, underscores/hyphens, empty and invalid args, multiline task arguments,
   `/tmp/file`, quoted/code text, literal escape, unknown command, prefix collisions, reserved controls, malicious
   metadata, unavailable capability, stale catalog and app/profile switching. Keep non-Hermes portal skills working.
2. **Hermes client/model units with injected fetch:** assert exact profile URL, bearer/session headers, default
   omission and allowed model/provider body, no raw control slash in `input`; schema errors, 401/403/404/409/429/500,
   timeouts, response size limits, configured versus unconfigured model choices, and skills advertised-but-broken.
   Preserve existing recorded SSE, old no-replay behavior, new cursor replay, approval once/deny and actual usage.
3. **Authorization/DB integration on disposable Postgres:** foreign user/conversation/run rejected; revoked access,
   disabled target, changed profile/key revision, guessed native session ID and forged approval ID denied; duplicate
   `/new` gives one destination; changed request under same key is 409; fresh conversation retains no old transcript.
   Test both direct app and bot target paths, including previously configured portal skills on a Hermes bot.
4. **Concurrency/lifecycle integration:** race command versus run admission, model change versus queued turn,
   approval versus cancel, finish versus stop, double stop, stop-before-run-ID, cross-worker continuation and worker
   restart. Cancel while `waiting` must settle stored tool parts and reject late approvals. Test remote stop timeout,
   lost acknowledgement, reconciliation and changed target without sending a request to the wrong profile.
5. **Browser tests against a fake Hermes service:** keyboard/touch palette, argument editing, unsupported and literal
   flow, retained uploads/drafts, status/help while streaming without abort, selected-model scope, reset confirmation,
   reload during cancellation/approval, discovery outage and recovery. Verify control results never reach the LLM,
   title generator or memory extraction. Group/routine contexts cannot activate the direct-chat command dispatcher.
6. **Upstream conformance before enabling native commands:** run the actual server against two temporary profile
   homes and a mock LLM, with isolated credentials and temporary filesystem. Verify catalog/handler parity and
   real scanner signatures, disabled skills, project scope, typed results, aliases, refusal of unauthorized exec,
   confirmations and replay. These are future implementation tests, not permission to exercise a production host.

Implementation checks: `npm run typecheck`, `npm run lint`, `npm test`; targeted disposable-DB integration and mock
browser tests for the changed paths. Read the bundled Next.js/AI SDK docs before framework edits, per AGENTS.md and
CLAUDE.md. Do not run the current opt-in `hermes-live` or existing host-connected Hermes E2E tests against a real
profile merely to validate this UI feature.

## Upstream work and alternate transport decision

The smallest useful upstream proposal is a **typed, profile-scoped HTTP command capability** next to Runs:

- A catalog returning canonical names/aliases, argument schemas, applicability, effect scope, busy policy,
  confirmation requirement, supported result kinds and a revision. Include session/cwd-aware skill eligibility,
  stable skill identifiers and disabled/collision reasons. Catalog presence is not execution permission.
- A narrow invoke/resolve operation accepting an owned session and idempotency key, returning a display/control
  result or starting a normal run. Skill expansion happens in Hermes under the same profile/session scope; content
  preprocessing must remain inside its policy and approval boundary. Do not label resolution pure/read-only if it
  can preprocess shell substitutions or execute hooks. Keep the agent run's approvals/events/cancellation intact.
- Explicit capabilities for compress, new/fork/rewind and strict model locks, with session/run locking and owner
  checks. Define accepted versus applied versus completed and replay behavior. HTTP principals must have a real
  command policy; messaging `allow_admin_from` settings cannot be assumed to apply to API-key callers.
- Address the skills signature mismatch and a Runs model-lock conformance test first. Add stable errors for
  unavailable/disabled commands and incompatible revisions. No arbitrary `exec`, generic shell proxy, or dashboard
  config credentials need be exposed to the portal to satisfy the first useful command set.

These endpoint names and schemas are **proposals, not existing Hermes APIs**. Upstream acceptance and timing are
unknown. No issue or PR was filed during this planning work.

If upstream HTTP support is unavailable and native parity is required, prototype TUI JSON-RPC as an independent
provider/harness. Use `commands.catalog`/`complete.slash`, the documented local/worker/dispatch sequence, session
control methods and typed directives. Handle server-to-client approval/clarify/secret requests explicitly, negotiate
client capabilities, and implement event replay/ownership across reconnect and worker restarts. Browser clients
must still call CollectiveUI, never receive dashboard credentials or unrestricted RPC. Test all methods exposed by
the proxy, not just the palette. Avoid controlling one live conversation simultaneously through Runs and TUI;
session IDs, owners, streams and process lifecycles are not interchangeable. ACP is appropriate for a future
isolated per-user sandbox/IDE-style harness, with its smaller advertised command set. [Protocol overview][H-programmatic].

## Research validation and limitations

- Read repository AGENTS.md and CLAUDE.md. No repository `.agents/skills` directory was present; the selected
  workspace `.agents` directory contained no skill files. Existing architecture documents and relevant provider,
  composer, target, authorization, durable-run, schema and test code were inspected.
- Fetched source only into `/tmp/hermes-slash-research`; read official docs and pinned both upstream revisions.
  No Hermes install, runtime import, server start, profile mutation or consequential command was performed.
- AST registry inventory: 102 canonical definitions, 35 CLI-only flags (two gated messaging exceptions),
  nine gateway-only flags, 58 neither flag. This is registry classification, not an assertion every host implements
  every handler. Canonical names are inventoried below so a future catalog need not guess from documentation.
- Isolated actual-handler/signature checks reproduced the skills 500 in both commits; each in-memory control
  returned 200. Harness: `/tmp/hermes-slash-source-check.py` (research scratch, not shipped implementation).
- Ran `npm test -- --project unit tests/unit/hermes-provider.test.ts tests/unit/executor.test.ts tests/unit/run-host.test.ts tests/unit/toolset-lifecycle.test.ts`:
  **4 files, 78 tests passed**. These cover existing fake/recorded Hermes flows and run/toolset lifecycle, not the
  proposed feature. No code was changed to make them pass.
- Validated Markdown reference resolution and the existence/line bounds of every pinned source-file link against
  the corresponding local Git object; checked the documentation diff for whitespace errors.
- Source inspection confirms the transport boundary; it does not prove the version, configuration, installed
  skills, model credentials, gateway overrides or authorization setup of any deployed Hermes host. No deployment
  was probed. Full upstream Python, DB integration and browser suites were not run during this documentation task.
- Planning has no external blocker. Native invocation, working skills discovery at the examined revisions, strict
  model pinning on Runs and private per-user profile provisioning remain the implementation dependencies described
  above. Existing preview-only tool arguments/results, text-only attachments and edit/rewind limits remain relevant.

### Registry inventory at the pinned main

From [CommandDef flags][H-registry]; aliases are omitted here and must be resolved through the registry/catalog.

| Declared surface | Canonical names |
|---|---|
| CLI-only (35) | clear, redraw, history, prompt, handoff, worktree, snapshot, export, import, journey, config, statusbar, battery, timestamps, verbose, focus, skin, indicator, wake, tools, toolsets, skills, pet, hatch, cron, reload, browser, plugins, palette, subscription, platforms, copy, paste, image, quit |
| Gateway-only (9) | start, topic, pause, approve, deny, sethome, commands, restart, platform |
| Neither exclusive flag (58) | new, save, retry, undo, title, branch, compress, rollback, stop, bg, btw, agents, queue, steer, goal, heartbeat, refine, review, loop, plan, moa, subgoal, status, egress, context, whoami, profile, resume, sessions, model, codex-runtime, personality, diff, footer, yolo, approvals, reasoning, fast, voice, busy, memory, bundles, learn, init, suggestions, blueprint, curator, kanban, reload-mcp, reload-skills, help, usage, login, topup, insights, update, version, debug |

`verbose` has the `display.tool_progress_command` gateway gate; `skills` has the `skills.write_approval` gate.
TUI/Desktop availability has additional metadata and client behavior. Commands not individually scheduled above
default to unavailable in the proposed portal catalog; dynamic skill, quick and plugin commands are additional.

## Primary-source links

[C-base]: https://github.com/cl0ud6uru/CollectiveUI/commit/626e52a4db82cfc52c9002c9115a9410b842cdc5
[C-client]: https://github.com/cl0ud6uru/CollectiveUI/blob/626e52a4db82cfc52c9002c9115a9410b842cdc5/src/lib/llm/providers/hermes/client.ts
[C-model]: https://github.com/cl0ud6uru/CollectiveUI/blob/626e52a4db82cfc52c9002c9115a9410b842cdc5/src/lib/llm/providers/hermes/model.ts
[C-resolve]: https://github.com/cl0ud6uru/CollectiveUI/blob/626e52a4db82cfc52c9002c9115a9410b842cdc5/src/lib/llm/resolve.ts#L171-L196
[C-composer]: https://github.com/cl0ud6uru/CollectiveUI/blob/626e52a4db82cfc52c9002c9115a9410b842cdc5/src/components/chat/composer.tsx
[C-turn]: https://github.com/cl0ud6uru/CollectiveUI/blob/626e52a4db82cfc52c9002c9115a9410b842cdc5/src/lib/agent/run.ts#L76-L113
[C-toolset]: https://github.com/cl0ud6uru/CollectiveUI/blob/626e52a4db82cfc52c9002c9115a9410b842cdc5/src/lib/agent/toolset.ts#L88-L97
[C-targets]: https://github.com/cl0ud6uru/CollectiveUI/blob/626e52a4db82cfc52c9002c9115a9410b842cdc5/src/lib/chat/targets.ts#L39-L62
[C-chat]: https://github.com/cl0ud6uru/CollectiveUI/blob/626e52a4db82cfc52c9002c9115a9410b842cdc5/src/components/chat/chat.tsx#L244-L291
[C-stop]: https://github.com/cl0ud6uru/CollectiveUI/blob/626e52a4db82cfc52c9002c9115a9410b842cdc5/src/app/api/chat/%5Bid%5D/stop/route.ts
[C-store]: https://github.com/cl0ud6uru/CollectiveUI/blob/626e52a4db82cfc52c9002c9115a9410b842cdc5/src/lib/runs/store.ts#L208-L258
[C-execute]: https://github.com/cl0ud6uru/CollectiveUI/blob/626e52a4db82cfc52c9002c9115a9410b842cdc5/src/lib/runs/execute.ts#L289-L340
[C-route]: https://github.com/cl0ud6uru/CollectiveUI/blob/626e52a4db82cfc52c9002c9115a9410b842cdc5/src/app/api/chat/route.ts
[C-run-types]: https://github.com/cl0ud6uru/CollectiveUI/blob/626e52a4db82cfc52c9002c9115a9410b842cdc5/src/lib/runs/types.ts
[C-architecture]: https://github.com/cl0ud6uru/CollectiveUI/blob/626e52a4db82cfc52c9002c9115a9410b842cdc5/docs/architecture/hermes.md
[H-main]: https://github.com/NousResearch/hermes-agent/commit/8eb8f2da0aff55d4640e6eb624ff1fff8a17bfd5
[H-release]: https://github.com/NousResearch/hermes-agent/commit/f97608f178d1ffeca59860195ab7da295f7c8e5f
[D-slash]: https://hermes-agent.nousresearch.com/docs/reference/slash-commands
[D-api]: https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server
[D-programmatic]: https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration
[H-registry]: https://github.com/NousResearch/hermes-agent/blob/8eb8f2da0aff55d4640e6eb624ff1fff8a17bfd5/hermes_cli/commands.py#L44-L346
[H-inbound]: https://github.com/NousResearch/hermes-agent/blob/8eb8f2da0aff55d4640e6eb624ff1fff8a17bfd5/gateway/run_inbound.py#L844-L890
[H-access]: https://github.com/NousResearch/hermes-agent/blob/8eb8f2da0aff55d4640e6eb624ff1fff8a17bfd5/gateway/slash_access.py
[H-skills]: https://github.com/NousResearch/hermes-agent/blob/8eb8f2da0aff55d4640e6eb624ff1fff8a17bfd5/agent/skill_commands.py#L220-L575
[H-preprocess]: https://github.com/NousResearch/hermes-agent/blob/8eb8f2da0aff55d4640e6eb624ff1fff8a17bfd5/agent/skill_preprocessing.py#L46-L112
[H-runs-input]: https://github.com/NousResearch/hermes-agent/blob/8eb8f2da0aff55d4640e6eb624ff1fff8a17bfd5/gateway/platforms/api_server_runs.py#L650-L756
[H-runs-agent]: https://github.com/NousResearch/hermes-agent/blob/8eb8f2da0aff55d4640e6eb624ff1fff8a17bfd5/gateway/platforms/api_server_runs.py#L782-L844
[H-routes]: https://github.com/NousResearch/hermes-agent/blob/8eb8f2da0aff55d4640e6eb624ff1fff8a17bfd5/gateway/platforms/api_server.py#L1745-L1789
[H-run-routes]: https://github.com/NousResearch/hermes-agent/blob/8eb8f2da0aff55d4640e6eb624ff1fff8a17bfd5/gateway/platforms/api_server_runs.py#L234-L241
[H-model-test]: https://github.com/NousResearch/hermes-agent/blob/8eb8f2da0aff55d4640e6eb624ff1fff8a17bfd5/tests/gateway/test_api_server_runs.py#L445-L475
[H-tui-flow]: https://github.com/NousResearch/hermes-agent/blob/8eb8f2da0aff55d4640e6eb624ff1fff8a17bfd5/tui_gateway/AGENTS.md#L119-L131
[H-tui-commands]: https://github.com/NousResearch/hermes-agent/blob/8eb8f2da0aff55d4640e6eb624ff1fff8a17bfd5/tui_gateway/methods_tools.py
[H-tui-contracts]: https://github.com/NousResearch/hermes-agent/blob/8eb8f2da0aff55d4640e6eb624ff1fff8a17bfd5/tui_gateway/contracts/tools_commands.py#L244-L294
[H-ws-auth]: https://github.com/NousResearch/hermes-agent/blob/8eb8f2da0aff55d4640e6eb624ff1fff8a17bfd5/hermes_cli/web_server_chat.py#L247-L370
[H-acp]: https://github.com/NousResearch/hermes-agent/blob/8eb8f2da0aff55d4640e6eb624ff1fff8a17bfd5/acp_adapter/commands.py#L44-L137
[H-skills-api]: https://github.com/NousResearch/hermes-agent/blob/8eb8f2da0aff55d4640e6eb624ff1fff8a17bfd5/gateway/platforms/api_server.py#L2951-L2965
[H-scanner]: https://github.com/NousResearch/hermes-agent/blob/8eb8f2da0aff55d4640e6eb624ff1fff8a17bfd5/tools/skills_tool.py#L171-L228
[H-skills-test]: https://github.com/NousResearch/hermes-agent/blob/8eb8f2da0aff55d4640e6eb624ff1fff8a17bfd5/tests/gateway/test_api_server.py#L976-L1000
[H-release-skills]: https://github.com/NousResearch/hermes-agent/blob/f97608f178d1ffeca59860195ab7da295f7c8e5f/gateway/platforms/api_server.py#L2766-L2780
[H-release-scanner]: https://github.com/NousResearch/hermes-agent/blob/f97608f178d1ffeca59860195ab7da295f7c8e5f/tools/skills_tool.py#L184-L190
[H-model-api]: https://github.com/NousResearch/hermes-agent/blob/8eb8f2da0aff55d4640e6eb624ff1fff8a17bfd5/gateway/platforms/api_server.py#L2501-L2535
[H-runtime]: https://github.com/NousResearch/hermes-agent/blob/8eb8f2da0aff55d4640e6eb624ff1fff8a17bfd5/gateway/platforms/api_server.py#L2300-L2448
[H-lock]: https://github.com/NousResearch/hermes-agent/blob/8eb8f2da0aff55d4640e6eb624ff1fff8a17bfd5/gateway/platforms/api_server.py#L3797-L3828
[H-runs-control]: https://github.com/NousResearch/hermes-agent/blob/8eb8f2da0aff55d4640e6eb624ff1fff8a17bfd5/gateway/platforms/api_server_runs.py#L1165-L1278
[H-run-auth]: https://github.com/NousResearch/hermes-agent/blob/8eb8f2da0aff55d4640e6eb624ff1fff8a17bfd5/gateway/platforms/api_server_runs.py#L1023-L1055
[H-programmatic]: https://github.com/NousResearch/hermes-agent/blob/8eb8f2da0aff55d4640e6eb624ff1fff8a17bfd5/website/docs/developer-guide/programmatic-integration.md

# The Architect

The Architect is a built-in, admin-only bot that explains, inspects and troubleshoots this installation. It reads bots, connections, users, health, failure counts, runs, jobs, spending and workspaces. Every write requires approval for that exact call. It can create ordinary private caller bots, edit their basic configuration, change their enabled state, and assign built-in tool groups (including Skills).

This bounded slice of [#147](https://github.com/cl0ud6uru/CollectiveUI/issues/147) excludes Team/service publication, grants, delegators, routines and personal runtimes. Connection metadata and tests, user/group/settings administration and diagnostic bundles are separate follow-up work. Scheduled read-only sweeps and the operator CLI are Phase 4 follow-ups and are not required to complete #147.

## Install

1. Open **Admin → Bots**.
2. In **The Architect**, choose an enabled company model with tool support. It does not need to be public: only admins use The Architect, and admins can use every shared model. Hermes and personal runtimes are not offered.
3. Click **Add The Architect**. The bot opens when it's ready.

The installing admin owns the bot, but every current admin sees it in their bot list. Nobody else can see, open or chat with it, whatever its visibility setting says. Its installation receipt is stored under the `architectBot` setting. Repeating the install returns the same bot and keeps edits and the disabled state. If the bot is deleted, the installer refuses to create a new one until an administrator clears the `architectBot` setting. Disable the bot in Admin → Bots to turn it off.

## What it can read

| Tool | Returns |
| --- | --- |
| `admin_status` | Version, usage over a period, counts of users, bots, models, MCP servers and active runs, and which features are on |
| `admin_health` | Database, background worker, job queues, workspaces, personal and local Hermes, MCP servers and spending accounts. Each check says what it verified; unconfigured or unreachable services are reported as such |
| `admin_list_bots`, `admin_get_bot` | Owners, models, visibility, tool groups and approval modes, delegates, audiences, MCP grants and routines |
| `admin_list_connections` | Models, saved provider connections and MCP servers with status and error-presence flags |
| `admin_list_users` | Users with sign-in source, effective admin status and groups; portal groups and their permissions |
| `admin_recent_errors` | Failed or interrupted runs, failed routine runs, tool error counts, and MCP, spending and Hermes provisioning failure metadata |
| `admin_runs`, `admin_jobs` | Run counts by status, active runs with heartbeats, and job queue counts |
| `admin_spending` | Spending account snapshots and token usage by model or bot |
| `admin_workspaces_status` | Workspace policy, sandboxd setup checks and each person's workspace state |

## Approved bot configuration changes

`admin_create_bot` creates an enabled, private caller bot using an enabled shared tool-capable model. It starts with no tools. `admin_update_bot` changes only its name, label, description, instructions, boundaries or model. `admin_assign_bot_tools` replaces its built-in tool groups and per-group approval modes while preserving existing MCP assignments; MCP grants and custom MCP assignment are managed in Admin. All three require a fresh per-call approval, carry an expected revision for edits, and refuse protected or unsupported bot types. They verify the saved bot and write an actor-attributed audit entry in the same transaction. A stale revision or failed readback/audit rolls back the write.

Use `admin_get_bot` to inspect the current bot and revision before proposing an edit. The tool assignment result uses the displayed group names and approval modes. Every call is checked against the live admin/session, Architect installation, and direct conversation before the transaction writes.

Health checks never change state. MCP servers and spending accounts are reported from their last test or refresh, not probed live. Worker health is inferred from run heartbeats and queued runs.

## Access and audit

- **Admins only, checked on every call.** Each `admin_*` call reloads the caller, session, installation receipt, bot and model from the database and checks that the stored conversation belongs to the actor and is a direct interactive chat. It is refused if the person is no longer an admin or their session changed, if the bot is no longer the installed and enabled Architect, or if the call comes through delegation, a group chat or a routine. Demoting an admin takes effect on their next tool call, even in a chat that is already open.
- **No secrets.** Tools report credentials only as presence (`hasKey`, `hasHeaders`, `hasIdentitySecret`). URLs expose only their origin; user info, path, query and fragment are omitted. Run resume state, worker leases, tool inputs and outputs, and workspace references are never returned. Stored upstream error bodies and workspace diagnostic detail are omitted entirely. A final guard rejects credential-like fields and redacts known token formats in ordinary configuration text. Configuration names and instructions remain admin-authored data; pattern redaction cannot discover arbitrary secrets pasted into prose, so credentials belong only in credential fields.
- **Audited.** Calls, including refused and failed ones, are recorded in **Admin → Activity → Admin audit log** as `<admin> via The Architect`, with the tool name and outcome. Tool inputs/results are not stored in the call audit. A deleted actor or unavailable audit sink may prevent a refusal/failure record; successful reads require the audit to succeed, and writes commit their action audit atomically with the mutation.

## How it works

The Architect is an ordinary native caller bot identified by its `architectBot` receipt; there is no schema change. `botVisibleTo` (`src/lib/authz.ts`) hides the receipt's bot from non-admins and lists it for every admin. Clearing the receipt turns it back into an ordinary private bot without admin tools, so every check fails closed.

The admin tools are not a bot tool group: they are not stored in `bot_tools`, can't be added to another bot, and are unaffected by edits in the bot editor. `buildToolset` (`src/lib/agent/toolset.ts`) offers them only when the bot is the installed Architect and the caller is a current admin in a direct chat. Each tool (`src/lib/agent/tools/admin.ts`) runs through `runArchitectCall` (`tools/admin-guard.ts`), which re-authorizes against the database with the pure `architectCallDenial` policy and writes the audit entry. Results pass through `secretSafe` (`src/lib/admin/secret-safe.ts`).

The read tools are thin wrappers over admin read functions in `src/lib/admin/inventory.ts` and `src/lib/admin/operations.ts`. Bot writes share the bot editor's persistence helpers in `src/lib/bots/persist.ts`; the Architect's narrower `src/lib/admin/bot-config.ts` API owns its validation, CAS, authorization and audit. A future `collective` CLI or admin API can reuse the lower-level helpers without bypassing the Architect-specific gates.

## Approved bot status changes

`admin_set_bot_enabled` accepts a bot ID, the proposed enabled state, and the revision returned by `admin_get_bot`. It always asks for approval, including when a stale “always allow” grant exists; the grant action and approval UI do not offer Always allow for admin tools. Client approval parts can supply a decision, never replace the stored arguments or signature.

The Admin Bots UI and Architect share `changeBotStatus` in `src/lib/admin/bot-status.ts`. It reloads the actor in a transaction, requires the same active admin session, locks the target, compares the approved revision, writes the change, reads back the stored state and writes an audit entry before commit. Architect calls recheck the full dispatch context again inside that transaction. Stale revisions, missing bots and failed read-back/audit roll back. Team bot changes remain in Admin, where their existing access reconciliation runs. A failed or cancelled tool call never returns a success claim; inspect current state before retrying because cancellation or a lost response can occur after commit.

Tests: `tests/unit/architect-admin.test.ts` migrates an isolated embedded PostgreSQL fixture and uses synthetic service responses; it requires neither live credentials nor a database service. It covers admin/non-admin access, session rotation, direct conversation binding, receipt/model changes, all eleven reads, approval tampering, secret/error projections, successful write read-back and transactional rollback when audit/read-back fails. Additional pure tests cover dispatch policy, secret guards, approval policy and audit labels.

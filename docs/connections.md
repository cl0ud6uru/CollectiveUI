# Models, tools and agent setup

[Back to the overview](../README.md) · [Models vs agent backends](features/models-and-agent-backends.md)

## Reusable OpenAI API credentials

In **Admin → Connections → Saved provider credentials**, add a named connection with an API key and optional endpoint, organization and project. Then add or edit an OpenAI model and choose its **Saved provider connection**. Different projects or billing accounts can have separate named connections. Model names, capabilities, sampling and audience groups remain on each model. Only administrators can create, rotate, disable or delete the provider credential; using an accessible model grants no credential-management permission.

The endpoint, organization and project are fixed after creation so a model edit cannot redirect a saved secret or change its billing destination. Create a separate connection to change these. **Replace API key** rotates one encrypted, row-bound secret for all listed dependent models. A blank key field preserves the credential; no key is returned to forms, bot configuration, exports or audit details. Worker encryption-key rewrapping covers these credentials too.

Rotation and disabling apply when a new turn or job resolves its provider (including embeddings and background work). Turns/jobs already in progress may finish with the previous credential. Disabling does not alter any model audience. Deletion is blocked until all dependent models, including disabled ones, have been reassigned or deleted. Changing a published service bot's model to a different saved connection requires an administrator to review and publish that bot again; rotating the same connection does not.

Apply migration **0023_saved_provider_connections** before running the new web and worker code. The schema upgrade preserves all existing credentials and models exactly: it creates no connections and does not group keys by provider name. To migrate, edit an existing OpenAI model and choose **Migrate stored credential to a named connection**. This atomically creates one named connection for that model, re-encrypts its current credential, preserves its endpoint/project/audience and removes the old per-model ciphertext. Retrying the operation reuses its completed result. Migrate models separately, then explicitly select which named connection each model should use. Legacy per-model credentials continue working until migrated; unreadable credentials leave the migration unchanged.

Saved connections currently support OpenAI API models. Personal ChatGPT subscription/OAuth connections and Hermes runtime credentials retain their separate ownership and authentication flows.

## Connecting models and agent backends

Add a model connection in **Admin → Connections → Models**: pick a provider, enter its endpoint and company credentials, select its model/deployment, and use **Test** to check it. Existing `/admin/apps` links and saved connection IDs remain compatible. No database migration is required for this terminology change.

| Provider | What you enter | Notes |
|---|---|---|
| OpenAI-compatible | Base URL (ending in `/v1`), optional API key, model | vLLM (with tool parsing), LiteLLM, Ollama, your own service |
| OpenAI | API key, optional organization/project | Responses API; responses aren't stored at OpenAI unless you switch it on |
| Azure OpenAI | Resource endpoint, API key, deployment name | v1 Responses API; turn on "Reasoning model" for reasoning deployments |
| Anthropic (Claude) | API key (Claude Console), optional base URL | For Claude on Microsoft Foundry use `https://<resource>.services.ai.azure.com/anthropic` |
| Amazon Bedrock | Region, Bedrock API key or IAM access keys, model or inference profile | Claude uses the Anthropic API on Bedrock; other models use Converse |
| Google Vertex AI (Claude) | Project, location, service account key (JSON) | Only the service account's email and private key are stored |

Credentials are encrypted, bound to the app, never sent to browsers and never read from environment variables (leave `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `AWS_*` etc. unset). Claude apps cache the bot's standing instructions (prompt caching) unless you switch it off. Every model call is recorded in the usage ledger (**Admin → Usage** and the CSV export), including delegated bots, titles, memory extraction and embeddings.

To power native bots, a model connection must support **tool calling**. To use semantic memory and knowledge search, set an embedding model on an OpenAI-compatible, OpenAI, Azure or Bedrock app and choose it under **Admin → Bots & tools → Embedding connection**. Background work (titles, memory, drafts) always runs on company credentials.

To give bots access to your own systems, the recommended path is to wrap them as **MCP servers** (Streamable HTTP or SSE) and register them in **Admin → MCP servers**.

### Your MCP servers

1. **Add server** (URL, transport, headers such as `{"Authorization": "Bearer …"}`), or **Import** and paste the `mcpServers` section of a Claude Desktop, Claude Code (`.mcp.json`), Cursor, Windsurf or VS Code config. Remote servers become drafts; stdio servers run a local program and can't be used by a web portal (put them behind an HTTP bridge). `npx mcp-remote <url>` entries are imported as the URL they bridge to. Variables such as `${API_KEY}` are never filled in: set those headers yourself.
2. **Test** lists the server's tools (as the portal itself) and stores them. Review them in the server's dialog, turn off tools bots shouldn't have, and mark any that must always ask first ("Always allow" can't skip those). **Enable** is possible once there is a tool list.
3. Optional: **Send each person's identity** adds a signed 60-second token (`X-Portal-Identity`, HS256) next to the server's own headers, so the server knows who is chatting and can apply its own permissions. The secret is shown once; see [docs/mcp-identity.md](mcp-identity.md) for verifier code.
4. Optional: **Trusted server** lets the bots' default approval, "Ask unless read-only", run tools the server marks read-only without asking. For untrusted servers (the default) every tool asks unless the bot builder chose "Runs automatically".

Bots only ever see accepted tools, and connect to a server only when the model calls one of its tools. The worker re-lists enabled servers every hour (`MCP_REFRESH_CRON`, default `7 * * * *`): if tools, descriptions or annotations changed, the server shows **needs review**, the changed tools are hidden and new tools aren't offered until an admin clicks **Accept changes**. Tool descriptions and results are cleaned of hidden Unicode characters, and results longer than the server's limit (64 KB by default) are cut with a note. Servers can only be reached at their own origin (no redirects), and link-local/metadata addresses and cleartext `http` to public hosts are refused. Servers registered before this existed keep working: their tool list is captured automatically on the worker's next refresh.

In the bot builder, each MCP server can be narrowed to some of its tools, with a per-tool approval.

### People's own ChatGPT plans (Sign in with ChatGPT, unofficial)

API keys are admin-only. The one personal credential people can add is their own ChatGPT plan:

1. **Admin → Settings → Sign in with ChatGPT**: turn it on (you confirm a notice once), choose who may connect (everyone, or groups and named people), optionally restrict ChatGPT workspaces, and decide whether personal plans (Free, Plus, Pro) and routines are allowed.
2. **Admin → Connections → Add model connection → "ChatGPT plan (each person's own)"**: no key to enter; pick a model (**List my plan's models** uses your own connection).
3. People connect under **Settings → Connected accounts** with a one-time code at OpenAI's sign-in page (it says "Codex"; that's the portal). Chats on ChatGPT model connections then run on their own plan and count against its Codex limits. The picker marks these model choices "Your ChatGPT plan · unofficial".

It uses the same sign-in and private backend as Codex CLI, so it may stop working without notice; check it fits your OpenAI agreement. Sign-ins are stored encrypted, refreshed under a lock, never sent to browsers, and revoked on disconnect, on "Disconnect everyone" and when a user is disabled. ChatGPT model connections are never used for background work (titles, memory, drafts, embeddings), and routines can only use them if you allow it. Device-code sign-in must be allowed for Codex in a ChatGPT Business/Enterprise workspace.

Claude subscriptions can't be connected in the portal itself (Anthropic doesn't allow third-party apps to sign in with Claude.ai accounts), but a Hermes profile can run on one: see [Hermes Agent](#hermes-agent-bots-from-your-hermes-profiles) below.

### Hermes Agent (bots from your Hermes profiles)

Hermes is an **agent backend**, available only through bots. In the bot builder, choose **Bot engine → Hermes**, then an **Agent backend connection**; choose **Native · CollectiveUI** and a **Model connection** for the built-in engine. No additional agent runtimes are implemented.

Existing direct Hermes conversations remain readable but cannot start another turn, retry or run commands. Choose or create the intended Hermes bot and start a new bot conversation; the old session and profile are never silently reassigned. New Chat, user/organization defaults and utility models exclude Hermes. If a saved default still points to Hermes or another unavailable connection, choose a model explicitly or update Settings; the portal does not switch billing to another provider. An invalid configured utility model disables background model work until an admin chooses an eligible connection.

[Hermes Agent](https://github.com/NousResearch/hermes-agent) profiles (Hermes' "Bots") can be portal bots. Hermes keeps its own tools, memory, skills and model; the portal shows its tool steps, asks people to approve the commands Hermes flags, and records usage. Design and details: [docs/architecture/hermes.md](architecture/hermes.md).

**Automatic private profiles:** Admin → Managed Hermes can register an operator-isolated runtime for each user and create shared bot definitions that provision a separate user×bot profile on first use. `/new` starts a fresh native session while preserving that profile's memory. This requires whole-process/filesystem isolation per user, supplied credentials, loopback management tunnels and the pinned supported protocol; the portal does not create containers. See [setup, protocol limits and recovery](architecture/hermes-profile-provisioning.md). Existing manual connections below remain supported.

1. **On the Hermes host** (v2026.9.24 or newer): give each profile an API key and turn on the API server in that profile's `.env` (`API_SERVER_ENABLED=true`, `API_SERVER_KEY=<16+ random characters>`), set `approvals.mode: manual` so flagged commands come to the portal, and run one gateway (`hermes gateway run`): it serves every profile at `/p/<profile>/` on port 8642. Keep it on your private network (LAN, VPN, Tailscale) or put it behind TLS; the portal refuses to send a key over plain http outside the private network.
2. **Admin → Connections → Agent backends → Add agent backend**: the server URL, the profile name and that profile's key, then **Test** (it fills in the model id) and **Save**. A bot for the profile appears under **Bots**; share it like any other bot.
3. **Chat.** Hermes' tool steps show as tool rows. Commands Hermes flags show an approval card (Allow once / Deny; Hermes denies it if nobody answers within its `approvals.timeout`). Stop stops the Hermes run.

Type `/` in a Hermes bot chat for `/help`, `/status`, `/usage`, `/new` (or `/reset`), `/stop`, `/model`, `/skills` and `/tools`. `/new` keeps the old history and profile memory; stop unfinished replies or approvals first. Admins can enable conversation-local model requests through **Allowed model routes** in the backend connection settings. `/status` distinguishes the requested model from Hermes's reported runtime. Skills/toolsets are read-only discovery; full native CLI/skill commands remain planned. Unsupported commands are explained without starting a model reply. Use `//` to send a literal leading slash. See the [command plan and implementation notes](architecture/hermes-slash-commands.md).

A profile can run on Claude, including a Claude Pro/Max subscription through Nous' official [Claude Subscription DirectSDK plugin](https://github.com/NousResearch/hermes-plugin-claude-subscription-directsdk): install it on the Hermes host, run `claude auth login` there, and pick the model with `hermes model`. The portal itself never handles the Claude login.

For a **manually connected** Hermes bot, everyone with access shares the configured profile's memory and skills, even though each conversation has its own session. A throwaway terminal alone does not isolate the whole Hermes process or its profile data. Use the managed per-user mode above for separate user memories, with operator-provided whole-process isolation. Hermes bots don't do titles or memory extraction, and the portal's tool, skill and delegate settings don't apply to them. A turn waiting on an approval keeps Hermes' event stream open in the worker, so the answer continues it live from any browser or web instance (with several worker replicas it may continue on another worker: then it re-attaches, which newer Hermes supports, or shows the run's result). Manual Hermes routines pause into the Inbox on a flagged command; managed mode currently supports direct chats only.

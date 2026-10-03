# Backend harness — technical reference

Companion to [backend-harness.md](./backend-harness.md). These facts were checked against primary sources
(vendor source code, npm tarballs, official docs) on 2026-09-24/25 and pin the versions the plan targets.
Re-verify on every version bump — Codex app-server and the Claude Code control protocol are experimental/undocumented.

**ChatGPT direct**
- Endpoints:
  - client_id `app_EMoamEEZ73f0CkXaXp7hrann`, issuer `https://auth.openai.com`;
  - `POST /api/accounts/deviceauth/usercode {client_id}` → `{device_auth_id, user_code, interval}`. `interval` is a **string**; 404 means device login is not enabled;
  - `POST /api/accounts/deviceauth/token {device_auth_id, user_code}`: 403/404 = pending; 2xx `{authorization_code, code_challenge, code_verifier}`;
  - `POST /oauth/token`, form `grant_type=authorization_code, code, redirect_uri=https://auth.openai.com/deviceauth/callback, client_id, code_verifier`;
  - verification URL `https://auth.openai.com/codex/device`, 15-minute expiry;
  - revoke `POST /oauth/revoke` JSON `{token, token_type_hint, client_id}`.
  - *Sources: codex-rs login/device_code_auth.rs, auth/manager.rs, auth/revoke.rs; pi openai-codex.ts; hermes auth_codex.py.*
- Refresh behaviour:
  - `grant_type=refresh_token, client_id, refresh_token`; all response fields are optional;
  - refresh tokens are single-use and rotating, and **reuse revokes the whole family**;
  - permanent failures: 401, `invalid_grant`, `refresh_token_expired|reused|invalidated`;
  - proactive refresh within 5 minutes of expiry.
  - *Sources: manager.rs, hermes.*
- Claims live under `https://api.openai.com/auth`: `chatgpt_account_id`, `chatgpt_plan_type`, `chatgpt_user_id`, `chatgpt_account_is_fedramp`, `chatgpt_data_residency`. Workspace plans are team, business, enterprise and edu variants. *Source: token_data.rs, protocol/auth.rs.*
- Inference:
  - `POST https://chatgpt.com/backend-api/codex/responses`, SSE;
  - `Authorization: Bearer`, `ChatGPT-Account-ID`;
  - optional headers `x-openai-internal-codex-residency`, `X-OpenAI-Fedramp`, `session-id`, `x-client-request-id`, `originator`;
  - `x-codex-turn-state` is replayed within a turn only;
  - `store:false` is required;
  - streaming only;
  - no `max_output_tokens`;
  - string role content is rejected (use typed parts);
  - strip item ids with store:false;
  - encrypted reasoning is sealed to its issuer and model;
  - models at `GET /backend-api/codex/models?client_version=`;
  - usage at `GET /backend-api/wham/usage`;
  - 429 `{error:{type:'usage_limit_reached', resets_at}}` / `usage_not_included`.
  - *Sources: codex-rs model-provider-info, client.rs, api_bridge.rs, rate_limits.rs; hermes codex_responses_adapter.py.*
- PAT: `at-` tokens validated via `GET https://auth.openai.com/api/accounts/v1/user-auth-credential/whoami`. *Source: personal_access_token.rs.*

**AI SDK v7**
- `createOpenAI({baseURL, apiKey (required), fetch, name}).responses(id)` posts to `${baseURL}/responses`. The providerOptions key stays `openai` unless the name contains "azure".
- Native options: `instructions`, `store`, `include`, `systemMessageMode`, `forceReasoning`, `promptCacheKey`, `parallelToolCalls`, `reasoningEffort`, `reasoningSummary`. The SDK always forwards `max_output_tokens`. *Source: @ai-sdk/openai 4.0.75.*
- ai@7 turns `instructions` into system prompt messages. LanguageModelV4 middleware provides `transformParams`, `wrapGenerate`, `wrapStream`. *Source: ai convert-to-language-model-prompt.ts; provider v4 middleware.*
- Errors thrown from a custom fetch that are not network errors are not retried; 429/5xx `APICallError`s are retried (default maxRetries 2). *Source: provider-utils handle-fetch-error.ts.*
- Resume:
  - `useChat({resume})` → `GET ${api}/${chatId}/stream` with no body and no Last-Event-ID; 204 means nothing to resume;
  - the client rebuilds the message from scratch and replaces it when `start.messageId` matches;
  - a text-delta without its text-start throws;
  - `prepareReconnectToStreamRequest({id,…}) → {api, headers, credentials}`.
  - *Source: http-chat-transport.ts, chat.ts, process-ui-message-stream.ts.*
- `addToolApprovalResponse` changes local state only and sends only when not streaming and `sendAutomaticallyWhen` is true. `lastAssistantMessageIsCompleteWithApprovalResponses` requires every tool part in the last step to be terminal or approval-responded. *Source: chat.ts, last-assistant-message-is-complete-with-approval-responses.ts.*
- UIMessageChunk types used: `tool-input-start/available{dynamic, providerExecuted, toolMetadata}`, `tool-approval-request{approvalId, toolCallId, reason, approvalDescriptor}`, `tool-output-available{preliminary}`, `tool-output-denied`, `data-*{transient}`, `start{messageId}`, `finish`, `abort`. *Source: ui-message-chunks.ts.*
- `readUIMessageStream({message, stream})`. `UI_MESSAGE_STREAM_HEADERS` includes `x-accel-buffering: no`. eventsource-parser drops SSE comments. *Source: ai dist, default-chat-transport.ts.*
- `toolCall.toolMetadata` for MCP tools = `McpProviderMetadata {clientName, toolName, annotations}`. `fingerprintTools` hashes only description, input schema and title (**not annotations or outputSchema**). *Source: tool-fingerprint.ts, mcp-client.ts.*
- MCP client:
  - `createMCPClient({transport:{fetch, redirect, initialSessionId, terminateSessionOnClose, onSessionIdChange}, initialInitializeResult, clientName, maxRetries})`;
  - `toolsFromDefinitions(defs)` is synchronous with no fetch, but execute needs a client.
  - *Source: @ai-sdk/mcp 2.0.57 d.ts.*
- `Experimental_SandboxSession` (`run`, `spawn`, read/write file) reaches tools as `experimental_sandbox`. *Source: provider-utils 5.0.47 types/sandbox.ts.*
- Version locks: react 4.0.116 pins ai 7.0.113. Harness is experimental; harness-codex uses `codex exec`, not app-server.

### OpenClaw's Codex harness (for comparison)
Read from OpenClaw at commit 169da002 (2026-09-25), `extensions/codex`; not run. Paths are in that repo.
- **Process:** a lazily started, long-lived `codex app-server --listen stdio://` child, shared by chats with the same start options (agent dir / `CODEX_HOME`, auth profile, auth fingerprint, command); each chat is a Codex thread; idle threads are unsubscribed after 30 min. Binary pinned to @openai/codex 0.155.1 via npm platform packages, minimum 0.149.0 for custom binaries (`src/app-server/version.ts`, `managed-binary.ts`). The child env drops `NODE_PATH`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_*`, `CODEX_API_KEY`, `OPENAI_API_KEY`, `CODEX_ACCESS_TOKEN` (`transport-stdio.ts`).
- **Credentials:** per-agent `CODEX_HOME` plus `-c cli_auth_credentials_store="ephemeral"`; the user's own `~/.codex` only with opt-in `homeScope:"user"`. OpenClaw runs the OAuth itself (Codex public client id, `originator=openclaw`, browser PKCE on localhost:1455 or device code), keeps the refresh token in its own store, and gives Codex only the access token via `account/login/start {type:"chatgptAuthTokens"}`, answering `account/chatgptAuthTokens/refresh` on 401s. Codex's protocol labels `chatgptAuthTokens` "[UNSTABLE] FOR OPENAI INTERNAL USE ONLY - DO NOT USE" (codex `app-server-protocol` account.rs). Managed launches also point `openai_base_url` at a loopback relay that checks each model request by thread/turn/model.
- **Tools and approvals:** OpenClaw tools are experimental dynamic tools (`thread/start.dynamicTools`, executed on `item/tool/call`) in an `openclaw` namespace with deferred loading; configured MCP servers are written into Codex's per-thread `mcp_servers`. Local default is approval `never` + full access ("YOLO"); "Guardian" mode uses on-request approvals, auto-review and workspace-write. Requests without a handler are declined.
- **Events and errors:** `initialize` sends `experimentalApi:true` and opts out of ~40 notifications; Codex owns history, OpenClaw mirrors at most 200 messages / 512 KiB. Usage limits become 429 with the reset time and fail over to the next auth profile.
- **Multi-user:** per-person model accounts exist, but OpenClaw calls them "account-selection convenience inside one trust domain, not isolation"; untrusted tenants need one Gateway container each.
- OpenClaw also keeps its own loop against `chatgpt.com/backend-api/codex/responses` (like the portal's P2); the app-server harness is its default for ChatGPT subscriptions.

**Codex app-server (0.156.1)**
- `codex app-server [--strict-config] [--listen stdio://]` is JSONL without the `jsonrpc` field and is labelled `[experimental]`. `generate-ts --experimental` output is version-specific. `-32001` means overloaded, retry. *Source: cli/main.rs; v0.150 README.*
- `initialize {clientInfo:{name,title,version}}` then the **`initialized`** notification. `clientInfo.name` becomes `originator`. *Source: v1.rs, initialize_processor.rs.*
- Thread lifecycle:
  - `thread/start {model, modelProvider, cwd, approvalPolicy:'untrusted'|'on-request'|'never', sandbox:'read-only'|'workspace-write'|'danger-full-access', developerInstructions, config, serviceName}`;
  - `thread/resume {threadId, excludeTurns}`: overrides are ignored when the thread is loaded;
  - `thread/fork {threadId, lastTurnId}`;
  - `thread/rollback` is removed; `thread/revert` changes history only.
  - *Source: v2/thread.rs, thread_processor.rs, main README.*
- Turns: `turn/start {threadId, input:[text|image|localImage…], clientUserMessageId}`, `turn/steer {expectedTurnId}`, `turn/interrupt {threadId, turnId}`. *Source: v2/turn.rs.*
- Server requests:
  - `item/commandExecution/requestApproval` → `accept|acceptForSession|decline|cancel|amendments`;
  - `item/fileChange/requestApproval`;
  - `item/permissions/requestApproval`;
  - `mcpServer/elicitation/request` (MCP approvals, `_meta.codex_approval_kind='mcp_tool_call'`);
  - `item/tool/requestUserInput`, `item/tool/call`, `account/chatgptAuthTokens/refresh` (internal only);
  - `serverRequest/resolved`.
  - *Source: common.rs, v2/item.rs, v2/mcp.rs.*
- Usage arrives only in `thread/tokenUsage/updated {last, total}`; `turn/completed` has none. *Source: v2/thread.rs, turn.rs.*
- Custom providers:
  - send only `Authorization: Bearer <env_key|auth.command>`, no ChatGPT-Account-ID;
  - `wire_api` must be `responses`;
  - `auth.command` makes Codex fetch `GET {base_url}/models`;
  - a provider not named "OpenAI" loses remote compaction, zstd, websockets and routing headers.
  - *Source: model-provider/auth.rs, lib.rs, manager.rs, client.rs.*
- MCP servers: `url`, `bearer_token_env_var`, `http_headers_helper`, `default_tools_approval_mode` (`auto|prompt|writes|approve`), `tool_timeout_sec`, `required`. `approval_policy='never'` denies MCP calls that need approval. There is no SSE transport. *Source: mcp_types.rs, mcp_tool_call.rs.*
- `/etc/codex/requirements.toml` pins provider, providers, MCP allowlist and login methods. Config layers: /etc → `$CODEX_HOME` → project → runtime. *Source: config loader, config_requirements.rs.*
- The Linux sandbox needs bwrap plus user namespaces. *Source: linux-sandbox README.*

**Claude Code (2.1.282)**
- Legal: the binary must be unmodified; auth methods may not be restricted; the customer may not pay for or intermediate end-user usage (each user brings their own key, subscription or 3P credential); no collecting, storing or intermediating Claude.ai credentials; an end user signing in to the hosted unmodified binary is allowed; naming limits apply. *Source: code.claude.com/docs/en/legal-and-compliance.md.*
- `--input-format stream-json` requires `--output-format stream-json` and `-p`. stream-json output requires `--verbose`. `--include-partial-messages`. *Source: cli-reference; binary strings.*
- Control protocol: `control_request {request_id, request:{subtype:'can_use_tool'|'initialize'|'interrupt'}}` / `control_response {response:{subtype:'success', request_id, response:{behavior…}}}`. Prompts never time out, and `initialize` redelivers pending prompts. Closing stdin cancels pending prompts. *Source: agent-sdk 0.3.282 sdk.mjs; typescript.md.*
- An MCP `--permission-prompt-tool` cannot approve `requiresUserInteraction` tools and suppresses `permission_denied`. HTTP MCP requests default to 60 s (per-server `timeout` overrides). *Source: mcp.md, binary.*
- `--strict-mcp-config` + `--mcp-config`; `managed-mcp.json` makes `--mcp-config` exit. `${VAR}` expands in headers, but credential-named variables read as empty. *Source: mcp.md, managed-mcp.md.*
- Auth precedence: cloud flags > `ANTHROPIC_AUTH_TOKEN` > `ANTHROPIC_API_KEY` > apiKeyHelper > `CLAUDE_CODE_OAUTH_TOKEN` > /login. A claude.ai login with a custom `ANTHROPIC_BASE_URL` and no gateway credential sends the OAuth credential to that gateway. *Source: authentication.md, llm-gateway-protocol.md.*
- Gateway contract: `POST /v1/messages?beta=true`, forward `anthropic-version`/`beta` verbatim, unbuffered SSE with pings (300 s watchdog), `HEAD /api/hello` probe. *Source: llm-gateway-protocol.md.*
- Credentials and config: `CLAUDE_CONFIG_DIR` holds `.credentials.json` and must also hold `.claude.json` (mount + env). `claude auth login` reads the pasted code from stdin. `claude auth status` outputs JSON with exit 0/1. *Source: authentication.md, devcontainer.md, cli-reference.*
- Required hosts: `api.anthropic.com`, `claude.ai`, `claude.com` (browser), `platform.claude.com` (token exchange and refresh). Proxy env in both cases; no SOCKS. *Source: network-config.md.*
- Managed settings: `/etc/claude-code/managed-settings.json`. Keys `requiredMinimum/MaximumVersion`, `allowManagedHooksOnly`, `disableClaudeAiConnectors`, `disableBypassPermissionsMode`. `forceLoginOrgUUID` blocks API-key and auth-token sessions. Server-managed settings outrank the file for Team/Enterprise logins. *Source: managed-settings.md, authentication.md, server-managed-settings.md.*
- Behaviour: `-p` resume does not restore `--permission-mode`; `bypassPermissions` is refused as root; `-p` runs project settings' hooks, env and apiKeyHelper even in untrusted folders. *Source: permission-modes.md, headless.md, permissions.md.*
- Pin with `npm i -g @anthropic-ai/claude-code@X.Y.Z` + `DISABLE_AUTOUPDATER`/`DISABLE_UPDATES`. *Source: devcontainer.md, env-vars.md.*

**Docker, gVisor, egress, pg, Next.js**
- Exec: `exec.start({hijack:true, stdin:true})` + `demuxStream`. demuxStream does not forward end/error and has no backpressure. There is no exec kill or re-attach endpoint, and execs die when the container restarts. `ExecInspect.Pid` is a host PID. *Source: dockerode README, docker-modem 5.0.7, moby swagger, docker exec docs.*
- Internal networks: containers on the same network can talk to each other and can reach the gateway (host) IP. *Source: network_create.md.*
- The default seccomp profile blocks namespace creation. *Source: docker security/seccomp.md.*
- docker-socket-proxy filters by path only. userns-remap can be bypassed with `UsernsMode:'host'`. *Source: tecnativa README; userns-remap.md.*
- gVisor: embedded DNS 127.0.0.11 is unreachable (use IPs or ExtraHosts); file I/O is the most impacted; install via apt (`runsc install` auto-download ends September 2026); use systrap on VMs. *Source: gvisor FAQ, install.md, production.md.*
- Smokescreen: CONNECT allowlist, denies private IPs by default, needs `AllowMissingRole` without mTLS. *Source: smokescreen README/source.*
- Node needs `NODE_USE_ENV_PROXY=1` (22.21+). git and curl honour lowercase proxy variables. *Source: node cli.md, git http.adoc.*
- Postgres NOTIFY: payload under 8000 bytes, delivered on commit, commits serialized cluster-wide. node-pg Clients are not reusable after end. *Source: notify.sgml, async.c, node-postgres docs.*
- pg-boss 12.34: `expireInSeconds` ≤ 24 h, and the handler is raced against it (heartbeats do not extend it); `heartbeatSeconds` ≥ 10; `retryLimit` defaults to 2; `localConcurrency`; `job.signal`; `useListenNotify`. *Source: pg-boss dist types/manager.js.*
- Next.js `maxDuration` is only build-output metadata when self-hosted. Streaming needs proxy buffering off; nginx `proxy_read_timeout` defaults to 60 s. *Source: next docs maxDuration, self-hosting.mdx; nginx source.*



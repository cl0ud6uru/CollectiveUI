# Codex app-server text pilot

Codex is a bot engine. It executes direct text chats through an assigned native app-server; it is not a model-provider connection. The bot editor exposes the engine, funding route, model and reasoning effort. This pilot does not provision or sign in a runtime, and is unavailable until an operator assigns one.

## Configure a bot

Create a new bot, select **Codex · app-server (text pilot)**, and explicitly choose an API-funded or authorized ChatGPT-subscription runtime, model ID and reasoning effort. Save the definition and open a direct chat. Existing native/Hermes bots cannot be converted into this pilot. A shared bot definition uses each caller's separately assigned runtime; there is no bot-owner or company-credential fallback.

The model and effort must appear in the caller's runtime catalog. Standard speed is requested. Direct text chat, streamed responses, durable browser reconnect and Stop are implemented. Native tools, approvals, attachments, groups, routines, delegation and native thread continuation are unavailable. Each turn creates a persistent native thread and reconstructs the selected text conversation branch; it does not resume the prior native thread.

## Runtime installation contract

The deployment must supply a dedicated isolated runtime for each caller. This change does not implement a container/VM provisioner. The native runtime owns its own model credentials and refresh lifecycle. CollectiveUI receives only a transport capability, never the model API key, OAuth access/refresh token or native auth home.

The adapter targets Codex **0.163.0-alpha.2** and rejects other reported versions. Its wire contract follows the official [thread](https://github.com/openai/codex/blob/a6274249d5877030676db098914db686bab7c921/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L62) and [turn](https://github.com/openai/codex/blob/a6274249d5877030676db098914db686bab7c921/codex-rs/app-server-protocol/src/protocol/v2/turn.rs#L167) protocol. The adapter is independently implemented; no upstream implementation is vendored.

`CODEX_RUNTIME_MANIFEST`, unset by default, names an absolute path to a server-only JSON file. The schema is in `src/lib/codex/runtime.ts`:

```json
{
  "version": 1,
  "runtimes": [{
    "id": "runtime-example",
    "ownerId": "collective-user-id",
    "funding": "api",
    "endpoint": "wss://isolated-runtime.example.invalid/app-server",
    "tokenFile": "/run/secrets/codex-runtime-capability",
    "isolationId": "unique-isolated-deployment",
    "credentialBinding": "unique-native-account-revision",
    "cwd": "/workspace",
    "isolated": true,
    "nativeMcpDisabled": true
  }]
}
```

This is a schema example, not a runnable deployment or credential. Only trusted installation code may write this file. Users and bot authors cannot submit endpoints or credentials through the UI. Mount the manifest and capability files read-only, restrict their permissions, and grant the capability only to the assigned app-server. Remote transport requires WSS; numeric loopback WS is permitted for a local authenticated proxy. Redirects are not followed.

IDs, endpoints, isolation IDs and credential-binding revisions must be unique. There can be at most one assigned runtime per caller and funding route. The runtime must have an isolated OS/home/workspace and must contain no other person's credentials, configured MCP servers, apps or plugins. The manifest's isolation fields are operator assertions, not remote attestation; the adapter cannot detect an operator reusing an API key behind two endpoints.

For `funding: "chatgpt_subscription"`, also provide `expectedEmail`, `expectedWorkspaceId` and `subscriptionAuthorization: { "reference": "external-verification-reference", "expiresAt": <UTC epoch milliseconds> }`. The email must match the caller's signed-in email or UPN. A subscription email cannot be assigned to multiple callers. The native effective config must enforce exactly that workspace with `forced_chatgpt_workspace_id` and `forced_login_method: "chatgpt"`. Existing installation personal-ChatGPT audience/workspace/plan policy also applies.

The operator must independently verify ownership, authorization and subscription eligibility before assignment. An account response, catalog entry or authorization-reference string does not itself prove entitlement. The adapter does not use or migrate existing SIWC, personal-provider, or service-account credentials.

## Execution and recovery

The adapter checks reported version, account mode/identity, native config, selected model/effort, user session, bot revision and runtime binding before dispatch. It requests a read-only sandbox without network and disables shell, web, images, plugins and multi-agent features. Unexpected native tool items and server approval requests fail the turn. These feature switches do not constitute OS isolation or guarantee that every native tool is removed: read-only sandboxing and the dedicated deployment remain required boundaries.

A separate durable `codex_runs` row records the caller/runtime binding and thread/turn IDs, with dispatch uncertainty written before `turn/start`. It contains no secrets. Only one nonterminal Codex attempt per caller is admitted. An uncertain dispatch is never replayed automatically. Browser reconnect reads CollectiveUI's event log; provider transport loss ends the reply rather than attempting unsupported stream replay.

The worker and sweeper reconnect only to inspect/interrupt the recorded thread. A startup interrupt acknowledgment is insufficient; recovery also checks terminal turn state. An unconfirmed stop remains visible on the bot profile and blocks new Codex work for that caller. Recovery records survive chat deletion. Do not replace an unreachable runtime or its credential binding before resolving outstanding attempts. Rotating the transport-token file's contents retains the binding; changing the manifest's binding fields does not.

Terminal execution records and native threads are retained in this pilot; automated retention/remote thread cleanup is not implemented. If termination cannot be established, an operator must inspect the original isolated runtime through its approved management process. The UI cannot force-clear an uncertain attempt.

API-funded usage uses `codex_api` / `codex:api`; subscription usage uses `chatgpt_plan` / `codex:chatgpt_subscription`. Reported cumulative token usage is retained, unavailable counts stay null, and neither route is priced as an organization API call. This path makes no auxiliary company-funded title or memory calls.

## Validation limits

`tests/unit/codex-harness.test.ts` exercises the production WebSocket adapter and database transitions with a local synthetic app-server and PGlite applying all migrations. It covers caller separation, funding/account checks, pre-ack/foreign events, cancellation and dispatch races, uncertain-write recovery, refused tools/approvals, and unsupported inputs. The browser fixture checks the funding/model/effort form and narrow layouts.

These tests do not run paid inference or establish live subscription entitlement, production runtime isolation, or proxy compatibility. No runtime is deployed or activated by this change. Actual isolated-runtime/account testing is still required before production use.
